/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4g: the manifest-bootstrap state is the only carrier for the
 * GHES host through GitHub's redirect — GitHub echoes `?state=` back
 * to us unchanged. If encode/decode don't round-trip, a GHES install
 * silently converts the manifest against api.github.com instead of
 * the customer's instance, so these cases pin the contract.
 */

import { describe, expect, it } from "vitest";

import { decodeManifestState, encodeManifestState } from "../../src/github/oauth";

describe("encodeManifestState", () => {
  it("returns the bare env for a cloud install (no host)", () => {
    expect(encodeManifestState("prod")).toBe("prod");
    expect(encodeManifestState("dev", undefined)).toBe("dev");
  });

  it("joins env and percent-encoded host with a pipe for GHES", () => {
    expect(encodeManifestState("prod", "https://ghe.acme.com")).toBe("prod|https%3A%2F%2Fghe.acme.com");
  });
});

describe("decodeManifestState", () => {
  it("reads a bare env as cloud (no ghesBaseUrl)", () => {
    expect(decodeManifestState("prod")).toEqual({ env: "prod", ghesBaseUrl: undefined });
  });

  it("splits env and decodes the host for GHES", () => {
    expect(decodeManifestState("dev|https%3A%2F%2Fghe.acme.com")).toEqual({
      env: "dev",
      ghesBaseUrl: "https://ghe.acme.com",
    });
  });
});

describe("manifest state round-trip", () => {
  it("survives encode → decode for cloud", () => {
    expect(decodeManifestState(encodeManifestState("local"))).toEqual({
      env: "local",
      ghesBaseUrl: undefined,
    });
  });

  it("survives encode → decode for GHES, including a port and trailing path", () => {
    const host = "https://ghe.acme.com:8443";
    expect(decodeManifestState(encodeManifestState("prod", host))).toEqual({
      env: "prod",
      ghesBaseUrl: host,
    });
  });

  it("preserves a host with characters that need encoding", () => {
    // A subpath or query in the host would otherwise collide with the
    // `|` delimiter or GitHub's own state handling.
    const host = "https://ghe.acme.com/path?a=b";
    expect(decodeManifestState(encodeManifestState("dev", host))).toEqual({
      env: "dev",
      ghesBaseUrl: host,
    });
  });
});
