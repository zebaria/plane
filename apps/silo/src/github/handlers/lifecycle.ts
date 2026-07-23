/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Install/repo lifecycle handlers:
 *   - `installation`              (created, deleted, suspend, unsuspend)
 *   - `installation_repositories` (added, removed)
 *   - `repository`                (renamed, archived, deleted, transferred)
 *
 * `installation.created` is a no-op here — the manifest/install
 * callback handles workspace setup. We hook the *destructive* and
 * *config-change* sides so a Plane state stays consistent when the
 * GitHub admin touches the install on github.com.
 */

/* Sequential awaits in this handler are deliberate: each iteration is
 * an ordered, rate-limit-friendly write to GitHub/Django over a small,
 * bounded set. Matches the project convention for webhook handlers. */
/* eslint-disable no-await-in-loop */

import { callDjango } from "../../django-client";
import { callGithub } from "../api";

const PLANE_LABEL = { name: "Plane", color: "5e6ad2", description: "Mirrored to/from a Plane work item" };
const GITHUB_LABEL = { name: "GitHub", color: "1a1a1a", description: "Mirrored to/from a GitHub Issue" };

const ensureRepoLabels = async (installationId: number, fullName: string): Promise<void> => {
  // Idempotent: GitHub returns 422 ("already_exists") if the label
  // is already present. We swallow that — every other error is
  // logged but non-fatal.
  for (const label of [PLANE_LABEL, GITHUB_LABEL]) {
    const r = await callGithub(String(installationId), "POST", `/repos/${fullName}/labels`, label);
    if (r.status === 201 || r.status === 422) continue;
    console.warn(`[silo] label create failed repo=${fullName} label=${label.name} status=${r.status}`);
  }
};

type GhRepoLite = { id: number; full_name: string; name: string; private?: boolean };

type InstallationPayload = {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: { id: number };
  repositories?: GhRepoLite[];
};

type InstallationRepositoriesPayload = {
  action: "added" | "removed";
  installation: { id: number };
  repositories_added?: GhRepoLite[];
  repositories_removed?: GhRepoLite[];
};

type RepositoryPayload = {
  action: "renamed" | "archived" | "unarchived" | "deleted" | "transferred";
  installation?: { id: number };
  repository: GhRepoLite & { changes?: { repository?: { name?: { from?: string } } } };
};

const callLifecycle = async (body: Record<string, unknown>): Promise<void> => {
  const r = await callDjango("POST", "/api/v1/silo/github/install-lifecycle/", body);
  if (r.status >= 300) {
    console.warn(`[silo] install-lifecycle ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

export const handleInstallationEvent = async (payload: InstallationPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  if (!installationId) return;
  if (payload.action === "deleted") {
    await callLifecycle({ action: "uninstalled", installation_id: String(installationId) });
    return;
  }
  if (payload.action === "created") {
    // Manifest/install callback path already persisted the
    // workspace mapping. The webhook arrives ~simultaneously and
    // would no-op there, but it's the right moment to seed the
    // `Plane` and `GitHub` labels on every selected repo so the
    // mirror gates have something to gate on.
    for (const repo of payload.repositories ?? []) {
      await ensureRepoLabels(installationId, repo.full_name);
    }
    return;
  }
  // suspend / unsuspend / new_permissions_accepted — log only for
  // v1. We have no UI surface for "suspended" state today.
  console.log(`[silo] installation.${payload.action} install=${installationId} (no-op)`);
};

export const handleInstallationRepositoriesEvent = async (payload: InstallationRepositoriesPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  if (!installationId) return;
  // Seed the `Plane` / `GitHub` labels on newly added repos. No
  // teardown on remove — labels stay even after the App is removed
  // from the repo, which matches GitHub's own behavior.
  for (const repo of payload.repositories_added ?? []) {
    await ensureRepoLabels(installationId, repo.full_name);
  }
  // We don't track the repo list authoritatively; the Plane FE pulls
  // repos via the installation token on demand. Just refresh the
  // cached `connection_data.repositories` so workspace admins can see
  // what's currently selected without a roundtrip on every render.
  // Send the added/removed deltas separately — Django merges them into
  // the stored list. (Sending a merged add+remove list would make
  // Django clobber the whole selection down to just the delta.)
  await callLifecycle({
    action: "repos_changed",
    installation_id: String(installationId),
    repositories_added: (payload.repositories_added ?? []).map((r) => ({
      id: String(r.id),
      full_name: r.full_name,
    })),
    repositories_removed: (payload.repositories_removed ?? []).map((r) => ({
      id: String(r.id),
      full_name: r.full_name,
    })),
  });
};

export const handleRepositoryEvent = async (payload: RepositoryPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  if (!installationId) {
    // Repository events for repos we don't have an install on — skip.
    return;
  }
  const repo = payload.repository;
  if (payload.action === "renamed") {
    const fromName = repo.changes?.repository?.name?.from;
    // GitHub sends `repository.full_name` post-rename. Reconstruct
    // the previous full_name by replacing the last path segment.
    const oldFullName = fromName ? repo.full_name.replace(/\/[^/]+$/, `/${fromName}`) : undefined;
    await callLifecycle({
      action: "repo_renamed",
      installation_id: String(installationId),
      repo_id: String(repo.id),
      repo_full_name_old: oldFullName,
      repo_full_name_new: repo.full_name,
    });
    return;
  }
  if (payload.action === "archived" || payload.action === "deleted") {
    await callLifecycle({
      action: payload.action === "archived" ? "repo_archived" : "repo_deleted",
      installation_id: String(installationId),
      repo_id: String(repo.id),
    });
    return;
  }
  // unarchived / transferred — log only.
  console.log(`[silo] repository.${payload.action} repo=${repo.full_name} (no-op v1)`);
};
