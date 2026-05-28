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

import axios from "axios";
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
import { lookupWorkItem, parseWorkItemRef } from "./work-items";

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
  channel?: { id: string; name?: string };
  response_url?: string;
  view?: {
    id: string;
    hash?: string;
    callback_id: string;
    private_metadata: string;
    state?: { values: Record<string, Record<string, SlackInputState>> };
  };
  actions: {
    action_id: string;
    block_id?: string;
    value?: string;
    selected_option?: SlackSelectedOption;
  }[];
};

type SlackMessageShortcut = {
  type: "message_action";
  callback_id: string;
  trigger_id: string;
  team: { id: string };
  user: { id: string };
  channel: { id: string; name?: string };
  message: {
    ts: string;
    text?: string;
    user?: string;
    [k: string]: unknown;
  };
  message_ts?: string;
  response_url?: string;
};

type ViewSubmitResponse = Record<string, unknown>;

const REPLY_COMMENT_CALLBACK = "plane_reply_comment_modal";
const CHANGE_STATE_CALLBACK = "plane_change_state_modal";

// Slack-app-side shortcut callback_ids — must match what's configured
// in the Slack app's Interactivity → Shortcuts → "On messages" list.
const CREATE_FROM_MESSAGE_CALLBACK = "plane_create_from_message";
const LINK_TO_MESSAGE_CALLBACK = "plane_link_to_message";

