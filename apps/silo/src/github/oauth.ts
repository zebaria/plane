/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub workspace install — manifest bootstrap + App installation
 * OAuth flow.
 *
 *   GET  /silo/api/github/manifest?env=local|dev|prod
 *        -> renders a self-posting form to GitHub's manifest endpoint
 *           for the zebaria org. Uses the env-specific manifest JSON
 *           baked in at build time.
 *   POST /silo/api/github/manifest/callback?code=...
 *        -> exchanges the manifest code for App credentials, writes
 *           /<env>/plane-github in Secrets Manager. One-shot.
 *
 *   GET  /silo/api/github/team/auth/url?workspaceSlug=&userId=
 *        -> returns the App's installation URL with a CSRF state.
 *   GET  /silo/api/github/team/auth/callback?installation_id=&state=
 *        -> validates state, fetches installation metadata, posts
 *           to Django HMAC install endpoint.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Request, Response, Router } from "express";
import express from "express";

import { config, getGithubConfig, isGithubConfigured, setGithubConfig } from "../config";
import { callDjango } from "../django-client";
import { asyncHandler } from "../express-async";
import { loadGithubOAuthSecrets, writeGithubAppSecrets } from "../secrets";
import { callGithubAsApp, convertManifest, newCsrfState } from "./api";
import { installNewUrlFor, manifestUrlFor, validateGhesOrigin, webBaseFor } from "./host";

const STATE_TTL_MS = 10 * 60 * 1000;

type StateEntry = {
  workspaceSlug: string;
  userId: string;
  // Phase 4g: empty/undefined → cloud github.com. When set, every
  // GH call for this install (manifest convert, installation token,
  // repo CRUD) swaps to <ghesBaseUrl>/api/v3.
  ghesBaseUrl?: string;
  createdAt: number;
};
const installStateStore = new Map<string, StateEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of installStateStore) {
    if (now - entry.createdAt > STATE_TTL_MS) installStateStore.delete(token);
  }
}, STATE_TTL_MS).unref();

const issueInstallState = (workspaceSlug: string, userId: string, ghesBaseUrl?: string): string => {
  const token = newCsrfState();
  installStateStore.set(token, { workspaceSlug, userId, ghesBaseUrl, createdAt: Date.now() });
  return token;
};

const consumeInstallState = (token: string): StateEntry | null => {
  const entry = installStateStore.get(token);
  if (!entry) return null;
  installStateStore.delete(token);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
};

