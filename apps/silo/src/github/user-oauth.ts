/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub per-user OAuth (personal account binding). The GitHub App
 * itself doesn't carry user identity — we register a separate OAuth
 * App per env to learn the GitHub login of the Plane user who's
 * connecting. Same shape as Slack's per-user OAuth: minimum scopes,
 * token discarded after we read identity, only the user_id <-> login
 * mapping is persisted.
 *
 *   GET /silo/api/github/user/auth/url?workspaceSlug=&planeUserId=
 *      -> returns { url } pointing at github.com/login/oauth/authorize
 *   GET /silo/api/github/auth/user/callback?code=&state=
 *      -> exchanges code, calls /user, persists via Django.
 */

import { randomBytes } from "node:crypto";

import axios from "axios";
import type { Request, Response, Router } from "express";
import express from "express";

import { config } from "../config";
import { getGithubConfig, githubGhesAllowedHosts } from "./config";
import { callDjango } from "../django-client";
import { asyncHandler } from "../express-async";
import { apiBaseFor, oauthAccessTokenUrlFor, oauthAuthorizeUrlFor, validateGhesOrigin } from "./host";

const USER_SCOPES = ["read:user", "user:email"];
const STATE_TTL_MS = 10 * 60 * 1000;

// Phase 4g: ghesBaseUrl empty/undefined → cloud github.com. When set,
// the authorize redirect, code exchange, and /user reads all swap to
// the customer's GHES origin (and <host>/api/v3 for the API calls).
type StateEntry = { workspaceSlug: string; planeUserId: string; ghesBaseUrl?: string; createdAt: number };
const stateStore = new Map<string, StateEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of stateStore) {
    if (now - entry.createdAt > STATE_TTL_MS) stateStore.delete(token);
  }
}, STATE_TTL_MS).unref();

const issueState = (workspaceSlug: string, planeUserId: string, ghesBaseUrl?: string): string => {
  const token = randomBytes(24).toString("hex");
  stateStore.set(token, { workspaceSlug, planeUserId, ghesBaseUrl, createdAt: Date.now() });
  return token;
};

const consumeState = (token: string): StateEntry | null => {
  const entry = stateStore.get(token);
  if (!entry) return null;
  stateStore.delete(token);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
};

const userRedirectUrl = (): string => `${config.publicBaseUrl}${config.basePath}/api/github/auth/user/callback`;

