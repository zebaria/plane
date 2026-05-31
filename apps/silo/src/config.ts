/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export type SlackProviderConfig = {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUrl: string;
};

export type RuntimeConfig = {
  port: number;
  basePath: string;
  publicBaseUrl: string;
  env: string;
  hmacSecret: string;
  apiInternalBaseUrl: string;
  slack: SlackProviderConfig;
};

export const config = {
  port: Number(process.env.SILO_PORT ?? 3005),
  basePath: process.env.SILO_BASE_PATH ?? "/silo",
  publicBaseUrl: process.env.SILO_PUBLIC_BASE_URL ?? "http://localhost:3005",
  env: process.env.SILO_ENV ?? "dev",
  // Production must set SILO_HMAC_SECRET_KEY explicitly — the dev
  // fallback would silently leave service-to-service auth wide open.
  hmacSecret: required("SILO_HMAC_SECRET_KEY", process.env.SILO_ENV === "prod" ? undefined : "dev-insecure-silo-hmac"),
  apiInternalBaseUrl: process.env.API_INTERNAL_BASE_URL ?? "http://localhost:8800",
  // Phase 4g SSRF guard: comma-separated allowlist of GitHub
  // Enterprise Server origins (e.g. "https://ghe.acme.com"). A GHES
  // install/oauth request is rejected unless its origin is listed
  // here. Empty by default — cloud github.com needs no entry.
  githubGhesAllowedHosts: (process.env.GITHUB_GHES_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
};

let slackConfig: SlackProviderConfig | null = null;

export const setSlackConfig = (s: SlackProviderConfig): void => {
  slackConfig = s;
};

export const getSlackConfig = (): SlackProviderConfig => {
  if (!slackConfig) throw new Error("Slack config not loaded yet");
  return slackConfig;
};

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