const loadManifest = (env: string): Record<string, unknown> => {
  // Manifests live next to the silo source. tsdown copies them into
  // dist/ at build time; in dev we resolve relative to cwd of the
  // running process (apps/silo).
  const file = join(process.cwd(), `github-app-manifest-${env}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
};

// Encode (env, ghesHost) into the manifest state. GitHub round-trips
// it unchanged in the redirect, so we read it back in the callback.
// Exported for unit testing the round-trip.
export const encodeManifestState = (env: string, ghesHost?: string): string =>
  ghesHost ? `${env}|${encodeURIComponent(ghesHost)}` : env;

export const decodeManifestState = (raw: string): { env: string; ghesBaseUrl?: string } => {
  const [env, encHost] = raw.split("|", 2);
  return { env, ghesBaseUrl: encHost ? decodeURIComponent(encHost) : undefined };
};

const renderManifestForm = (env: string, org: string, ghesHost?: string): string => {
  const manifest = loadManifest(env);
  const target = manifestUrlFor(org, ghesHost);
  const stateValue = encodeManifestState(env, ghesHost);
  const where = ghesHost ? ` (GHES at ${ghesHost})` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plane GitHub App bootstrap (${env}${where})</title></head>
<body>
<h1>Create GitHub App for env=${env}${where}</h1>
<p>Click the button to register a new GitHub App against the
<code>${org}</code> org. After GitHub creates it you'll be redirected
back to silo, which will store the App credentials in AWS Secrets
Manager at <code>/${env}/plane-github</code>. Then click
<strong>Install App</strong> on the new App's page to install it
into the org and pick repos.</p>
<form method="post" action="${target}?state=${encodeURIComponent(stateValue)}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
  <button type="submit">Create GitHub App for ${env}${where}</button>
</form>
</body></html>`;
};

export const githubOAuthRouter = (): Router => {
  const r = express.Router();

  r.get("/api/github/manifest", (req: Request, res: Response) => {
    const env = String(req.query.env ?? "").trim();
    if (!["local", "dev", "prod"].includes(env)) {
      res.status(400).type("text/plain").send("env must be one of: local, dev, prod");
      return;
    }
    // GHES bootstrap: pass `?ghes_host=https://ghe.acme.com&org=acme`.
    // Cloud install defaults to the zebaria org. The GHES origin is
    // SSRF-guarded against the operator allowlist before it can drive
    // any server-side URL (the manifest target's CSP form-action would
    // otherwise be attacker-controlled).
    const ghesCheck = validateGhesOrigin(req.query.ghes_host as string | undefined, config.githubGhesAllowedHosts);
    if (!ghesCheck.ok) {
      res.status(400).type("text/plain").send(ghesCheck.error);
      return;
    }
    const ghesHost = ghesCheck.origin;
    const org = String(req.query.org ?? "").trim() || "zebaria";
    const formAction = webBaseFor(ghesHost);
    res.setHeader("Content-Security-Policy", `default-src 'self'; form-action ${formAction}`);
    res.type("html").send(renderManifestForm(env, org, ghesHost));
  });

  r.get(
    "/api/github/manifest/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const code = String(req.query.code ?? "").trim();
      // GitHub returns our `state` parameter unchanged — we use it to
      // identify which env we're bootstrapping (set in the form action
      // above) and, for GHES, where to swap api.github.com.
      const rawState = String(req.query.state ?? "").trim();
      const { env, ghesBaseUrl } = decodeManifestState(rawState);
      if (!code || !["local", "dev", "prod"].includes(env)) {
        res.status(400).type("text/plain").send("missing code or invalid state");
        return;
      }
      // `state` round-trips through GitHub but is ultimately
      // caller-influenced, so re-validate the GHES origin here too —
      // convertManifest would otherwise POST the OAuth code to it.
      const ghesCheck = validateGhesOrigin(ghesBaseUrl, config.githubGhesAllowedHosts);
      if (!ghesCheck.ok) {
        res.status(400).type("text/plain").send(ghesCheck.error);
        return;
      }
      // Refuse to overwrite an existing install — re-running the
      // manifest flow against a connected env would replace working
      // credentials with new ones (and orphan the old App on GitHub
      // because we'd lose its private key).
      if (env === config.env && isGithubConfigured()) {
        res
          .status(409)
          .type("text/plain")
          .send(
            "GitHub App already configured for this env. Delete /<env>/plane-github in Secrets Manager first if you really want to re-bootstrap."
          );
        return;
      }
      const conv = await convertManifest(code, ghesCheck.origin);
      const secrets = {
        app_id: String(conv.id),
        app_slug: conv.slug,
        client_id: conv.client_id,
        client_secret: conv.client_secret,
        webhook_secret: conv.webhook_secret,
        private_key: conv.pem,
      };
      try {
        await writeGithubAppSecrets(env, secrets);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "ResourceExistsException") {
          res.status(409).type("text/plain").send(`Secret /${env}/plane-github already exists. Refusing to overwrite.`);
          return;
        }
        throw err;
      }
      // Hot-load the new config if it's the current env, so the next
      // /team/auth/url call works without a restart.
      if (env === config.env) {
        const oauth = await loadGithubOAuthSecrets(config.env);
        setGithubConfig({
          appId: secrets.app_id,
          appSlug: secrets.app_slug ?? "",
          clientId: secrets.client_id,
          clientSecret: secrets.client_secret,
          webhookSecret: secrets.webhook_secret,
          privateKey: secrets.private_key,
          oauthClientId: oauth?.client_id ?? "",
          oauthClientSecret: oauth?.client_secret ?? "",
        });
      }
      res.type("html").send(
        `<!doctype html><html><body><h1>App created for env=${env}</h1>
<p>Stored in AWS Secrets Manager at <code>/${env}/plane-github</code>.</p>
<p>Next step: visit <a href="${conv.html_url}">${conv.html_url}</a>
and click <strong>Install App</strong> to install it into the
zebaria org and choose repos.</p>
</body></html>`
      );
    })
  );

  r.get("/api/github/team/auth/url", (req: Request, res: Response) => {
    const workspaceSlug = String(req.query.workspaceSlug ?? "").trim();
    const userId = String(req.query.userId ?? "").trim();
    if (!workspaceSlug || !userId) {
      res.status(400).json({ error: "workspaceSlug and userId required" });
      return;
    }
    // GHES origin (e.g. "https://ghe.acme.com"). Empty/absent → cloud.
    // SSRF-guarded: the stored origin later drives App-JWT-bearing
    // calls in the callback, so it must be on the operator allowlist.
    const ghesCheck = validateGhesOrigin(req.query.ghesBaseUrl as string | undefined, config.githubGhesAllowedHosts);
    if (!ghesCheck.ok) {
      res.status(400).json({ error: ghesCheck.error });
      return;
    }
    const ghesBaseUrl = ghesCheck.origin;
    const cfg = getGithubConfig();
    if (!cfg.appSlug) {
      res.status(503).json({ error: "github app not configured (missing app_slug)" });
      return;
    }
    const state = issueInstallState(workspaceSlug, userId, ghesBaseUrl);
    const url = `${installNewUrlFor(cfg.appSlug, ghesBaseUrl)}?state=${state}`;
    res.json({ url });
  });

  r.get(
    "/api/github/team/auth/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const installationId = String(req.query.installation_id ?? "").trim();
      const state = String(req.query.state ?? "").trim();
      const setupAction = String(req.query.setup_action ?? "").trim();

      const feBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";
      const redirectOk = (slug: string) => `${feBase}/${slug}/settings/integrations?github=connected`;
      const redirectErr = (slug: string, msg: string) =>
        `${feBase}/${slug}/settings/integrations?github=error&reason=${encodeURIComponent(msg)}`;

      const entry = consumeInstallState(state);
      if (!entry) {
        res.status(400).send("Invalid or expired state");
        return;
      }
      if (!installationId) {
        res.redirect(redirectErr(entry.workspaceSlug, `no_installation:${setupAction || "unknown"}`));
        return;
      }

      // Read installation metadata as the App (JWT auth). Gives us the
      // org login + repo selection + permissions actually granted.
      const meta = await callGithubAsApp<{
        id: number;
        account: { login: string; id: number; type: string };
        repository_selection: "all" | "selected";
        permissions: Record<string, string>;
      }>("GET", `/app/installations/${encodeURIComponent(installationId)}`, undefined, entry.ghesBaseUrl);
      if (meta.status >= 300) {
        res.redirect(redirectErr(entry.workspaceSlug, `installation_lookup_${meta.status}`));
        return;
      }

      const installRes = await callDjango("POST", "/api/v1/silo/github/install/", {
        workspace_slug: entry.workspaceSlug,
        installer_user_id: entry.userId,
        installation_id: installationId,
        account_login: meta.data.account.login,
        account_id: meta.data.account.id,
        account_type: meta.data.account.type,
        repository_selection: meta.data.repository_selection,
        // Persisted in WorkspaceConnection.connection_data so the
        // bindings endpoint can return ghes_base_url to silo.
        ghes_base_url: entry.ghesBaseUrl ?? null,
      });
      if (installRes.status >= 300) {
        res.redirect(redirectErr(entry.workspaceSlug, `persist_${installRes.status}`));
        return;
      }
      res.redirect(redirectOk(entry.workspaceSlug));
    })
  );

  return r;
};
