/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub API client — handles App JWT minting and per-installation
 * token caching.
 *
 *   App JWT (RS256, exp=10m, iss=app_id) — required for
 *   /app/* endpoints (installation lookup, token minting,
 *   manifest conversions).
 *
 *   Installation token (1h-lived, fetched on demand) — required
 *   for /repos/* and /installation/* endpoints. We cache 50 minutes
 *   to leave headroom against clock skew + retries, then refresh.
 */

import { createSign, randomBytes } from "node:crypto";

import axios, { type AxiosResponse } from "axios";

import { getGithubConfig } from "../config";

const GH_API = "https://api.github.com";

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const mintAppJwt = (): string => {
  const cfg = getGithubConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat back-dated 30s to absorb clock skew between us and GitHub.
  const payload = b64url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: cfg.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const sig = b64url(signer.sign(cfg.privateKey));
  return `${header}.${payload}.${sig}`;
};

type CachedToken = { token: string; expiresAt: number };
const installationTokens = new Map<string, CachedToken>();

const fetchInstallationToken = async (installationId: string): Promise<string> => {
  const jwt = mintAppJwt();
  const r = await axios.post<{ token: string; expires_at: string }>(
    `${GH_API}/app/installations/${installationId}/access_tokens`,
    {},
    {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
      validateStatus: () => true,
    }
  );
  if (r.status >= 300) {
    throw new Error(`installation_token ${r.status}: ${JSON.stringify(r.data)}`);
  }
  return r.data.token;
};

export const getInstallationToken = async (installationId: string): Promise<string> => {
  const now = Date.now();
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt > now) return cached.token;
  const token = await fetchInstallationToken(installationId);
  installationTokens.set(installationId, { token, expiresAt: now + 50 * 60 * 1000 });
  return token;
};

export const invalidateInstallationToken = (installationId: string): void => {
  installationTokens.delete(installationId);
};

export const callGithubAsApp = async <T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<AxiosResponse<T>> => {
  const jwt = mintAppJwt();
  return axios.request<T>({
    method,
    url: `${GH_API}${path}`,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    data: body,
    validateStatus: () => true,
  });
};

export const callGithub = async <T = unknown>(
  installationId: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<AxiosResponse<T>> => {
  let token = await getInstallationToken(installationId);
  const send = (): Promise<AxiosResponse<T>> =>
    axios.request<T>({
      method,
      url: `${GH_API}${path}`,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      data: body,
      validateStatus: () => true,
    });
  let r = await send();
  if (r.status === 401) {
    invalidateInstallationToken(installationId);
    token = await getInstallationToken(installationId);
    r = await send();
  }
  return r;
};

// Used by manifest flow to convert the temporary `code` into the
// real App credentials (App ID, client_id, client_secret, webhook_secret,
// pem). This call uses only the temporary code as auth — no JWT yet.
export const convertManifest = async (
  code: string
): Promise<{
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
}> => {
  const r = await axios.post(
    `${GH_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {},
    {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      validateStatus: () => true,
    }
  );
  if (r.status >= 300) {
    throw new Error(`manifest conversion ${r.status}: ${JSON.stringify(r.data)}`);
  }
  return r.data;
};

export const newCsrfState = (): string => randomBytes(24).toString("hex");
