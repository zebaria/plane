/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Lists repositories the workspace's GitHub App install can see.
 * Used by the FE per-project repo-binding picker.
 *
 *   GET /silo/api/github/repos?workspaceSlug=<slug>&installationId=<id>
 *     -> { repos: [{ id, full_name, name, private, default_branch }] }
 *
 * Backed by GitHub `GET /installation/repositories`. Authenticated as
 * the installation, so we only see repos the org admin selected when
 * installing the App.
 */

import type { Request, Response, Router } from "express";
import express from "express";

import { callDjango } from "../django-client";
import { asyncHandler } from "../express-async";
import { callGithub } from "./api";

type GhRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
};

type RepoListResponse = {
  total_count: number;
  repositories: GhRepo[];
};

const PAGE_SIZE = 100;
const MAX_PAGES = 10; // 1000 repos — generous; protects against runaway loops.

const fetchAllRepos = async (installationId: string): Promise<GhRepo[]> => {
  const out: GhRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Pagination is sequential — each call reads the next page from
    // GitHub. Promise.all isn't applicable.
    // eslint-disable-next-line no-await-in-loop
    const r = await callGithub<RepoListResponse>(
      installationId,
      "GET",
      `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`
    );
    if (r.status >= 300) {
      throw new Error(`installation/repositories ${r.status}: ${JSON.stringify(r.data)}`);
    }
    const repos = r.data.repositories ?? [];
    out.push(...repos);
    if (repos.length < PAGE_SIZE) break;
  }
  return out;
};

const verifyInstallBelongsToWorkspace = async (workspaceSlug: string, installationId: string): Promise<boolean> => {
  // Cross-check via Django over the HMAC channel: only return repos
  // to a caller that owns the install. Otherwise any client could
  // probe arbitrary installation_ids and exfiltrate repo lists.
  const r = await callDjango<{ ok: boolean }>("POST", "/api/v1/silo/github/install-belongs/", {
    workspace_slug: workspaceSlug,
    installation_id: installationId,
  });
  if (r.status >= 300) return false;
  return Boolean((r.data as { ok?: boolean })?.ok);
};

export const githubReposRouter = (): Router => {
  const r = express.Router();

  r.get(
    "/api/github/repos",
    asyncHandler(async (req: Request, res: Response) => {
      const workspaceSlug = String(req.query.workspaceSlug ?? "").trim();
      const installationId = String(req.query.installationId ?? "").trim();
      if (!workspaceSlug || !installationId) {
        res.status(400).json({ error: "workspaceSlug and installationId required" });
        return;
      }

      const ok = await verifyInstallBelongsToWorkspace(workspaceSlug, installationId);
      if (!ok) {
        res.status(404).json({ error: "no GitHub install for that workspace+installation" });
        return;
      }

      try {
        const repos = await fetchAllRepos(installationId);
        const out = repos
          .map((repo) => ({
            id: String(repo.id),
            full_name: repo.full_name,
            name: repo.name,
            private: repo.private,
            default_branch: repo.default_branch,
          }))
          .toSorted((a, b) => a.full_name.localeCompare(b.full_name));
        res.json({ repos: out });
      } catch (err) {
        console.error("[silo] github repos list failed:", (err as Error).message);
        res.status(502).json({ error: (err as Error).message });
      }
    })
  );

  return r;
};
