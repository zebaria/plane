/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub secret loading. Owned by the GitHub integration; uses the shared
 * secret-store kit (../secrets) for the actual fetch/create.
 */

import { createSecret, fetchJson, optionalSecretUnavailable, required } from "../secrets";

export type GithubAppSecrets = {
  app_id: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  private_key: string;
  app_slug?: string;
};

export type GithubOAuthSecrets = {
  client_id: string;
  client_secret: string;
};

export const loadGithubAppSecrets = async (env: string): Promise<GithubAppSecrets | null> => {
  // Returns null when the secret doesn't exist yet — the manifest flow
  // creates it on first install. Silo must not crash on startup when GH
  // hasn't been bootstrapped yet.
  try {
    const v = await fetchJson<GithubAppSecrets>("plane-github", env);
    required(
      v as unknown as Record<string, unknown>,
      ["app_id", "client_id", "client_secret", "webhook_secret", "private_key"],
      "plane-github"
    );
    return v;
  } catch (err) {
    if (optionalSecretUnavailable(err, "plane-github")) return null;
    throw err;
  }
};

export const writeGithubAppSecrets = async (env: string, value: GithubAppSecrets): Promise<void> => {
  // CreateSecret if absent, refuse if present — manifest flow is one-shot
  // to prevent accidentally overwriting a working install.
  await createSecret("plane-github", env, value);
};

export const loadGithubOAuthSecrets = async (env: string): Promise<GithubOAuthSecrets | null> => {
  try {
    const v = await fetchJson<GithubOAuthSecrets>("plane-github-oauth", env);
    required(v as unknown as Record<string, unknown>, ["client_id", "client_secret"], "plane-github-oauth");
    return v;
  } catch (err) {
    if (optionalSecretUnavailable(err, "plane-github-oauth")) return null;
    throw err;
  }
};
