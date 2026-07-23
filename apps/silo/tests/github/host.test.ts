/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4g: GHES URL switching. The helper is called from every
 * api.ts wrapper and the manifest/oauth flows, so missing the cloud
 * fallback would point production calls at empty hosts.
 */

import { describe, expect, it } from "vitest";

import {
  apiBaseFor,
  installNewUrlFor,
  manifestUrlFor,
  normalizeGhesOrigin,
  oauthAccessTokenUrlFor,
  oauthAuthorizeUrlFor,
  validateGhesOrigin,
  webBaseFor,
} from "@/github/host";

describe("apiBaseFor", () => {
  it("returns cloud base when ghesBaseUrl is undefined", () => {
    expect(apiBaseFor()).toBe("https://api.github.com");
  });

  it("returns cloud base when ghesBaseUrl is null/empty", () => {
    expect(apiBaseFor(null)).toBe("https://api.github.com");
    expect(apiBaseFor("")).toBe("https://api.github.com");
    expect(apiBaseFor("   ")).toBe("https://api.github.com");
  });

  it("appends /api/v3 for a GHES origin", () => {
    expect(apiBaseFor("https://ghe.acme.com")).toBe("https://ghe.acme.com/api/v3");
  });

  it("strips trailing slashes before appending", () => {
    expect(apiBaseFor("https://ghe.acme.com/")).toBe("https://ghe.acme.com/api/v3");
    expect(apiBaseFor("https://ghe.acme.com///")).toBe("https://ghe.acme.com/api/v3");
  });
});

describe("webBaseFor", () => {
  it("returns github.com on cloud", () => {
    expect(webBaseFor()).toBe("https://github.com");
    expect(webBaseFor(null)).toBe("https://github.com");
  });

  it("returns the GHES origin verbatim", () => {
    expect(webBaseFor("https://ghe.acme.com")).toBe("https://ghe.acme.com");
  });
});

describe("manifestUrlFor", () => {
  it("uses github.com for cloud", () => {
    expect(manifestUrlFor("zebaria")).toBe("https://github.com/organizations/zebaria/settings/apps/new");
  });

  it("uses GHES host for enterprise", () => {
    expect(manifestUrlFor("acme", "https://ghe.acme.com")).toBe(
      "https://ghe.acme.com/organizations/acme/settings/apps/new"
    );
  });

  it("encodes the org segment", () => {
    expect(manifestUrlFor("a/b")).toContain("organizations/a%2Fb/");
  });
});

describe("oauthAuthorizeUrlFor / oauthAccessTokenUrlFor", () => {
  it("cloud defaults", () => {
    expect(oauthAuthorizeUrlFor()).toBe("https://github.com/login/oauth/authorize");
    expect(oauthAccessTokenUrlFor()).toBe("https://github.com/login/oauth/access_token");
  });

  it("ghes swap", () => {
    expect(oauthAuthorizeUrlFor("https://ghe.acme.com")).toBe("https://ghe.acme.com/login/oauth/authorize");
    expect(oauthAccessTokenUrlFor("https://ghe.acme.com")).toBe("https://ghe.acme.com/login/oauth/access_token");
  });
});

describe("installNewUrlFor", () => {
  it("cloud install URL", () => {
    expect(installNewUrlFor("plane-app")).toBe("https://github.com/apps/plane-app/installations/new");
  });

  it("GHES install URL", () => {
    expect(installNewUrlFor("plane-app", "https://ghe.acme.com")).toBe(
      "https://ghe.acme.com/apps/plane-app/installations/new"
    );
  });
});

describe("normalizeGhesOrigin", () => {
  it("returns undefined for empty / whitespace", () => {
    expect(normalizeGhesOrigin("")).toBeUndefined();
    expect(normalizeGhesOrigin("   ")).toBeUndefined();
    expect(normalizeGhesOrigin(null)).toBeUndefined();
  });

  it("strips path, query, and trailing slash to a bare origin", () => {
    expect(normalizeGhesOrigin("https://ghe.acme.com/api/v3/")).toBe("https://ghe.acme.com");
    expect(normalizeGhesOrigin("https://ghe.acme.com/path?a=b")).toBe("https://ghe.acme.com");
  });

  it("preserves an explicit port", () => {
    expect(normalizeGhesOrigin("https://ghe.acme.com:8443")).toBe("https://ghe.acme.com:8443");
  });

  it("lowercases the host", () => {
    expect(normalizeGhesOrigin("https://GHE.Acme.COM")).toBe("https://ghe.acme.com");
  });

  it("returns undefined for a non-absolute / non-http(s) URL", () => {
    expect(normalizeGhesOrigin("ghe.acme.com")).toBeUndefined();
    expect(normalizeGhesOrigin("ftp://ghe.acme.com")).toBeUndefined();
    expect(normalizeGhesOrigin("javascript:alert(1)")).toBeUndefined();
  });
});

describe("validateGhesOrigin (SSRF guard)", () => {
  const allow = ["https://ghe.acme.com", "https://ghe.internal:8443"];

  it("allows empty input as cloud github.com (origin undefined)", () => {
    expect(validateGhesOrigin("", allow)).toEqual({ ok: true, origin: undefined });
    expect(validateGhesOrigin(undefined, allow)).toEqual({ ok: true, origin: undefined });
  });

  it("allows an allowlisted origin and returns the normalized form", () => {
    expect(validateGhesOrigin("https://ghe.acme.com", allow)).toEqual({
      ok: true,
      origin: "https://ghe.acme.com",
    });
    // Trailing slash / path is normalized before the allowlist check.
    expect(validateGhesOrigin("https://ghe.acme.com/", allow)).toEqual({
      ok: true,
      origin: "https://ghe.acme.com",
    });
    expect(validateGhesOrigin("https://ghe.internal:8443", allow)).toEqual({
      ok: true,
      origin: "https://ghe.internal:8443",
    });
  });

  it("rejects an origin not on the allowlist (the SSRF case)", () => {
    const r = validateGhesOrigin("https://evil.tld", allow);
    expect(r.ok).toBe(false);
  });

  it("rejects link-local / cloud-metadata hosts unless explicitly allowlisted", () => {
    expect(validateGhesOrigin("http://169.254.169.254", allow).ok).toBe(false);
    expect(validateGhesOrigin("http://localhost", allow).ok).toBe(false);
  });

  it("rejects a malformed origin", () => {
    expect(validateGhesOrigin("not a url", allow).ok).toBe(false);
    expect(validateGhesOrigin("ghe.acme.com", allow).ok).toBe(false);
  });

  it("rejects everything when the allowlist is empty (cloud still allowed)", () => {
    expect(validateGhesOrigin("https://ghe.acme.com", []).ok).toBe(false);
    expect(validateGhesOrigin("", []).ok).toBe(true);
  });

  it("matches a port-bearing allowlist entry only with the same port", () => {
    expect(validateGhesOrigin("https://ghe.internal", allow).ok).toBe(false);
    expect(validateGhesOrigin("https://ghe.internal:9999", allow).ok).toBe(false);
  });
});
