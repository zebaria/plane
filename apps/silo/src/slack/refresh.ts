/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack bot token refresh — workspaces with rotation enabled.
 *
 * Slack rotates bot tokens every ~12 hours. The OAuth callback
 * returns a `refresh_token` (long-lived) alongside the short-lived
 * `access_token`. To refresh, POST `oauth.v2.access` with
 * `grant_type=refresh_token` + `refresh_token` + client credentials.
 *
 * Silo owns the Slack client_secret (loaded from SSM at startup), so
 * the refresh call lives here. Once we have a new pair, we POST it
 * to Django for persistence and invalidate the in-process team-
 * context cache so the next call picks up the new token.
 */

import axios from "axios";

import { getSlackConfig } from "../config";
import { callDjango } from "../django-client";
import type { SlackOAuthResponse } from "./oauth";
import { invalidateTeamContext, resolveTeamContext } from "./team-context";

const callSlackRefresh = async (refreshToken: string): Promise<SlackOAuthResponse> => {
  const slack = getSlackConfig();
  const body = new URLSearchParams({
    client_id: slack.clientId,
    client_secret: slack.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await axios.post<SlackOAuthResponse>("https://slack.com/api/oauth.v2.access", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: () => true,
  });
  return res.data;
};

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Refresh the bot token for `teamId`. Returns the new access token,
 * or null if refresh failed (e.g. refresh_token revoked — caller
 * should surface a re-install prompt).
 *
 * Coalesces concurrent refresh calls per team so a burst of expired
 * requests doesn't hammer Slack.
 */
export const refreshBotToken = async (teamId: string): Promise<string | null> => {
  const existing = inFlight.get(teamId);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    try {
      const ctx = await resolveTeamContext(teamId);
      if (!ctx?.refreshToken) {
        console.warn(`[silo] no refresh_token for team=${teamId}; cannot rotate`);
        return null;
      }

      const r = await callSlackRefresh(ctx.refreshToken);
      if (!r.ok || !r.access_token) {
        console.error(`[silo] Slack refresh failed: ${r.error ?? "unknown"} (team=${teamId})`);
        return null;
      }

      // Slack invalidates the OLD refresh_token the moment we successfully
      // call oauth.v2.access with grant_type=refresh_token, and the NEW
      // refresh_token only lives in `r.refresh_token`. If we drop it on
      // the floor (transient Django/DB hiccup), the workspace is locked
      // out until an admin re-installs. Retry persistence with backoff
      // before giving up.
      let persist;
      let lastErr = "";
      // Sequential by design: each attempt depends on the previous one's
      // response, and the backoff sleep is intentional.
      // eslint-disable-next-line no-await-in-loop
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          persist = await callDjango("POST", "/api/v1/silo/slack/persist-tokens/", {
            team_id: teamId,
            access_token: r.access_token,
            refresh_token: r.refresh_token ?? "",
            expires_in: r.expires_in ?? null,
          });
          if (persist.status < 300) break;
          lastErr = `${persist.status} ${JSON.stringify(persist.data)}`;
          if (persist.status >= 400 && persist.status < 500 && persist.status !== 429) break;
        } catch (err) {
          // Network/DNS/timeout: retry with backoff just like a 5xx.
          // Without this catch, the outer try would unwind before we
          // ever get to the second attempt.
          lastErr = (err as Error).message;
          persist = undefined;
        }
        if (attempt < 4) {
          const backoffMs = 200 * 2 ** attempt;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
      if (!persist || persist.status >= 300) {
        console.error(
          `[silo] persist-tokens failed after retries: ${lastErr} — refresh_token may be lost; team=${teamId}`
        );
        return null;
      }

      invalidateTeamContext(teamId);
      return r.access_token;
    } catch (err) {
      // Network/DNS/etc. — return null so callers see the original
      // Slack error path rather than a refresh exception masking it.
      console.error(`[silo] token refresh threw for team=${teamId}:`, err);
      return null;
    }
  })();

  inFlight.set(teamId, p);
  try {
    return await p;
  } finally {
    inFlight.delete(teamId);
  }
};
