/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack interactivity webhook (modal submits, block actions, message
 * shortcuts).
 *   POST /silo/api/slack/interactions
 *
 * Slack sends `application/x-www-form-urlencoded` with one field
 * `payload` (JSON-encoded). HMAC verification needs the raw body, so
 * this router uses `express.raw()` like the slash command route.
 *
 * Slack expects a 200 within 3 seconds. For `view_submission`, the
 * response body is significant: `{}` closes the modal, `{response_action:
 * "errors", errors: {...}}` shows inline field errors, and so on.
 * We keep the create-work-item path synchronous since Plane's create
 * is fast; if it grows past the 3s budget we'll switch to a
 * `response_action: "clear"` ack + async post via chat.postMessage.
 */

import type { Request, Response, Router } from "express";
import express from "express";

import { getSlackConfig } from "../config";
import { callDjango } from "../django-client";
import { asyncHandler } from "../express-async";
import { callSlackApiForTeam } from "./api";
import {
  CREATE_WORK_ITEM_CALLBACK,
  PROJECT_SELECT_ACTION,
  buildCreateWorkItemView,
  type CreateWorkItemMetadata,
} from "./modal";
import { fetchProjectMetadata } from "./project-metadata";
import { verifySlackSignature } from "./signature";
import { resolveTeamContext } from "./team-context";

type SlackSelectedOption = { value: string };
type SlackInputState = {
  value?: string;
  selected_option?: SlackSelectedOption;
  selected_options?: SlackSelectedOption[];
};

type SlackViewSubmission = {
  type: "view_submission";
  team: { id: string };
  user: { id: string };
  view: {
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, SlackInputState>> };
  };
};

type SlackBlockActions = {
  type: "block_actions";
  team: { id: string };
  user: { id: string };
  trigger_id: string;
  view?: {
    id: string;
    hash?: string;
    callback_id: string;
    private_metadata: string;
  };
  actions: {
    action_id: string;
    block_id?: string;
    value?: string;
    selected_option?: SlackSelectedOption;
  }[];
};

type ViewSubmitResponse = Record<string, unknown>;

const REPLY_COMMENT_CALLBACK = "plane_reply_comment_modal";

// HTML-entity-style escape; same form Slack mrkdwn expects for `<`, `>`, `&`
// and what HTML requires for embedded text in `<p>...</p>`.
const slackEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type ReplyCommentMetadata = {
  workspace_slug: string;
  project_id: string;
  issue_id: string;
  project_identifier: string;
  sequence_id: number;
  issue_name: string;
};

