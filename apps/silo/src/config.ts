/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shared runtime config for the silo service. Provider-specific config
 * (Slack, GitHub) is owned by each integration — see slack/config.ts and
 * github/config.ts.
 */

const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export type RuntimeConfig = {
  port: number;
  basePath: string;
  publicBaseUrl: string;
  env: string;
  hmacSecret: string;
  apiInternalBaseUrl: string;
};

export const config: RuntimeConfig = {
  port: Number(process.env.SILO_PORT ?? 3005),
  basePath: process.env.SILO_BASE_PATH ?? "/silo",
  publicBaseUrl: process.env.SILO_PUBLIC_BASE_URL ?? "http://localhost:3005",
  env: process.env.SILO_ENV ?? "dev",
  // Production must set SILO_HMAC_SECRET_KEY explicitly — the dev
  // fallback would silently leave service-to-service auth wide open.
  hmacSecret: required("SILO_HMAC_SECRET_KEY", process.env.SILO_ENV === "prod" ? undefined : "dev-insecure-silo-hmac"),
  apiInternalBaseUrl: process.env.API_INTERNAL_BASE_URL ?? "http://localhost:8800",
};
