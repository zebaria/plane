/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4g FE: normalizeGhesHost is the only sanitization between the
 * admin's free-text GHES hostname and the install URL silo builds. A
 * bad normalization (missing scheme, trailing slash) would produce a
 * GHES origin silo can't append /api/v3 to cleanly.
 */

import { describe, expect, it } from "vitest";

import { normalizeGhesHost } from "@/components/integration/ghes-host";

describe("normalizeGhesHost", () => {
  it("returns empty string for blank / whitespace input", () => {
    expect(normalizeGhesHost("")).toBe("");
    expect(normalizeGhesHost("   ")).toBe("");
  });

  it("prefixes https:// for a bare hostname", () => {
    expect(normalizeGhesHost("ghe.acme.com")).toBe("https://ghe.acme.com");
  });

  it("leaves an explicit https:// origin untouched", () => {
    expect(normalizeGhesHost("https://ghe.acme.com")).toBe("https://ghe.acme.com");
  });

  it("preserves an explicit http:// scheme (does not force https)", () => {
    expect(normalizeGhesHost("http://ghe.internal")).toBe("http://ghe.internal");
  });

  it("strips trailing slashes", () => {
    expect(normalizeGhesHost("https://ghe.acme.com/")).toBe("https://ghe.acme.com");
    expect(normalizeGhesHost("ghe.acme.com///")).toBe("https://ghe.acme.com");
  });

  it("trims surrounding whitespace before normalizing", () => {
    expect(normalizeGhesHost("  ghe.acme.com  ")).toBe("https://ghe.acme.com");
  });

  it("keeps a port", () => {
    expect(normalizeGhesHost("ghe.acme.com:8443")).toBe("https://ghe.acme.com:8443");
  });
});
