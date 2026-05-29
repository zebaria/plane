/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { config, setGithubConfig, setSlackConfig } from "./config";
import { loadGithubAppSecrets, loadGithubOAuthSecrets, loadSlackSecrets } from "./secrets";
import { createApp } from "./server";

const slackRedirect = `${config.publicBaseUrl}${config.basePath}/api/slack/team/auth/callback`;

const bootstrap = async (): Promise<void> => {
  const s = await loadSlackSecrets(config.env);
  setSlackConfig({
    clientId: s.client_id,
    clientSecret: s.client_secret,
    signingSecret: s.signing_secret,
    redirectUrl: slackRedirect,
  });
  // eslint-disable-next-line no-console
  console.log(`[silo] loaded Slack secrets from SSM (/${config.env}/plane-slack)`);

  // GitHub is optional at startup — the manifest flow may not have
  // run yet on a fresh deploy. /api/github/manifest works without it;
  // /api/github/team/* will 503 until both secrets are in place.
  const gh = await loadGithubAppSecrets(config.env);
  const ghOauth = await loadGithubOAuthSecrets(config.env);
  if (gh) {
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
    // eslint-disable-next-line no-console
    console.log(`[silo] loaded GitHub App secrets from SSM (/${config.env}/plane-github)`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[silo] no GitHub App secrets at /${config.env}/plane-github yet — run the manifest flow at /silo/api/github/manifest?env=${config.env} to bootstrap`
    );
  }
};

const app = createApp();

// Don't bind the port until secrets have loaded — otherwise an early
// Slack webhook can hit getSlackConfig() before SSM responds and throw.
bootstrap()
  .then(() => {
    const server = app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`[silo] listening on :${config.port} basePath=${config.basePath}`);
    });

    const shutdown = (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`[silo] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return server;
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[silo] bootstrap failed: ${(err as Error).message}`);
    process.exit(1);
  });