const buildAuthorizeUrl = (state: string, ghesBaseUrl?: string): string => {
  const cfg = getGithubConfig();
  const url = new URL(oauthAuthorizeUrlFor(ghesBaseUrl));
  url.searchParams.set("client_id", cfg.oauthClientId);
  url.searchParams.set("scope", USER_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", userRedirectUrl());
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
};

type GhTokenResponse = { access_token?: string; scope?: string; token_type?: string; error?: string };
type GhUser = { id: number; login: string; email: string | null };
type GhEmail = { email: string; primary: boolean; verified: boolean };

const exchangeCode = async (code: string, ghesBaseUrl?: string): Promise<GhTokenResponse> => {
  const cfg = getGithubConfig();
  const r = await axios.post<GhTokenResponse>(
    oauthAccessTokenUrlFor(ghesBaseUrl),
    {
      client_id: cfg.oauthClientId,
      client_secret: cfg.oauthClientSecret,
      code,
      redirect_uri: userRedirectUrl(),
    },
    { headers: { Accept: "application/json" }, validateStatus: () => true }
  );
  return r.data;
};

const fetchUser = async (token: string, ghesBaseUrl?: string): Promise<GhUser> => {
  const r = await axios.get<GhUser>(`${apiBaseFor(ghesBaseUrl)}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    validateStatus: () => true,
  });
  if (r.status >= 300) throw new Error(`gh /user ${r.status}`);
  return r.data;
};

const fetchPrimaryEmail = async (token: string, ghesBaseUrl?: string): Promise<string> => {
  // /user.email is null for users who hide their email; fall back to
  // the verified primary from /user/emails (requires user:email scope).
  const r = await axios.get<GhEmail[]>(`${apiBaseFor(ghesBaseUrl)}/user/emails`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    validateStatus: () => true,
  });
  if (r.status >= 300) return "";
  const primary = r.data.find((e) => e.primary && e.verified);
  return primary?.email ?? "";
};

const persist = async (
  workspaceSlug: string,
  planeUserId: string,
  ghUserId: string,
  ghLogin: string,
  ghEmail: string
): Promise<void> => {
  const r = await callDjango("POST", "/api/v1/silo/github/user-connect/", {
    workspace_slug: workspaceSlug,
    plane_user_id: planeUserId,
    github_user_id: ghUserId,
    github_login: ghLogin,
    github_email: ghEmail,
  });
  if (r.status >= 300) throw new Error(`django ${r.status}: ${JSON.stringify(r.data)}`);
};

export const githubUserOAuthRouter = (): Router => {
  const r = express.Router();

  r.get("/api/github/user/auth/url", (req: Request, res: Response) => {
    const workspaceSlug = String(req.query.workspaceSlug ?? "").trim();
    const planeUserId = String(req.query.planeUserId ?? "").trim();
    if (!workspaceSlug || !planeUserId) {
      res.status(400).json({ error: "workspaceSlug and planeUserId required" });
      return;
    }
    // GHES origin (e.g. "https://ghe.acme.com"). Empty/absent → cloud.
    // SSRF-guarded: this origin later receives the OAuth code exchange
    // and /user reads, so it must be on the operator allowlist.
    const ghesCheck = validateGhesOrigin(req.query.ghesBaseUrl as string | undefined, githubGhesAllowedHosts);
    if (!ghesCheck.ok) {
      res.status(400).json({ error: ghesCheck.error });
      return;
    }
    const ghesBaseUrl = ghesCheck.origin;
    const cfg = getGithubConfig();
    if (!cfg.oauthClientId) {
      res.status(503).json({ error: "github oauth app not configured (missing /<env>/plane-github-oauth)" });
      return;
    }
    const state = issueState(workspaceSlug, planeUserId, ghesBaseUrl);
    res.json({ url: buildAuthorizeUrl(state, ghesBaseUrl) });
  });

  r.get(
    "/api/github/auth/user/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const code = String(req.query.code ?? "");
      const state = String(req.query.state ?? "");
      const ghError = req.query.error as string | undefined;

      const feBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";
      const okUrl = (slug: string) => `${feBase}/${slug}/settings/account?github_user=connected`;
      const errUrl = (slug: string, msg: string) =>
        `${feBase}/${slug}/settings/account?github_user=error&reason=${encodeURIComponent(msg)}`;

      const entry = consumeState(state);
      if (!entry) {
        res.status(400).send("Invalid or expired state");
        return;
      }
      if (ghError) {
        res.redirect(errUrl(entry.workspaceSlug, ghError));
        return;
      }
      if (!code) {
        res.redirect(errUrl(entry.workspaceSlug, "no_code"));
        return;
      }

      const tok = await exchangeCode(code, entry.ghesBaseUrl);
      if (!tok.access_token) {
        res.redirect(errUrl(entry.workspaceSlug, tok.error ?? "exchange_failed"));
        return;
      }
      try {
        const user = await fetchUser(tok.access_token, entry.ghesBaseUrl);
        const email = user.email ?? (await fetchPrimaryEmail(tok.access_token, entry.ghesBaseUrl));
        await persist(entry.workspaceSlug, entry.planeUserId, String(user.id), user.login, email);
      } catch (err) {
        res.redirect(errUrl(entry.workspaceSlug, `persist_failed:${(err as Error).message}`));
        return;
      }
      res.redirect(okUrl(entry.workspaceSlug));
    })
  );

  return r;
};
