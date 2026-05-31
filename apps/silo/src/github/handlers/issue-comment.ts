/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * `issue_comment` event handler.
 *
 *   action=created → Plane comment on the linked work item.
 *   action=edited  → patch the linked Plane comment.
 *   action=deleted → delete the linked Plane comment.
 *
 * Comment links are stored on the `WorkspaceEntityConnection.config`
 * for the issue link as a map `{gh_comment_id: plane_comment_id}`.
 * We avoid a dedicated table for v1 — the volume is bounded by the
 * issue's lifetime and the JSON column already lives on the link
 * row. If this becomes a perf problem, promote to its own type.
 */

/* Sequential awaits in this handler are deliberate: each iteration is
 * an ordered, rate-limit-friendly write to GitHub/Django over a small,
 * bounded set. Matches the project convention for webhook handlers. */
/* eslint-disable no-await-in-loop */

import { marked } from "marked";

import { convertTaskLists } from "../markdown";

import { callDjango } from "../../django-client";
import {
  createPlaneComment,
  deletePlaneComment,
  editPlaneComment,
  fetchRepoBindings,
  lookupIssueLink,
  type RepoBinding,
} from "../django";

type GhUser = { login: string; id: number; type?: string };
type GhRepo = { id: number; full_name: string; name: string };
type GhIssue = { id: number; number: number; pull_request?: unknown };
type GhComment = { id: number; body: string | null; user: GhUser };

export type IssueCommentPayload = {
  action: "created" | "edited" | "deleted";
  issue: GhIssue;
  comment: GhComment;
  repository: GhRepo;
  installation?: { id: number };
  sender?: GhUser;
};

const renderCommentHtml = (comment: GhComment): string => {
  const body = comment.body ?? "";
  const html = body ? convertTaskLists(marked.parse(body, { async: false, gfm: true, breaks: true }) as string) : "";
  return `${html}<p><em>via GitHub @${comment.user.login}</em></p>`;
};

const getLinkConfig = async (linkId: string): Promise<Record<string, unknown>> => {
  // No GET endpoint by id (we don't need one elsewhere). Re-using
  // lookupIssueLink would require keying on gh_issue_id which we
  // already have from the payload — the caller passes the link
  // object instead. This wrapper exists for future expansion.
  void linkId;
  return {};
};

const updateLinkConfig = async (
  workspaceConnectionId: string,
  projectId: string,
  ghIssueId: number,
  ghIssueNumber: number,
  ghRepoFullName: string,
  planeIssueId: string,
  planeProjectId: string,
  commentMap: Record<string, string>
): Promise<void> => {
  // Issue-link upsert preserves the row; we tunnel comment_map
  // through entity_data so the Django endpoint keeps it on
  // `entity_data.gh_comment_map`. Callers must pass the merged
  // map (we don't expose a partial-merge mutation server-side).
  await callDjango("POST", "/api/v1/silo/github/issue-link/", {
    workspace_connection_id: workspaceConnectionId,
    project_id: projectId,
    gh_issue_id: String(ghIssueId),
    gh_issue_number: ghIssueNumber,
    gh_repo_full_name: ghRepoFullName,
    plane_issue_id: planeIssueId,
    plane_project_id: planeProjectId,
    gh_comment_map: commentMap,
  });
};

const dispatchForBinding = async (binding: RepoBinding, payload: IssueCommentPayload): Promise<void> => {
  if (!binding.project_id) return;
  const link = await lookupIssueLink(payload.issue.id, binding.workspace_connection_id);
  if (!link || !link.plane_issue_id) return;

  const commentMap = ((link.entity_data as { gh_comment_map?: Record<string, string> })?.gh_comment_map ??
    {}) as Record<string, string>;
  const ghCommentId = String(payload.comment.id);
  const linkedPlaneCommentId = commentMap[ghCommentId];

  if (payload.action === "created") {
    if (linkedPlaneCommentId) return; // idempotent on retry
    const created = await createPlaneComment({
      workspaceSlug: binding.workspace_slug,
      projectId: binding.project_id,
      issueId: link.plane_issue_id,
      commentHtml: renderCommentHtml(payload.comment),
      ghUserLogin: payload.comment.user.login,
    });
    if (!created) return;
    commentMap[ghCommentId] = created.id;
    await updateLinkConfig(
      binding.workspace_connection_id,
      binding.project_id,
      payload.issue.id,
      payload.issue.number,
      payload.repository.full_name,
      link.plane_issue_id,
      binding.project_id,
      commentMap
    );
    return;
  }

  if (!linkedPlaneCommentId) {
    // Edit / delete on a comment we never mirrored (e.g. binding
    // added after the comment existed). Skip.
    return;
  }

  if (payload.action === "edited") {
    await editPlaneComment(linkedPlaneCommentId, renderCommentHtml(payload.comment), {
      workspaceSlug: binding.workspace_slug,
      issueId: link.plane_issue_id,
    });
    return;
  }

  if (payload.action === "deleted") {
    await deletePlaneComment(linkedPlaneCommentId, {
      workspaceSlug: binding.workspace_slug,
      issueId: link.plane_issue_id,
    });
    delete commentMap[ghCommentId];
    await updateLinkConfig(
      binding.workspace_connection_id,
      binding.project_id,
      payload.issue.id,
      payload.issue.number,
      payload.repository.full_name,
      link.plane_issue_id,
      binding.project_id,
      commentMap
    );
  }
};

export const handleIssueCommentEvent = async (payload: IssueCommentPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  if (!installationId || !repoId) return;
  // PR review comments arrive on the same `issue_comment` channel
  // when posted via the issue-style UI. Skip — they're handled in
  // the pull_request stream.
  if (payload.issue?.pull_request) return;

  // Echo guard: every comment silo posts to GH uses the installation
  // token, which presents as `<app-name>[bot]` (`user.type === "Bot"`).
  // If we mirror that back into Plane it loops — Plane comment fires
  // outbound, which fires inbound, which fires outbound. Drop bot
  // comments at ingress. Still allow real users posting from a
  // different bot account by checking the suffix too.
  const u = payload.comment?.user;
  if (u?.type === "Bot" || (u?.login ?? "").endsWith("[bot]")) {
    console.log(`[silo] skip bot-authored comment from ${u?.login}`);
    return;
  }

  const bindings = await fetchRepoBindings(installationId, repoId);
  for (const binding of bindings) {
    try {
      await dispatchForBinding(binding, payload);
    } catch (err) {
      console.error(`[silo] issue_comment crashed for binding=${binding.id}:`, err);
    }
  }
};

// Re-exported for typing-only use elsewhere.
export const _internal = { getLinkConfig };
