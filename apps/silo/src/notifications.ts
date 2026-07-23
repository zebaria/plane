/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Inbound: Plane Django → silo, work-item lifecycle events fanned out to
 * each integration's outbound dispatcher.
 *
 *   POST /silo/api/notifications/work-item-event
 *
 * Authenticated via the same silo↔Django HMAC scheme used in the other
 * direction. Django signs with the shared SILO_HMAC_SECRET_KEY; we verify
 * here. Payload shape — see plane/bgtasks/silo_notification_task.py.
 *
 * This router is integration-agnostic: it verifies, parses, acks, and
 * hands the event to every registered dispatcher (see integrations.ts).
 * Each dispatcher gates itself on the event's live_mapping_types.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Request, Response, Router } from "express";
import express from "express";

import { config } from "./config";
import type { WorkItemEvent } from "./events";
import { integrationDispatchers } from "./integrations";

const NOTIFICATION_PATH = "/api/notifications/work-item-event";
const HMAC_SKEW_SECONDS = 5 * 60;

const verifyDjangoHmac = (
  rawBody: Buffer,
  method: string,
  pathFromDjango: string,
  ts: string | undefined,
  sig: string | undefined
): { ok: true } | { ok: false; status: number; reason: string } => {
  if (!ts || !sig) return { ok: false, status: 401, reason: "missing signature headers" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, status: 401, reason: "bad timestamp" };
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > HMAC_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: "timestamp skew too large" };
  }
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const msg = `${ts}.${method.toUpperCase()}.${pathFromDjango}.${bodyHash}`;
  const expected = createHmac("sha256", config.hmacSecret).update(msg).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 403, reason: "invalid signature" };
  }
  return { ok: true };
};

const runDispatchers = async (event: WorkItemEvent, webBaseUrl: string): Promise<void> => {
  // Each integration gates itself on `live_mapping_types`. Run them in
  // parallel — a slow GitHub call shouldn't block the Slack post, and a
  // Slack post failure shouldn't block the GH mirror. Dispatchers come
  // from the integration registry, so this stays untouched as
  // integrations are added.
  await Promise.all(
    integrationDispatchers()
      .filter((d) => event.live_mapping_types?.includes(d.mappingType))
      .map(async (d) => {
        try {
          await d.dispatch(event, webBaseUrl);
        } catch (err) {
          console.error(`[silo] dispatcher ${d.name} crashed:`, err);
        }
      })
  );
};

export const notificationsRouter = (): Router => {
  const r = express.Router();

  r.post(NOTIFICATION_PATH, express.raw({ type: "application/json", limit: "5mb" }), (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const ts = req.header("x-silo-timestamp") ?? undefined;
    const sig = req.header("x-silo-signature") ?? undefined;

    console.log(`[silo] notifications hit: bodyLen=${rawBody.length} hasTs=${!!ts} hasSig=${!!sig}`);

    // Django signs against the path it sees (full /silo/... path).
    const fullPath = `${config.basePath}${NOTIFICATION_PATH}`;
    const verdict = verifyDjangoHmac(rawBody, "POST", fullPath, ts, sig);
    if (!verdict.ok) {
      console.warn(`[silo] notifications sig fail: ${verdict.reason}`);
      res.status(verdict.status).type("text/plain").send(verdict.reason);
      return;
    }

    let event: WorkItemEvent;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        res.status(400).type("text/plain").send("invalid payload");
        return;
      }
      event = parsed as WorkItemEvent;
    } catch {
      res.status(400).type("text/plain").send("invalid json");
      return;
    }

    console.log(
      `[silo] notifications event_type=${event.event_type ?? "?"} project=${event.project_id ?? "?"} issue=${event.issue?.id ?? "?"}`
    );

    // Ack immediately; do work async.
    res.status(200).end();

    // Outbound message links MUST use a publicly resolvable URL —
    // Slack's renderers click them. Prefer PLANE_PUBLIC_URL (the
    // tunnel/ALB hostname); fall back to WEB_BASE_URL for envs where
    // they're the same.
    const webBaseUrl = process.env.PLANE_PUBLIC_URL ?? process.env.WEB_BASE_URL ?? "http://localhost:3000";
    runDispatchers(event, webBaseUrl).catch((err) => {
      console.error("[silo] notifications dispatch crashed:", err);
    });
  });

  return r;
};
