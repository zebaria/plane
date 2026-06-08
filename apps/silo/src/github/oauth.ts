/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub workspace install — manifest bootstrap + App installation
 * OAuth flow.
 *
 *   GET  /silo/api/github/manifest?env=local|dev|prod
 *        -> renders a self-posting form to GitHub's manifest endpoint
 *           for the zebaria org. The manifest is built in code from
 *           silo's runtime config (see buildManifest).
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

import type { Request, Response, Router } from "express";
import express from "express";

import { config } from "../config";
import { getGithubConfig, githubGhesAllowedHosts, isGithubConfigured, setGithubConfig } from "./config";
import { callDjango } from "../django-client";
import { asyncHandler } from "../express-async";
import { loadGithubOAuthSecrets, writeGithubAppSecrets } from "./secrets";
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

// The GitHub App manifest is fully derived from silo's own runtime
// config — every URL is `${publicBaseUrl}${basePath}/api/github/...`
// and the rest is static. We build it in code rather than shipping
// per-env JSON files so the container stays generic: the only per-env
// input is SILO_PUBLIC_BASE_URL, injected at deploy time. (The old
// JSON files baked a developer's personal tunnel host into the image
// and were never copied into the runtime layer anyway.)
const buildManifest = (env: string): Record<string, unknown> => {
  const ghBase = `${config.publicBaseUrl}${config.basePath}/api/github`;
  return {
    name: `Plane - Zebaria (${env})`,
    url: config.publicBaseUrl,
    hook_attributes: { url: `${ghBase}-webhook`, active: true },
    redirect_url: `${ghBase}/manifest/callback`,
    callback_urls: [`${ghBase}/team/auth/callback`, `${ghBase}/auth/user/callback`],
    setup_url: `${ghBase}/team/auth/callback`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      issues: "write",
      pull_requests: "read",
      metadata: "read",
      members: "read",
      contents: "read",
    },
    default_events: ["issues", "issue_comment", "pull_request", "pull_request_review", "label", "repository"],
  };
};

// Encode the manifest state. GitHub round-trips it unchanged through
// both the App-creation redirect and the subsequent install redirect,
// so we read it back in the callbacks. It carries env (which env we're
// bootstrapping) + optional GHES origin + optional workspace context
// (ws/uid). The workspace context lets a single "Connect" press flow
// all the way to a completed connection: it's threaded through App
// creation → install → team/auth/callback without the user re-entering
// it. base64url-JSON so it survives GitHub's opaque state round-trip
// regardless of which optional fields are present.
export type ManifestState = {
  env: string;
  ghesBaseUrl?: string;
  workspaceSlug?: string;
  userId?: string;
};

export const encodeManifestState = (env: string, opts?: Omit<ManifestState, "env">): string => {
  const payload: ManifestState = { env };
  if (opts?.ghesBaseUrl) payload.ghesBaseUrl = opts.ghesBaseUrl;
  if (opts?.workspaceSlug) payload.workspaceSlug = opts.workspaceSlug;
  if (opts?.userId) payload.userId = opts.userId;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
};

export const decodeManifestState = (raw: string): ManifestState => {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ManifestState>;
    if (!parsed || typeof parsed.env !== "string") return { env: "" };
    return {
      env: parsed.env,
      ghesBaseUrl: typeof parsed.ghesBaseUrl === "string" ? parsed.ghesBaseUrl : undefined,
      workspaceSlug: typeof parsed.workspaceSlug === "string" ? parsed.workspaceSlug : undefined,
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
    };
  } catch {
    // Malformed/garbage state — treat as no env so the caller rejects it.
    return { env: "" };
  }
};

