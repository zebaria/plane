/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub integration: lifecycle wiring (load secrets + mount routes) as a
 * single registry entry. See ../integrations.ts.
 */

import type { Router } from "express";

import { isGithubConfigured, setGithubConfig } from "./config";
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
    // secret. Without the App secret the integration stays disabled.
    const gh = await loadGithubAppSecrets(env);
    if (!gh) {
      console.log(
        `[silo] GitHub integration disabled (no secret at /${env}/plane-github yet — ` +
          `run the manifest flow at /silo/api/github/manifest?env=${env} to bootstrap)`
      );
      return false;
    }
    const ghOauth = await loadGithubOAuthSecrets(env);
    setGithubConfig({
      appId: gh.app_id,
      appSlug: gh.app_slug ?? "",
      clientId: gh.client_id,
      clientSecret: gh.client_secret,
      webhookSecret: gh.webhook_secret,
      privateKey: gh.private_key,
      oauthClientId: ghOauth?.client_id ?? "",
      oauthClientSecret: ghOauth?.client_secret ?? "",
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

  mount: (router: Router): void => {
    if (!isGithubConfigured()) return;
    router.use(githubOAuthRouter());
    router.use(githubUserOAuthRouter());
    router.use(githubReposRouter());
    router.use(githubWebhookRouter());
  },
};
