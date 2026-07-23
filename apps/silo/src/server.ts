/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";

import { config } from "./config";
import { callDjango } from "./django-client";
import { bootstrapIntegrations, mountIntegrations } from "./integrations";
import { notificationsRouter } from "./notifications";

export function createApp(configuredIntegrations: Set<string> = new Set()): Express {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: (process.env.SILO_CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3001")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      credentials: false,
    })
  );
  // Webhook routes need the raw body for HMAC verification. The
  // per-route `express.raw()` middleware in slack/{commands,interactions,events}.ts
  // and github/webhook.ts can only see a Buffer if the body hasn't
  // been consumed yet — so skip the global JSON parser on those
  // paths. Each route handler installs its own raw parser scoped to
  // its content-type.
  const SLACK_RAW_PATHS = new Set([
    `${config.basePath}/api/slack/commands`,
    `${config.basePath}/api/slack/interactions`,
    `${config.basePath}/api/slack/events`,
    `${config.basePath}/api/notifications/work-item-event`,
    `${config.basePath}/api/github-webhook`,
  ]);
  const jsonParser = express.json({ limit: "5mb" });
  app.use((req, res, next) => {
    // Normalize trailing slash — a webhook hit with `/api/slack/commands/`
    // would otherwise miss the set, get JSON-parsed, and fail HMAC verify.
    const cleanPath = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
    if (SLACK_RAW_PATHS.has(cleanPath)) return next();
    return jsonParser(req, res, next);
  });

  const router = express.Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "silo", version: "0.1.0" });
  });

  router.get("/django-ping", async (_req: Request, res: Response) => {
    try {
      const r = await callDjango("GET", "/api/v1/silo/ping/");
      res.status(r.status).json({ status: r.status, data: r.data });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Notifications (outbound dispatch) is always available — it gates per
  // event on live mapping types, not on a single provider being set up.
  router.use(notificationsRouter());

  // Bootstrap routes mount UNCONDITIONALLY — they're the cold-start
  // paths (e.g. GitHub's App-manifest flow) that create the secret an
  // integration's load()/mount() gate on. Gating these on "configured"
  // would deadlock: you could never set up an unconfigured integration.
  bootstrapIntegrations(router);

  // Each integration mounts its own routes, but only if it loaded
  // successfully at startup. An unconfigured integration's endpoints
  // simply don't exist (404) rather than erroring — "not set up" isn't a
  // failure state. See integrations.ts.
  mountIntegrations(router, configuredIntegrations);

  app.use(config.basePath, router);
  return app;
}