// Modal callback_id for the "Link existing work item to this message"
// view. The shortcut opens the modal; submission posts a comment with
// the Slack permalink onto the resolved work item.
const LINK_TO_MESSAGE_VIEW_CALLBACK = "plane_link_to_message_modal";

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
  const asIntake = (values.as_intake?.as_intake?.selected_options ?? []).length > 0;

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
      as_intake: asIntake,
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
    text: asIntake ? `Created *${issueLabel}* in Intake — ${issue.name}` : `Created *${issueLabel}* — ${issue.name}`,
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

  // Preserve whatever the user has already typed — Slack doesn't
  // carry input values across views.update unless we re-render them
  // back into initial_value.
  const stateValues = view.state?.values;
  const currentTitle = stateValues?.title?.title?.value ?? metadata.initialText ?? "";
  const currentDescription = stateValues?.description?.description?.value ?? "";

  const updated = buildCreateWorkItemView(
    ctx.projects,
    metadata,
    newProjectId,
    projectMeta,
    currentTitle,
    currentDescription
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

const handleAssignMe = async (payload: SlackBlockActions): Promise<void> => {
  const teamId = payload.team.id;
  const slackUserId = payload.user.id;
  const action = payload.actions[0];
  if (!action || !action.value) return;

  let metadata: ReplyCommentMetadata;
  try {
    metadata = JSON.parse(action.value) as ReplyCommentMetadata;
  } catch {
    console.warn("[silo] assign-me: bad metadata", action.value);
    return;
  }

  let r;
  try {
    r = await callDjango<{ id: string; assigned?: boolean; already_assigned?: boolean }>(
      "POST",
      "/api/v1/silo/work-items/assignees/",
      {
        workspace_slug: metadata.workspace_slug,
        project_id: metadata.project_id,
        issue_id: metadata.issue_id,
        slack_user_id: slackUserId,
        slack_team_id: teamId,
      }
    );
  } catch (err) {
    console.error("[silo] assign-me network error:", err);
    return;
  }

  // Ephemeral feedback — only the clicker sees it. Channel id comes
  // from the original message context; container.channel_id is on
  // payload but typed loosely, so fall back to payload.channel.
  const channelId = payload.channel?.id;
  if (!channelId) {
    console.warn("[silo] assign-me: no channel in payload");
    return;
  }
  const ref = `${metadata.project_identifier}-${metadata.sequence_id}`;
  let text: string;
  if (r.status === 400 && (r.data as { detail?: string })?.detail?.includes("no Plane account")) {
    text = `Can't assign — your Slack account isn't linked to a Plane user. Run \`/lplane connect\` first.`;
  } else if (r.status === 403) {
    text = `Can't assign — you're not a member of this project.`;
  } else if (r.status >= 300) {
    text = `Plane rejected the assign (${r.status}).`;
  } else if (r.data?.already_assigned) {
    text = `You're already assigned to *${ref}*.`;
  } else {
    text = `Assigned you to *${ref}*.`;
  }
  void callSlackApiForTeam("chat.postEphemeral", teamId, {
    channel: channelId,
    user: slackUserId,
    text,
  }).catch((err) => {
    console.error("[silo] assign-me postEphemeral failed:", err);
  });
};

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

const handleChangeStateButton = async (payload: SlackBlockActions): Promise<void> => {
  const teamId = payload.team.id;
  const triggerId = payload.trigger_id;
  const action = payload.actions[0];
  if (!action || !action.value) return;

  let metadata: ReplyCommentMetadata;
  try {
    metadata = JSON.parse(action.value) as ReplyCommentMetadata;
  } catch {
    console.warn("[silo] change-state: bad metadata", action.value);
    return;
  }

  // Reuse the project-metadata endpoint — it already returns the
  // project's states with their groups and the project's default
  // state. The 60s cache is fine here.
  let meta;
  try {
    meta = await fetchProjectMetadata(metadata.workspace_slug, metadata.project_id);
  } catch (err) {
    console.error("[silo] change-state: project-metadata fetch failed", err);
    return;
  }
  if (meta.states.length === 0) {
    console.warn("[silo] change-state: project has no states");
    return;
  }

  const options = meta.states.map((s) => ({
    text: { type: "plain_text", text: truncate(`${s.name} [${s.group}]`, 75) },
    value: s.id,
  }));

  const view = {
    type: "modal",
    callback_id: CHANGE_STATE_CALLBACK,
    private_metadata: JSON.stringify({ ...metadata, channel_id: payload.channel?.id ?? null }),
    title: { type: "plain_text", text: "Change state" },
    submit: { type: "plain_text", text: "Update" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Move *${slackEscape(metadata.project_identifier)}-${metadata.sequence_id}: ${slackEscape(metadata.issue_name)}*`,
          },
        ],
      },
      {
        type: "input",
        block_id: "state",
        label: { type: "plain_text", text: "New state" },
        element: {
          type: "static_select",
          action_id: "state_id",
          options,
          initial_option: options[0],
        },
      },
    ],
  };

  const result = await callSlackApiForTeam("views.open", teamId, {
    trigger_id: triggerId,
    view,
  });
  if (!result || !result.ok) {
    console.error(`[silo] change-state views.open failed: ${result?.error ?? "no-team-context"}`);
  }
};

type ChangeStateMetadata = ReplyCommentMetadata & { channel_id: string | null };

const handleChangeStateSubmit = async (payload: SlackViewSubmission): Promise<ViewSubmitResponse> => {
  const teamId = payload.team.id;
  const slackUserId = payload.user.id;

  let metadata: ChangeStateMetadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata) as ChangeStateMetadata;
  } catch {
    return errorResponse({ state: "Modal metadata corrupt — try again" });
  }

  const stateId = payload.view.state.values.state?.state_id?.selected_option?.value;
  if (!stateId) {
    return errorResponse({ state: "Pick a state" });
  }

  let r;
  try {
    r = await callDjango<{
      id: string;
      state_id?: string;
      state_name?: string;
      state_group?: string;
      unchanged?: boolean;
    }>("POST", "/api/v1/silo/work-items/state/", {
      workspace_slug: metadata.workspace_slug,
      project_id: metadata.project_id,
      issue_id: metadata.issue_id,
      state_id: stateId,
      slack_user_id: slackUserId,
      slack_team_id: teamId,
    });
  } catch (err) {
    console.error("[silo] change-state network error:", err);
    return errorResponse({ state: "Could not reach Plane — try again" });
  }

  if (r.status >= 300) {
    console.error(`[silo] change-state failed: ${r.status} ${JSON.stringify(r.data)}`);
    return errorResponse({ state: `Plane rejected the request (${r.status})` });
  }

  if (metadata.channel_id) {
    const ref = `${metadata.project_identifier}-${metadata.sequence_id}`;
    const text = r.data.unchanged
      ? `*${ref}* was already in *${r.data.state_name ?? "that state"}*.`
      : `Moved *${ref}* → *${r.data.state_name ?? "updated"}*.`;
    void callSlackApiForTeam("chat.postEphemeral", teamId, {
      channel: metadata.channel_id,
      user: slackUserId,
      text,
    }).catch((err) => {
      console.error("[silo] change-state postEphemeral failed:", err);
    });
  }

  return {};
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

type LinkToMessageMetadata = {
  workspace_slug: string;
  channel_id: string;
  message_ts: string;
  message_excerpt: string;
};

const fetchPermalink = async (teamId: string, channelId: string, messageTs: string): Promise<string | null> => {
  // chat.getPermalink is one of Slack's GET-style methods — it
  // doesn't accept application/json bodies and rejects them with
  // `invalid_arguments`. Use GET with query params instead, signed
  // with the team's bot token.
  try {
    const ctx = await resolveTeamContext(teamId);
    if (!ctx) return null;
    const url = `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channelId)}&message_ts=${encodeURIComponent(messageTs)}`;
    const res = await axios.get<{ ok: boolean; permalink?: string; error?: string }>(url, {
      headers: { Authorization: `Bearer ${ctx.botToken}` },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (!res.data?.ok || !res.data.permalink) {
      console.warn(`[silo] chat.getPermalink failed: ${res.data?.error ?? "unknown"}`);
      return null;
    }
    return res.data.permalink;
  } catch (err) {
    console.warn("[silo] chat.getPermalink network error:", (err as Error).message);
    return null;
  }
};

const handleCreateFromMessage = async (payload: SlackMessageShortcut): Promise<void> => {
  const teamId = payload.team.id;
  const triggerId = payload.trigger_id;
  const channelId = payload.channel.id;
  const userId = payload.user.id;
  const messageText = (payload.message.text ?? "").trim();
  const messageTs = payload.message.ts;

  const ctx = await resolveTeamContext(teamId);
  if (!ctx) {
    console.warn(`[silo] create-from-message: no team context for ${teamId}`);
    return;
  }

  // First non-empty line becomes the title (Slack messages are
  // free-form; full message goes in the description with a permalink
  // back to the source).
  const titleSeed =
    messageText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  const permalink = await fetchPermalink(teamId, channelId, messageTs);
  const descriptionParts = [messageText];
  if (permalink) {
    descriptionParts.push("", `From Slack: ${permalink}`);
  }
  const initialDescription = descriptionParts.join("\n");

  const initialProjectId = ctx.projects[0]?.id ?? null;
  let projectMeta = null;
  if (initialProjectId) {
    try {
      projectMeta = await fetchProjectMetadata(ctx.workspaceSlug, initialProjectId);
    } catch (err) {
      console.warn("[silo] project-metadata fetch in shortcut failed:", err);
    }
  }

  const view = buildCreateWorkItemView(
    ctx.projects,
    {
      workspaceSlug: ctx.workspaceSlug,
      channelId,
      triggerUserId: userId,
      installerUserId: ctx.installerUserId,
      initialText: titleSeed,
    },
    initialProjectId,
    projectMeta,
    titleSeed,
    initialDescription
  );

  const result = await callSlackApiForTeam("views.open", teamId, {
    trigger_id: triggerId,
    view,
  });
  if (!result || !result.ok) {
    console.error(`[silo] create-from-message views.open failed: ${result?.error ?? "no-team-context"}`);
  }
};

const buildLinkToMessageView = (metadata: LinkToMessageMetadata): Record<string, unknown> => ({
  type: "modal",
  callback_id: LINK_TO_MESSAGE_VIEW_CALLBACK,
  private_metadata: JSON.stringify(metadata),
  title: { type: "plain_text", text: "Link work item" },
  submit: { type: "plain_text", text: "Link" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Linking message: _${slackEscape(metadata.message_excerpt)}_`,
        },
      ],
    },
    {
      type: "input",
      block_id: "ref",
      label: { type: "plain_text", text: "Work item" },
      hint: { type: "plain_text", text: "Format: WZ-1234" },
      element: {
        type: "plain_text_input",
        action_id: "ref",
        placeholder: { type: "plain_text", text: "WZ-1234" },
        max_length: 64,
      },
    },
    {
      type: "input",
      block_id: "note",
      optional: true,
      label: { type: "plain_text", text: "Note" },
      hint: {
        type: "plain_text",
        text: "Optional note prepended to the comment posted on the work item.",
      },
      element: {
        type: "plain_text_input",
        action_id: "note",
        multiline: true,
      },
    },
  ],
});