const handleCreateWorkItem = async (payload: SlackViewSubmission): Promise<ViewSubmitResponse> => {
  const teamId = payload.team.id;
  const slackUserId = payload.user.id;

  let metadata: CreateWorkItemMetadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata) as CreateWorkItemMetadata;
  } catch {
    return errorResponse({ project: "Modal metadata corrupt — try again" });
  }

  const values = payload.view.state.values;
  const projectId = values.project?.project_id?.selected_option?.value;
  const title = (values.title?.title?.value ?? "").trim();
  const description = (values.description?.description?.value ?? "").trim();
  const typeId = values.type?.type_id?.selected_option?.value;
  const stateId = values.state?.state_id?.selected_option?.value;
  const priority = values.priority?.priority?.selected_option?.value;
  const labelIds = (values.labels?.label_ids?.selected_options ?? []).map((o) => o.value);
  const assigneeIds = (values.assignees?.assignee_ids?.selected_options ?? []).map((o) => o.value);

  if (!projectId) {
    return errorResponse({ project: "Pick a project" });
  }
  if (!title) {
    return errorResponse({ title: "Enter a title" });
  }

  const ctx = await resolveTeamContext(teamId);
  if (!ctx) {
    return errorResponse({ project: "Slack workspace not connected to Plane" });
  }

  // Django resolves actor in priority order: explicit actor_user_id,
  // else slack_user_id → WorkspaceUserConnection, else slack_team_id
  // → installer. We pass slack_user_id + slack_team_id and let
  // Django decide.
  let r;
  try {
    r = await callDjango<{
      id: string;
      sequence_id: number;
      project_identifier: string;
      name: string;
      url: string;
    }>("POST", "/api/v1/silo/work-items/", {
      workspace_slug: metadata.workspaceSlug,
      project_id: projectId,
      title,
      description,
      slack_user_id: slackUserId,
      slack_team_id: teamId,
      type_id: typeId,
      state_id: stateId,
      priority,
      label_ids: labelIds,
      assignee_ids: assigneeIds,
    });
  } catch (err) {
    console.error("[silo] work-item create network error:", err);
    return errorResponse({ title: "Could not reach Plane — try again" });
  }

  if (r.status >= 300) {
    console.error(`[silo] work-item create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return errorResponse({ title: `Plane rejected the request (${r.status})` });
  }

  // Modal closes; post an ephemeral confirmation in the channel the
  // user was in when they ran the command.
  const issue = r.data;
  const issueLabel = `${issue.project_identifier}-${issue.sequence_id}`;
  void callSlackApiForTeam("chat.postEphemeral", teamId, {
    channel: metadata.channelId,
    user: slackUserId,
    text: `Created *${issueLabel}* — ${issue.name}`,
  }).catch((err) => {
    console.error("[silo] postEphemeral failed:", err);
  });

  return {};
};

const errorResponse = (errors: Record<string, string>): ViewSubmitResponse => ({
  response_action: "errors",
  errors,
});

const handleProjectChange = async (payload: SlackBlockActions): Promise<void> => {
  const teamId = payload.team.id;
  const view = payload.view;
  const action = payload.actions?.[0];
  const newProjectId = action?.selected_option?.value;
  if (!view || !newProjectId) return;

  let metadata: CreateWorkItemMetadata;
  try {
    metadata = JSON.parse(view.private_metadata) as CreateWorkItemMetadata;
  } catch {
    console.warn("[silo] project change: bad private_metadata");
    return;
  }

  const ctx = await resolveTeamContext(teamId);
  if (!ctx) return;

  let projectMeta = null;
  try {
    projectMeta = await fetchProjectMetadata(ctx.workspaceSlug, newProjectId);
  } catch (err) {
    console.warn("[silo] project-metadata fetch on change failed:", err);
  }

  const updated = buildCreateWorkItemView(
    ctx.projects,
    metadata,
    newProjectId,
    projectMeta,
    metadata.initialText ?? ""
  );

  const result = await callSlackApiForTeam("views.update", teamId, {
    view_id: view.id,
    hash: view.hash,
    view: updated,
  });
  if (!result || !result.ok) {
    console.error(`[silo] views.update on project change failed: ${result?.error ?? "no-team-context"}`);
  }
};

const handleReplyButton = async (payload: SlackBlockActions): Promise<void> => {
  const teamId = payload.team.id;
  const triggerId = payload.trigger_id;
  const action = payload.actions[0];
  if (!action || !action.value) return;

  let metadata: ReplyCommentMetadata;
  try {
    metadata = JSON.parse(action.value) as ReplyCommentMetadata;
  } catch {
    console.warn("[silo] reply button: bad metadata", action.value);
    return;
  }

  const view = {
    type: "modal",
    callback_id: REPLY_COMMENT_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Reply" },
    submit: { type: "plain_text", text: "Post" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Reply to *${slackEscape(metadata.project_identifier)}-${metadata.sequence_id}: ${slackEscape(metadata.issue_name)}*`,
          },
        ],
      },
      {
        type: "input",
        block_id: "comment",
        label: { type: "plain_text", text: "Comment" },
        element: {
          type: "plain_text_input",
          action_id: "comment",
          multiline: true,
        },
      },
    ],
  };

  const result = await callSlackApiForTeam("views.open", teamId, {
    trigger_id: triggerId,
    view,
  });
  if (!result || !result.ok) {
    console.error(`[silo] reply views.open failed: ${result?.error ?? "no-team-context"}`);
  }
};

