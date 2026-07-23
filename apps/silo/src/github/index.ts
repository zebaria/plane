/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub integration: lifecycle wiring (load secrets + mount routes) as a
 * single registry entry. See ../integrations.ts.
 */

import type { Router } from "express";

import { setGithubConfig } from "./config";
import type { Integration } from "../integrations";
import { loadGithubAppSecrets, loadGithubOAuthSecrets } from "./secrets";
import { githubBootstrapRouter, githubOAuthRouter } from "./oauth";
import { githubOutboundDispatcher } from "./outbound";
import { githubReposRouter } from "./repos";
import { githubUserOAuthRouter } from "./user-oauth";
import { githubWebhookRouter } from "./webhook";

export const githubIntegration: Integration = {
  name: "github",
  dispatcher: githubOutboundDispatcher,

  load: async (env: string): Promise<boolean> => {
    // The GitHub App secret may not exist yet on a fresh deploy — the
    // manifest flow creates it. OAuth creds are a separate, also-optional
    // secret. Unlike a normal integration, GitHub always returns true so
    // mount() is always called: its routes self-bootstrap (team/auth/url
    // redirects an admin into the create-App flow when no secret exists)
    // and degrade gracefully via isGithubConfigured() checks. Returning
    // false here would 404 the very route a user clicks to set it up.
    const gh = await loadGithubAppSecrets(env);
    if (!gh) {
      console.log(
        `[silo] GitHub integration unconfigured (no secret at /${env}/plane-github yet) — ` +
          `routes mounted; Connect will redirect into the manifest bootstrap`
      );
      return true;
    }
    // A GitHub App does user-to-server OAuth with its OWN client_id/secret
    // (the ones the manifest flow already stored in /<env>/plane-github) —
    // there is no separate OAuth app or second credential. So default the
    // OAuth creds to the App's own, and only override if a distinct
    // /<env>/plane-github-oauth secret exists (legacy/optional escape hatch
    // for pointing user-OAuth at a different client). Without this default,
    // per-user OAuth 503s on any env bootstrapped purely via the manifest.
    const ghOauth = await loadGithubOAuthSecrets(env);
    setGithubConfig({
      appId: gh.app_id,
      appSlug: gh.app_slug ?? "",
      clientId: gh.client_id,
      clientSecret: gh.client_secret,
      webhookSecret: gh.webhook_secret,
      privateKey: gh.private_key,
      oauthClientId: ghOauth?.client_id ?? gh.client_id,
      oauthClientSecret: ghOauth?.client_secret ?? gh.client_secret,
    });
    console.log(`[silo] GitHub integration enabled (/${env}/plane-github)`);
    return true;
  },

  // The App-manifest bootstrap routes mount unconditionally — they
  // create the /<env>/plane-github secret that load()/mount() gate on,
  // so they must exist before the integration is configured. See
  // ../integrations.ts bootstrapIntegrations().
  bootstrap: (router: Router): void => {
    router.use(githubBootstrapRouter());
  },

  // Mounted unconditionally — NOT gated on isGithubConfigured(). Two
  // reasons: (1) team/auth/url self-bootstraps when no App exists yet
  // (returns the manifest URL so Connect redirects the admin into the
  // create-App flow instead of 404ing); (2) the manifest callback
  // hot-loads config after writing the secret, but gating mount() at
  // startup would leave these routes 404 until a restart. Each handler
  // checks isGithubConfigured()/getGithubConfig() itself and degrades
  // gracefully when unconfigured.
  mount: (router: Router): void => {
    router.use(githubOAuthRouter());
    router.use(githubUserOAuthRouter());
    router.use(githubReposRouter());
    router.use(githubWebhookRouter());
  },
};