const handleLinkToMessage = async (payload: SlackMessageShortcut): Promise<void> => {
  const teamId = payload.team.id;
  const triggerId = payload.trigger_id;
  const channelId = payload.channel.id;
  const messageTs = payload.message.ts;

  const ctx = await resolveTeamContext(teamId);
  if (!ctx) {
    console.warn(`[silo] link-to-message: no team context for ${teamId}`);
    return;
  }

  const excerpt = (payload.message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);

  const metadata: LinkToMessageMetadata = {
    workspace_slug: ctx.workspaceSlug,
    channel_id: channelId,
    message_ts: messageTs,
    message_excerpt: excerpt || "(no text)",
  };

  const result = await callSlackApiForTeam("views.open", teamId, {
    trigger_id: triggerId,
    view: buildLinkToMessageView(metadata),
  });
  if (!result || !result.ok) {
    console.error(`[silo] link-to-message views.open failed: ${result?.error ?? "no-team-context"}`);
  }
};

const handleLinkToMessageSubmit = async (payload: SlackViewSubmission): Promise<ViewSubmitResponse> => {
  const teamId = payload.team.id;
  const slackUserId = payload.user.id;

  let metadata: LinkToMessageMetadata;
  try {
    metadata = JSON.parse(payload.view.private_metadata) as LinkToMessageMetadata;
  } catch {
    return errorResponse({ ref: "Modal metadata corrupt — try again" });
  }

  const values = payload.view.state.values;
  const ref = (values.ref?.ref?.value ?? "").trim();
  const note = (values.note?.note?.value ?? "").trim();

  const parsed = parseWorkItemRef(ref, metadata.workspace_slug);
  if (!parsed) {
    return errorResponse({ ref: "Use IDENT-NUMBER (e.g. WZ-1234)" });
  }

  let item;
  try {
    item = await lookupWorkItem(parsed);
  } catch (err) {
    console.error("[silo] link-to-message work-item lookup network error:", err);
    return errorResponse({ ref: "Could not reach Plane — try again" });
  }
  if (!item) {
    return errorResponse({ ref: `No work item found matching ${ref}` });
  }

  const permalink = await fetchPermalink(teamId, metadata.channel_id, metadata.message_ts);

  // chat.getPermalink can occasionally fail (deleted message, archived
  // channel, bot lacks channel scope). Without a permalink the comment
  // is just a note — keep going rather than blocking the link.
  const lines: string[] = [];
  if (note) lines.push(slackEscape(note));
  if (permalink) {
    lines.push(`From Slack: <a href="${permalink}">${permalink}</a>`);
  } else {
    lines.push("From Slack (permalink unavailable)");
  }
  if (metadata.message_excerpt) {
    lines.push(`<em>${slackEscape(metadata.message_excerpt)}</em>`);
  }
  const commentHtml = lines.map((l) => `<p>${l}</p>`).join("");

  let r;
  try {
    r = await callDjango<{ id: string }>("POST", "/api/v1/silo/comments/", {
      workspace_slug: item.workspace_slug,
      project_id: item.project_id,
      issue_id: item.id,
      comment_html: commentHtml,
      slack_user_id: slackUserId,
      slack_team_id: teamId,
    });
  } catch (err) {
    console.error("[silo] link-to-message comment create network error:", err);
    return errorResponse({ ref: "Could not reach Plane — try again" });
  }

  if (r.status >= 300) {
    console.error(`[silo] link-to-message comment create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return errorResponse({ ref: `Plane rejected the request (${r.status})` });
  }

  // Confirm in the source channel so the linker (and others on the
  // thread) can see the work item. Ephemeral so we don't add noise.
  void callSlackApiForTeam("chat.postEphemeral", teamId, {
    channel: metadata.channel_id,
    user: slackUserId,
    text: `Linked this message to *${item.project_identifier}-${item.sequence_id}: ${item.name}*`,
  }).catch((err) => {
    console.error("[silo] link-to-message postEphemeral failed:", err);
  });

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
          if (view?.callback_id === CHANGE_STATE_CALLBACK) {
            const out = await handleChangeStateSubmit(payload as SlackViewSubmission);
            res.status(200).json(out);
            return;
          }
          if (view?.callback_id === LINK_TO_MESSAGE_VIEW_CALLBACK) {
            const out = await handleLinkToMessageSubmit(payload as SlackViewSubmission);
            res.status(200).json(out);
            return;
          }
        }
        if (payload.type === "message_action") {
          const ms = payload as unknown as SlackMessageShortcut;
          if (ms.callback_id === CREATE_FROM_MESSAGE_CALLBACK) {
            res.status(200).end();
            handleCreateFromMessage(ms).catch((err) => {
              console.error("[silo] create-from-message handler crashed:", err);
            });
            return;
          }
          if (ms.callback_id === LINK_TO_MESSAGE_CALLBACK) {
            res.status(200).end();
            handleLinkToMessage(ms).catch((err) => {
              console.error("[silo] link-to-message handler crashed:", err);
            });
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
          if (action?.action_id === "plane_assign_me") {
            res.status(200).end();
            handleAssignMe(ba).catch((err) => {
              console.error("[silo] assign-me handler crashed:", err);
            });
            return;
          }
          if (action?.action_id === "plane_change_state") {
            res.status(200).end();
            handleChangeStateButton(ba).catch((err) => {
              console.error("[silo] change-state button handler crashed:", err);
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
