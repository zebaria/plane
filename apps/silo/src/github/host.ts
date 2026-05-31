/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4g: GitHub Enterprise Server URL switching.
 *
 * Cloud github.com:
 *   API:    https://api.github.com
 *   Web:    https://github.com
 *
 * GHES (e.g. ghe.acme.com):
 *   API:    https://ghe.acme.com/api/v3
 *   Web:    https://ghe.acme.com
 *
 * `ghesBaseUrl` is the customer's GHES web origin (no trailing slash,
 * no `/api/v3`). When `undefined`/empty, every helper returns the
 * cloud constants — so existing call sites that don't know about
 * GHES yet keep working.
 */

const CLOUD_API = "https://api.github.com";
const CLOUD_WEB = "https://github.com";

const trim = (u: string | null | undefined): string | undefined => {
  if (!u) return undefined;
  const s = u.trim().replace(/\/+$/, "");
  return s || undefined;
};

export const apiBaseFor = (ghesBaseUrl?: string | null): string => {
  const host = trim(ghesBaseUrl);
  return host ? `${host}/api/v3` : CLOUD_API;
};

export const webBaseFor = (ghesBaseUrl?: string | null): string => {
  return trim(ghesBaseUrl) ?? CLOUD_WEB;
};

export const manifestUrlFor = (org: string, ghesBaseUrl?: string | null): string =>
  `${webBaseFor(ghesBaseUrl)}/organizations/${encodeURIComponent(org)}/settings/apps/new`;

export const oauthAuthorizeUrlFor = (ghesBaseUrl?: string | null): string =>
  `${webBaseFor(ghesBaseUrl)}/login/oauth/authorize`;

export const oauthAccessTokenUrlFor = (ghesBaseUrl?: string | null): string =>
  `${webBaseFor(ghesBaseUrl)}/login/oauth/access_token`;

export const installNewUrlFor = (appSlug: string, ghesBaseUrl?: string | null): string =>
  `${webBaseFor(ghesBaseUrl)}/apps/${encodeURIComponent(appSlug)}/installations/new`;

/**
 * SSRF guard for the customer-supplied GHES origin.
 *
 * `ghesBaseUrl` arrives from untrusted query/state and becomes the
 * base URL for server-side calls that carry the GitHub App JWT and
 * installation tokens — leaking those to an attacker host is full App
 * compromise. So a caller cannot point silo at an arbitrary origin:
 * the origin must exactly match (after normalization) one of the
 * operator-configured allowed hosts.
 *
 * The allowlist is the trust boundary, deliberately *not* a
 * private-IP block: GHES is usually self-hosted on a private network,
 * so blocking RFC-1918/loopback would break the legitimate case. The
 * operator vouches for each entry by putting it in the allowlist.
 *
 * Empty/undefined input → cloud github.com (always allowed).
 * Returns the normalized origin (scheme://host[:port], no path/slash)
 * on success, or `{ error }` describing why it was rejected.
 */
export type GhesOriginResult = { ok: true; origin?: string } | { ok: false; error: string };

// Normalize to a bare origin: lowercased scheme + host, explicit port
// preserved, everything else (path, query, trailing slash) dropped.
// Returns undefined if the input isn't a parseable absolute URL.
export const normalizeGhesOrigin = (raw: string | null | undefined): string | undefined => {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  // `URL.origin` already gives scheme://host[:port] with no trailing
  // slash and a lowercased host, and omits any path/query.
  return u.origin;
};

export const validateGhesOrigin = (raw: string | null | undefined, allowedHosts: string[]): GhesOriginResult => {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, origin: undefined }; // cloud github.com
  const normalized = normalizeGhesOrigin(s);
  if (!normalized) {
    return { ok: false, error: "ghes origin must be an absolute http(s) URL" };
  }
  // Allowlist entries are normalized the same way so a trailing slash
  // or case difference in config doesn't cause a spurious miss.
  const allowed = allowedHosts.map((h) => normalizeGhesOrigin(h)).filter((h): h is string => !!h);
  if (!allowed.includes(normalized)) {
    return { ok: false, error: "ghes origin not in GITHUB_GHES_ALLOWED_HOSTS allowlist" };
  }
  return { ok: true, origin: normalized };
};