// Escape values reflected into the bootstrap HTML. `org` is free-form
// query input and `ghesHost`, though allowlist-validated, is still
// user-influenced — neither must be able to inject markup (CodeQL
// js/reflected-xss). `env` is already constrained to a fixed set but
// we escape it too for uniformity.
const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const renderManifestForm = (
  env: string,
  org: string,
  nonce: string,
  ghesHost?: string,
  ws?: { workspaceSlug?: string; userId?: string }
): string => {
  const manifest = buildManifest(env);
  const target = manifestUrlFor(org, ghesHost);
  const stateValue = encodeManifestState(env, {
    ghesBaseUrl: ghesHost,
    workspaceSlug: ws?.workspaceSlug,
    userId: ws?.userId,
  });
  const envH = htmlEscape(env);
  const orgH = htmlEscape(org);
  const whereH = ghesHost ? ` (GHES at ${htmlEscape(ghesHost)})` : "";
  // The form auto-submits so the only clicks the user ever sees are
  // GitHub's own mandatory "Create app" and "Install" approvals — this
  // shim page is collapsed away. The submit button remains as a no-JS
  // fallback. The inline script carries the CSP nonce set by the route;
  // `manifest` and `target` are escaped/built safely above.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plane GitHub App bootstrap (${envH}${whereH})</title></head>
<body>
<h1>Creating GitHub App for env=${envH}${whereH}…</h1>
<p>Registering a new GitHub App against the <code>${orgH}</code> org and
redirecting you to GitHub. If nothing happens, click the button.</p>
<form id="manifest-form" method="post" action="${htmlEscape(target)}?state=${encodeURIComponent(stateValue)}">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
  <button type="submit">Create GitHub App for ${envH}${whereH}</button>
</form>
<script nonce="${nonce}">document.getElementById('manifest-form').submit();</script>
</body></html>`;
};

// Bootstrap routes create the GitHub App and write /<env>/plane-github.
// They must mount UNCONDITIONALLY — before any secret exists — because
// they're the cold-start path: without them there's no way to create
// the secret that everything else is gated on. Wired via the
// integration registry's bootstrap() hook (see integrations.ts), which
// runs for every integration regardless of whether load() succeeded.
// The credential-using routes (githubOAuthRouter) stay behind mount().
export const githubBootstrapRouter = (): Router => {
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
    const ghesCheck = validateGhesOrigin(req.query.ghes_host as string | undefined, githubGhesAllowedHosts);
    if (!ghesCheck.ok) {
      res.status(400).type("text/plain").send(ghesCheck.error);
      return;
    }
    const ghesHost = ghesCheck.origin;
    const org = String(req.query.org ?? "").trim() || "zebaria";
    // Optional workspace context: when Connect routes a fresh env here,
    // it passes ws/uid so the flow can auto-complete the connection
    // after install instead of making the admin click Connect again.
    const workspaceSlug = String(req.query.workspaceSlug ?? "").trim() || undefined;
    const userId = String(req.query.userId ?? "").trim() || undefined;
    const formAction = webBaseFor(ghesHost);
    // Per-response nonce so the auto-submit inline <script> is allowed
    // without opening up 'unsafe-inline'. newCsrfState() is a CSPRNG
    // token — fine as a one-shot nonce.
    const nonce = newCsrfState();
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'nonce-${nonce}'; form-action ${formAction}`
    );
    res.type("html").send(renderManifestForm(env, org, nonce, ghesHost, { workspaceSlug, userId }));
  });

  r.get(
    "/api/github/manifest/callback",
    asyncHandler(async (req: Request, res: Response) => {
      const code = String(req.query.code ?? "").trim();
      // GitHub returns our `state` parameter unchanged — we use it to
      // identify which env we're bootstrapping (set in the form action
      // above) and, for GHES, where to swap api.github.com.
      const rawState = String(req.query.state ?? "").trim();
      const { env, ghesBaseUrl, workspaceSlug, userId } = decodeManifestState(rawState);
      if (!code || !["local", "dev", "prod"].includes(env)) {
        res.status(400).type("text/plain").send("missing code or invalid state");
        return;
      }
      // `state` round-trips through GitHub but is ultimately
      // caller-influenced, so re-validate the GHES origin here too —
      // convertManifest would otherwise POST the OAuth code to it.
      const ghesCheck = validateGhesOrigin(ghesBaseUrl, githubGhesAllowedHosts);
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
      // One-press path: if Connect threaded a workspace through the
      // state, send the admin straight into GitHub's "Install App" page
      // with an install state. After they pick repos, GitHub redirects
      // to the App's setup_url (= team/auth/callback), which consumes
      // that state and completes the workspace connection — no second
      // Connect press. Only available for the running env (the install
      // state + hot-loaded config are this process's).
      if (workspaceSlug && userId && env === config.env) {
        const installState = issueInstallState(workspaceSlug, userId, ghesCheck.origin);
        const installUrl = `${installNewUrlFor(conv.slug, ghesCheck.origin)}?state=${installState}`;
        res.redirect(installUrl);
        return;
      }
      // Manual path (no workspace context, or bootstrapping a non-running
      // env): show the install link. `conv.html_url` comes from the
      // manifest-conversion response of a user-influenced host (GHES), so
      // escape it before reflecting it into HTML (CodeQL
      // js/reflected-xss). `env` is fixed-set but escaped for uniformity.
      const envH = htmlEscape(env);
      const htmlUrlH = htmlEscape(conv.html_url ?? "");
      res.type("html").send(
        `<!doctype html><html><body><h1>App created for env=${envH}</h1>
<p>Stored in AWS Secrets Manager at <code>/${envH}/plane-github</code>.</p>
<p>Next step: visit <a href="${htmlUrlH}">${htmlUrlH}</a>
and click <strong>Install App</strong> to install it into the
zebaria org and choose repos.</p>
</body></html>`
      );
    })
  );

  return r;
};

export const githubOAuthRouter = (): Router => {
  const r = express.Router();

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
    const ghesCheck = validateGhesOrigin(req.query.ghesBaseUrl as string | undefined, githubGhesAllowedHosts);
    if (!ghesCheck.ok) {
      res.status(400).json({ error: ghesCheck.error });
      return;
    }
    const ghesBaseUrl = ghesCheck.origin;
    // Self-bootstrap: if no GitHub App exists for this env yet, there's
    // no install URL to hand back. Rather than 404/503 (which surfaces
    // as a silent "connect failed"), return the manifest bootstrap URL
    // so the UI sends the admin into the create-App flow. From the
    // user's seat, clicking Connect on a fresh env just starts setup.
    // (GitHub requires a human to click "Create app" — a manifest can't
    // mint an App headlessly — so this is as automatic as GitHub allows.)
    if (!isGithubConfigured() || !getGithubConfig().appSlug) {
      const params = new URLSearchParams({ env: config.env, workspaceSlug, userId });
      if (ghesBaseUrl) params.set("ghes_host", ghesBaseUrl);
      res.json({
        url: `${config.publicBaseUrl}${config.basePath}/api/github/manifest?${params.toString()}`,
        bootstrap: true,
      });
      return;
    }
    const cfg = getGithubConfig();
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