const handleReplyCommentSubmit = async (payload: SlackViewSubmission): Promise<ViewSubmitResponse> => {
  const slackUserId = payload.user.id;
  const teamId = payload.team.id;

  let metadata: ReplyCommentMetadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata) as ReplyCommentMetadata;
  } catch {
    return errorResponse({ comment: "Modal metadata corrupt — try again" });
  }

  const text = (payload.view.state.values.comment?.comment?.value ?? "").trim();
  if (!text) {
    return errorResponse({ comment: "Comment cannot be empty" });
  }

  // Plane stores comment_html — wrap plain text in a paragraph the
  // editor can round-trip. Slack's plain_text_input doesn't preserve
  // formatting; if we add a richer composer later, swap to
  // rich_text_input + a Slack-mrkdwn → HTML converter.
  const commentHtml = `<p>${text.split("\n").map(slackEscape).join("</p><p>")}</p>`;

  let r;
  try {
    r = await callDjango<{ id: string }>("POST", "/api/v1/silo/comments/", {
      workspace_slug: metadata.workspace_slug,
      project_id: metadata.project_id,
      issue_id: metadata.issue_id,
      comment_html: commentHtml,
      slack_user_id: slackUserId,
      slack_team_id: teamId,
    });
  } catch (err) {
    console.error("[silo] comment create network error:", err);
    return errorResponse({ comment: "Could not reach Plane — try again" });
  }

  if (r.status >= 300) {
    console.error(`[silo] comment create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return errorResponse({ comment: `Plane rejected the comment (${r.status})` });
  }
  return {};
};

export const slackInteractionsRouter = (): Router => {
  const r = express.Router();

  // asyncHandler wrap: see ../express-async.ts (Express 4 doesn't
  // forward rejected promises from async handlers).
  r.post(
    "/api/slack/interactions",
    express.raw({ type: "application/x-www-form-urlencoded", limit: "5mb" }),
    asyncHandler(async (req: Request, res: Response) => {
      const slack = getSlackConfig();
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const ts = req.header("x-slack-request-timestamp") ?? undefined;
      const sig = req.header("x-slack-signature") ?? undefined;

      console.log(`[silo] interactions hit: bodyLen=${rawBody.length} hasTs=${!!ts} hasSig=${!!sig}`);

      const verdict = verifySlackSignature(slack.signingSecret, rawBody, ts, sig);
      if (!verdict.ok) {
        console.warn(`[silo] interactions sig fail: ${verdict.reason}`);
        res.status(verdict.status).type("text/plain").send(verdict.reason);
        return;
      }

      const params = new URLSearchParams(rawBody.toString("utf8"));
      const payloadJson = params.get("payload") ?? "";
      let payload: { type: string; [k: string]: unknown };
      try {
        const parsed = JSON.parse(payloadJson);
        if (!parsed || typeof parsed !== "object") {
          res.status(400).type("text/plain").send("invalid payload JSON");
          return;
        }
        payload = parsed;
        console.log(
          `[silo] interactions payload type=${payload.type} action_id=${(payload as unknown as SlackBlockActions).actions?.[0]?.action_id ?? "n/a"}`
        );
      } catch {
        res.status(400).type("text/plain").send("invalid payload JSON");
        return;
      }

      try {
        if (payload.type === "view_submission") {
          const view = (payload as SlackViewSubmission).view;
          if (view?.callback_id === CREATE_WORK_ITEM_CALLBACK) {
            const out = await handleCreateWorkItem(payload as SlackViewSubmission);
            res.status(200).json(out);
            return;
          }
          if (view?.callback_id === REPLY_COMMENT_CALLBACK) {
            const out = await handleReplyCommentSubmit(payload as SlackViewSubmission);
            res.status(200).json(out);
            return;
          }
        }
        if (payload.type === "block_actions") {
          const ba = payload as SlackBlockActions;
          const action = ba.actions?.[0];
          if (action?.action_id === PROJECT_SELECT_ACTION) {
            res.status(200).end();
            handleProjectChange(ba).catch((err) => {
              console.error("[silo] project change handler crashed:", err);
            });
            return;
          }
          if (action?.action_id === "plane_reply_comment") {
            // Ack first, do work async (views.open is fast but we
            // stay consistent with the slash command pattern).
            res.status(200).end();
            handleReplyButton(ba).catch((err) => {
              console.error("[silo] reply button handler crashed:", err);
            });
            return;
          }
        }
      } catch (err) {
        console.error("[silo] interaction handler crashed:", err);
        res.status(200).json(errorResponse({ title: "Unexpected error — try again" }));
        return;
      }

      // Unknown interaction type — ack with an empty 200 so Slack
      // doesn't retry. We'll add handlers (shortcut, etc.) as their
      // flows ship.
      console.log(`[silo] unhandled interaction type: ${payload.type}`);
      res.status(200).end();
    })
  );

  return r;
};
