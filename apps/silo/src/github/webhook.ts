/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GitHub webhook receiver.
 *   POST /silo/api/github-webhook
 *
 * GitHub posts JSON with X-Hub-Signature-256 (HMAC-SHA256 of the
 * raw body keyed by `webhook_secret`) and X-GitHub-Event naming
 * the event type. We must:
 *
 *   1. Verify signature against `webhook_secret` from
 *      `/<env>/plane-github`.
 *   2. Ack 200 fast (GitHub retries on >10s).
 *   3. Dispatch async by event type.
 *
 * Phase 4d ships the receiver skeleton + log-only handlers for
 * every event we'll eventually care about. Specific handlers
 * (issues, issue_comment, pull_request, lifecycle) are wired into
 * this dispatcher in subsequent commits.
 */

import type { Request, Response, Router } from "express";
import express from "express";

import { getGithubConfig } from "../config";
import { handleIssueCommentEvent, type IssueCommentPayload } from "./handlers/issue-comment";
import { handleIssuesEvent, type IssuesPayload } from "./handlers/issues";
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  handleRepositoryEvent,
} from "./handlers/lifecycle";
import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  type PullRequestPayload,
  type PullRequestReviewPayload,
} from "./handlers/pull-request";
import { verifyGithubSignature } from "./signature";

type GithubEventName =
  | "ping"
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review"
  | "label"
  | "repository"
  | "installation"
  | "installation_repositories";

type GenericPayload = Record<string, unknown> & { action?: string };

const dispatchEvent = (eventName: string, deliveryId: string, payload: GenericPayload): void => {
  const action = payload.action ?? "";
  switch (eventName as GithubEventName) {
    case "ping":
      console.log(`[silo] github ping delivery=${deliveryId}`);
      return;
    case "issues":
      void handleIssuesEvent(payload as unknown as IssuesPayload).catch((err) => {
        console.error("[silo] issues handler crashed:", err);
      });
      return;
    case "issue_comment":
      void handleIssueCommentEvent(payload as unknown as IssueCommentPayload).catch((err) => {
        console.error("[silo] issue_comment handler crashed:", err);
      });
      return;
    case "pull_request":
      void handlePullRequestEvent(payload as unknown as PullRequestPayload).catch((err) => {
        console.error("[silo] pull_request handler crashed:", err);
      });
      return;
    case "pull_request_review":
      void handlePullRequestReviewEvent(payload as unknown as PullRequestReviewPayload).catch((err) => {
        console.error("[silo] pull_request_review handler crashed:", err);
      });
      return;
    case "installation":
      void handleInstallationEvent(payload as unknown as Parameters<typeof handleInstallationEvent>[0]).catch((err) => {
        console.error("[silo] installation handler crashed:", err);
      });
      return;
    case "installation_repositories":
      void handleInstallationRepositoriesEvent(
        payload as unknown as Parameters<typeof handleInstallationRepositoriesEvent>[0]
      ).catch((err) => {
        console.error("[silo] installation_repositories handler crashed:", err);
      });
      return;
    case "repository":
      void handleRepositoryEvent(payload as unknown as Parameters<typeof handleRepositoryEvent>[0]).catch((err) => {
        console.error("[silo] repository handler crashed:", err);
      });
      return;
    case "label":
      // Label CRUD — no-op for v1; we don't cache GH labels yet.
      return;
    default:
      console.log(`[silo] github unhandled event=${eventName} action=${action} delivery=${deliveryId}`);
  }
};

export const githubWebhookRouter = (): Router => {
  const r = express.Router();

  r.post(
    "/api/github-webhook",
    express.raw({ type: "application/json", limit: "5mb" }),
    (req: Request, res: Response) => {
      const cfg = getGithubConfig();
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const sig = req.header("x-hub-signature-256") ?? undefined;
      const eventName = req.header("x-github-event") ?? "";
      const deliveryId = req.header("x-github-delivery") ?? "";

      const verdict = verifyGithubSignature(cfg.webhookSecret, rawBody, sig);
      if (!verdict.ok) {
        console.warn(`[silo] github webhook sig fail: ${verdict.reason} event=${eventName} delivery=${deliveryId}`);
        res.status(verdict.status).type("text/plain").send(verdict.reason);
        return;
      }

      let payload: GenericPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as GenericPayload;
      } catch {
        res.status(400).type("text/plain").send("invalid json");
        return;
      }

      // Ack first; dispatch async. GitHub retries any delivery that
      // takes longer than 10s, so we don't want handler work in the
      // request lifecycle even when it's quick.
      res.status(200).end();

      try {
        dispatchEvent(eventName, deliveryId, payload);
      } catch (err) {
        console.error("[silo] github dispatchEvent crashed:", err);
      }
    }
  );

  return r;
};
