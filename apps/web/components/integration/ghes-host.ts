/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4g: normalize an admin-entered GitHub Enterprise Server
 * hostname into a bare https origin (no trailing slash) that silo can
 * append `/api/v3` to. Kept dependency-free so it's unit-testable
 * without rendering the surrounding card.
 */

// Accept "ghe.acme.com" or "https://ghe.acme.com"; normalize to a bare
// origin with no trailing slash. An explicit http:// scheme is kept
// (some on-prem GHES instances aren't fronted by TLS).
export const normalizeGhesHost = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};
