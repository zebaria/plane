/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack secret loading. Owned by the Slack integration; uses the shared
 * secret-store kit (../secrets) for the actual fetch.
 */

import { fetchJson, optionalSecretUnavailable, required } from "../secrets";

export type SlackSecrets = {
  client_id: string;
  client_secret: string;
  signing_secret: string;
};

export const loadSlackSecrets = async (env: string): Promise<SlackSecrets | null> => {
  // Local-dev fallback: if all three Slack env vars are present, skip
  // Secrets Manager entirely. Avoids the dev-loop crashing when the
  // workstation has no AWS creds for the silo IAM role's namespace.
  const envClientId = process.env.SLACK_CLIENT_ID;
  const envClientSecret = process.env.SLACK_CLIENT_SECRET;
  const envSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (envClientId && envClientSecret && envSigningSecret) {
    return {
      client_id: envClientId,
      client_secret: envClientSecret,
      signing_secret: envSigningSecret,
    };
  }
  // Optional: if the secret is missing/unreadable, disable the Slack
  // integration and boot anyway rather than crash-looping.
  try {
    const v = await fetchJson<SlackSecrets>("plane-slack", env);
    required(v as unknown as Record<string, unknown>, ["client_id", "client_secret", "signing_secret"], "plane-slack");
    return v;
  } catch (err) {
    if (optionalSecretUnavailable(err, "plane-slack")) return null;
    throw err;
  }
};
