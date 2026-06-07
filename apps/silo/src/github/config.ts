/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub integration config state. Owned by the GitHub integration so the
 * provider's runtime config lives next to its code, not in a shared file.
 */

export type GithubProviderConfig = {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
};

let githubConfig: GithubProviderConfig | null = null;

export const setGithubConfig = (g: GithubProviderConfig): void => {
  githubConfig = g;
};

export const getGithubConfig = (): GithubProviderConfig => {
  if (!githubConfig) {
    throw new Error("GitHub config not loaded — run the manifest flow at /silo/api/github/manifest");
  }
  return githubConfig;
};

export const isGithubConfigured = (): boolean => githubConfig !== null;

// SSRF guard: comma-separated allowlist of GitHub Enterprise Server
// origins (e.g. "https://ghe.acme.com"). A GHES install/oauth request is
// rejected unless its origin is listed here. Empty by default — cloud
// github.com needs no entry. GitHub-specific, so it lives here.
export const githubGhesAllowedHosts: string[] = (process.env.GITHUB_GHES_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
