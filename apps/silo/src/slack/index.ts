/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack integration: lifecycle wiring (load secrets + mount routes) as a
 * single registry entry. See ../integrations.ts.
 */

import type { Router } from "express";

import { config } from "../config";
import { isSlackConfigured, setSlackConfig } from "./config";
import type { Integration } from "../integrations";
import { loadSlackSecrets } from "./secrets";
import { slackChannelsRouter } from "./channels";
import { slackCommandsRouter } from "./commands";
import { slackEventsRouter } from "./events";
import { slackInteractionsRouter } from "./interactions";
import { slackOAuthRouter } from "./oauth";
import { slackDispatcher } from "./outbound";
import { slackUserOAuthRouter } from "./user-oauth";

export const slackIntegration: Integration = {
  name: "slack",
  dispatcher: slackDispatcher,

  load: async (env: string): Promise<boolean> => {
    const s = await loadSlackSecrets(env);
    if (!s) {
      console.log(`[silo] Slack integration disabled (no usable secret at /${env}/plane-slack)`);
      return false;
    }
    setSlackConfig({
      clientId: s.client_id,
      clientSecret: s.client_secret,
      signingSecret: s.signing_secret,
      redirectUrl: `${config.publicBaseUrl}${config.basePath}/api/slack/team/auth/callback`,
    });
    console.log(`[silo] Slack integration enabled (/${env}/plane-slack)`);
    return true;
  },

  mount: (router: Router): void => {
    if (!isSlackConfigured()) return;
    router.use(slackOAuthRouter());
    router.use(slackUserOAuthRouter());
    router.use(slackCommandsRouter());
    router.use(slackInteractionsRouter());
    router.use(slackEventsRouter());
    router.use(slackChannelsRouter());
  },
};
