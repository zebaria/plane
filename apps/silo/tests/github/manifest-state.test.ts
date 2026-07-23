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

import { decodeManifestState, encodeManifestState } from "@/github/oauth";

describe("decodeManifestState", () => {
  it("reads a bare env as cloud (no ghesBaseUrl/workspace)", () => {
    expect(decodeManifestState(encodeManifestState("prod"))).toEqual({
      env: "prod",
      ghesBaseUrl: undefined,
      workspaceSlug: undefined,
      userId: undefined,
    });
  });

  it("returns an empty env for malformed/garbage state", () => {
    expect(decodeManifestState("not-base64url-json!!!").env).toBe("");
    expect(decodeManifestState("").env).toBe("");
  });
});

describe("manifest state round-trip", () => {
  it("survives encode → decode for cloud", () => {
    expect(decodeManifestState(encodeManifestState("local"))).toEqual({
      env: "local",
      ghesBaseUrl: undefined,
      workspaceSlug: undefined,
      userId: undefined,
    });
  });

  it("survives encode → decode for GHES, including a port and trailing path", () => {
    const host = "https://ghe.acme.com:8443";
    expect(decodeManifestState(encodeManifestState("prod", { ghesBaseUrl: host }))).toEqual({
      env: "prod",
      ghesBaseUrl: host,
      workspaceSlug: undefined,
      userId: undefined,
    });
  });

  it("preserves a host with characters that previously collided with the delimiter", () => {
    const host = "https://ghe.acme.com/path?a=b";
    expect(decodeManifestState(encodeManifestState("dev", { ghesBaseUrl: host }))).toEqual({
      env: "dev",
      ghesBaseUrl: host,
      workspaceSlug: undefined,
      userId: undefined,
    });
  });

  it("carries workspace context (one-press connect) through the round-trip", () => {
    const state = encodeManifestState("dev", {
      ghesBaseUrl: "https://ghe.acme.com",
      workspaceSlug: "my-workspace",
      userId: "user-123",
    });
    expect(decodeManifestState(state)).toEqual({
      env: "dev",
      ghesBaseUrl: "https://ghe.acme.com",
      workspaceSlug: "my-workspace",
      userId: "user-123",
    });
  });
});
