/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Verifies the X-Hub-Signature-256 header on inbound GitHub
 * webhook deliveries. Scheme:
 *   sig = "sha256=" + hex(HMAC_SHA256(webhook_secret, raw_body))
 *
 * Ref: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type GithubVerifyResult = { ok: true } | { ok: false; status: number; reason: string };

export const verifyGithubSignature = (
  webhookSecret: string,
  rawBody: Buffer,
  signature: string | undefined
): GithubVerifyResult => {
  if (!signature) {
    return { ok: false, status: 401, reason: "missing signature header" };
  }
  if (!signature.startsWith("sha256=")) {
    return { ok: false, status: 401, reason: "bad signature scheme" };
  }
  const expected = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "invalid signature" };
  }
  return { ok: true };
};
