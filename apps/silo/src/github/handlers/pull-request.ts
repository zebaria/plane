/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * `pull_request` and `pull_request_review` handlers.
 *
 * Plane parity:
 *   - `[XYZ-123]` in PR title or body → action reference. State of
 *     the linked work item is updated per the PR lifecycle
 *     (opened/draft/review_requested/approved/merged/closed).
 *   - `XYZ-123`   in PR title or body → link-only reference. We
 *     post a single backlink Plane comment on the work item; no
 *     state automation.
 *
 * Phase 4f: the PR state map is now config-driven. Silo asks Django
 * for the resolved 6-key map (workspace default ∪ per-project
 * override) on each event via /silo/github/pr-state-map/. Each key
 * maps to a Plane state_id; a missing key means "leave Plane state
 * alone" for that lifecycle transition.
 *
 * Keys (from the docs):
 *   draft / opened / review_requested / approved /
 *   merged / closed_without_merge
 */

/* Sequential awaits in this handler are deliberate: each iteration is
 * an ordered, rate-limit-friendly write to GitHub/Django over a small,
 * bounded set. Matches the project convention for webhook handlers. */
/* eslint-disable no-await-in-loop */

import { callDjango } from "../../django-client";
import { callGithub } from "../api";
import { fetchRepoBindings, updatePlaneWorkItem, type RepoBinding } from "../django";
import { isBotActor } from "./bot-guard";

export type PrStateKey = "draft" | "opened" | "review_requested" | "approved" | "merged" | "closed_without_merge";

export type PrStateMap = Partial<Record<PrStateKey, string>>;

const fetchPrStateMap = async (workspaceSlug: string, projectId: string): Promise<PrStateMap> => {
  const r = await callDjango<{ map?: PrStateMap }>("POST", "/api/v1/silo/github/pr-state-map/", {
    workspace_slug: workspaceSlug,
    project_id: projectId,
  });
  if (r.status >= 300) return {};
  return r.data?.map ?? {};
};

type GhUser = { login: string; id: number; type?: string };
type GhRepo = { id: number; full_name: string; name: string };
type GhPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  user: GhUser;
  html_url: string;
};

export type PullRequestPayload = {
  action: string;
  pull_request: GhPullRequest;
  repository: GhRepo;
  installation?: { id: number };
  sender?: GhUser;
};

export type PullRequestReviewPayload = {
  action: string;
  review: { state: string; user: GhUser };
  pull_request: GhPullRequest;
  repository: GhRepo;
  installation?: { id: number };
  sender?: GhUser;
};

const ACTION_REF = /\[([A-Z][A-Z0-9]*-\d+)\]/g; // [XYZ-123]
const LINK_REF = /(?<![A-Z0-9[-])([A-Z][A-Z0-9]*-\d+)(?![\]\-A-Z0-9])/g; // bare XYZ-123

type ParsedRefs = { action: Set<string>; linkOnly: Set<string> };

const parseRefs = (text: string): ParsedRefs => {
  const action = new Set<string>();
  const linkOnly = new Set<string>();
  for (const m of text.matchAll(ACTION_REF)) action.add(m[1]);
  // For link-only, drop anything already captured as action.
  for (const m of text.matchAll(LINK_REF)) {
    const ref = m[1];
    if (!action.has(ref)) linkOnly.add(ref);
  }
  return { action, linkOnly };
};

const lookupWorkItem = async (
  workspaceSlug: string,
  ref: string
): Promise<{ id: string; project_id: string; sequence_id: number; project_identifier: string } | null> => {
  const [identifier, seqStr] = ref.split("-");
  if (!identifier || !seqStr) return null;
  const r = await callDjango<{ id: string; project_id: string; sequence_id: number; project_identifier: string }>(
    "POST",
    "/api/v1/silo/work-items/lookup/",
    {
      workspace_slug: workspaceSlug,
      project_identifier: identifier,
      sequence_id: Number(seqStr),
    }
  );
  if (r.status >= 300) return null;
  return r.data;
};

const postPlaneBacklink = async (
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  pr: GhPullRequest,
  ghUserLogin: string | undefined,
  state: string
): Promise<void> => {
  const html = `<p>GitHub PR <a href="${pr.html_url}">#${pr.number} — ${pr.title}</a> · <em>${state}</em></p>`;
  const r = await callDjango("POST", "/api/v1/silo/comments/", {
    workspace_slug: workspaceSlug,
    project_id: projectId,
    issue_id: issueId,
    comment_html: html,
    gh_user_login: ghUserLogin,
  });
  if (r.status >= 300) {
    console.warn(`[silo] PR backlink comment failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

// Resolve a `pull_request` event to one of the 6 PR-state-map keys.
// Returns undefined for actions that don't correspond to any key
// (synchronize, edited, labeled, …) — those leave Plane state alone.
export const prStateKeyForPullRequest = (payload: PullRequestPayload): PrStateKey | undefined => {
  const pr = payload.pull_request;
  const action = payload.action;
  if (action === "closed") return pr.merged ? "merged" : "closed_without_merge";
  if (action === "reopened") return "opened";
  if (action === "ready_for_review") return "review_requested";
  if (action === "review_requested") return "review_requested";
  if (action === "converted_to_draft") return "draft";
  if (action === "opened") return pr.draft ? "draft" : "opened";
  return undefined;
};

// pull_request_review only flips state on approve. "changes_requested"
// is intentionally not mapped — it doesn't represent a settled state
// for the PR ("dismissed" reviews can also fire it). If the user wants
// changes_requested to move state in the future, add it as a 7th key
// in 4f.x rather than overloading "review_requested".
export const prStateKeyForReview = (payload: PullRequestReviewPayload): PrStateKey | undefined => {
  const action = payload.action;
  const reviewState = payload.review?.state;
  if (action !== "submitted") return undefined;
  if (reviewState === "approved") return "approved";
  return undefined;
};

const stateForPrLifecycle = (
  prStateMap: PrStateMap,
  binding: RepoBinding,
  payload: PullRequestPayload
): string | undefined => {
  const key = prStateKeyForPullRequest(payload);
  if (key && prStateMap[key]) return prStateMap[key];
  // Fall back to the binding's coarse open/closed map so installs
  // that haven't configured the PR state map still get the v1
  // closed-on-merge behavior. This is the only place the legacy
  // issueStateMap is read for PRs.
  const cfg = binding.config as { issueStateMap?: { open?: string; closed?: string } };
  if (payload.action === "closed") return cfg.issueStateMap?.closed;
  if (payload.action === "reopened") return cfg.issueStateMap?.open;
  return undefined;
};

const postGithubBacklinkComment = async (
  installationId: number,
  fullName: string,
  prNumber: number,
  ref: string,
  webBaseUrl: string,
  workspaceSlug: string,
  projectId: string,
  planeIssueId: string,
  ghesBaseUrl?: string | null
): Promise<void> => {
  const url = `${webBaseUrl}/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}`;
  const body = `Linked Plane work item: [${ref}](${url})`;
  const r = await callGithub(
    String(installationId),
    "POST",
    `/repos/${fullName}/issues/${prNumber}/comments`,
    { body },
    ghesBaseUrl
  );
  if (r.status >= 300) {
    console.warn(`[silo] PR→Plane backlink comment failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

const dispatchPrForBinding = async (
  binding: RepoBinding,
  payload: PullRequestPayload,
  webBaseUrl: string
): Promise<void> => {
  const pr = payload.pull_request;
  const text = `${pr.title ?? ""} ${pr.body ?? ""}`;
  const refs = parseRefs(text);
  if (refs.action.size === 0 && refs.linkOnly.size === 0) return;

  const projectIdForLookup = binding.project_id ?? "";
  const prStateMap = projectIdForLookup ? await fetchPrStateMap(binding.workspace_slug, projectIdForLookup) : {};
  const lifecycleStateId = stateForPrLifecycle(prStateMap, binding, payload);
  const lifecycleLabel =
    payload.action === "closed" && pr.merged
      ? "merged"
      : payload.action === "closed"
        ? "closed without merge"
        : payload.action === "reopened"
          ? "reopened"
          : payload.action;

  // Action references — apply state automation.
  for (const ref of refs.action) {
    const item = await lookupWorkItem(binding.workspace_slug, ref);
    if (!item) continue;
    if (lifecycleStateId) {
      await updatePlaneWorkItem({
        workspaceSlug: binding.workspace_slug,
        projectId: item.project_id,
        issueId: item.id,
        ghUserLogin: payload.sender?.login,
        stateId: lifecycleStateId,
      });
    }
    if (payload.action === "opened" || payload.action === "closed" || payload.action === "reopened") {
      await postPlaneBacklink(
        binding.workspace_slug,
        item.project_id,
        item.id,
        pr,
        payload.sender?.login,
        lifecycleLabel
      );
      if (payload.action === "opened" && payload.installation?.id) {
        await postGithubBacklinkComment(
          payload.installation.id,
          payload.repository.full_name,
          pr.number,
          ref,
          webBaseUrl,
          binding.workspace_slug,
          item.project_id,
          item.id,
          binding.ghes_base_url
        );
      }
    }
  }

  // Link-only references — backlink only, on opened.
  if (payload.action === "opened") {
    for (const ref of refs.linkOnly) {
      const item = await lookupWorkItem(binding.workspace_slug, ref);
      if (!item) continue;
      await postPlaneBacklink(binding.workspace_slug, item.project_id, item.id, pr, payload.sender?.login, "linked");
      if (payload.installation?.id) {
        await postGithubBacklinkComment(
          payload.installation.id,
          payload.repository.full_name,
          pr.number,
          ref,
          webBaseUrl,
          binding.workspace_slug,
          item.project_id,
          item.id,
          binding.ghes_base_url
        );
      }
    }
  }
};

export const handlePullRequestEvent = async (payload: PullRequestPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  if (!installationId || !repoId) return;

  // Echo guard, same as issues / issue_comment. No outbound PR writes
  // exist today so there's no loop yet, but guarding now keeps the
  // invariant uniform across handlers if outbound PR mirroring lands.
  if (isBotActor(payload.sender)) {
    console.log(`[silo] skip bot-driven pull_request.${payload.action} from ${payload.sender?.login}`);
    return;
  }

  const bindings = await fetchRepoBindings(installationId, repoId);
  if (bindings.length === 0) return;

  const webBaseUrl = process.env.PLANE_PUBLIC_URL ?? process.env.WEB_BASE_URL ?? "http://localhost:3000";

  for (const binding of bindings) {
    try {
      await dispatchPrForBinding(binding, payload, webBaseUrl);
    } catch (err) {
      console.error(`[silo] pull_request crashed for binding=${binding.id}:`, err);
    }
  }
};

export const handlePullRequestReviewEvent = async (payload: PullRequestReviewPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  if (!installationId || !repoId) return;

  if (isBotActor(payload.sender)) {
    console.log(`[silo] skip bot-driven pull_request_review.${payload.action} from ${payload.sender?.login}`);
    return;
  }

  const key = prStateKeyForReview(payload);
  if (!key) {
    // No state mapping for this review action/state — log + bail so
    // we don't pay the binding lookup for "commented" reviews.
    console.log(
      `[silo] pull_request_review.${payload.action} state=${payload.review?.state} pr=${payload.pull_request?.number} (no state map)`
    );
    return;
  }

  const bindings = await fetchRepoBindings(installationId, repoId);
  if (bindings.length === 0) return;

  const pr = payload.pull_request;
  const refs = parseRefs(`${pr.title ?? ""} ${pr.body ?? ""}`);
  if (refs.action.size === 0) return;

  for (const binding of bindings) {
    try {
      const projectIdForLookup = binding.project_id ?? "";
      if (!projectIdForLookup) continue;
      const prStateMap = await fetchPrStateMap(binding.workspace_slug, projectIdForLookup);
      const stateId = prStateMap[key];
      if (!stateId) continue;
      for (const ref of refs.action) {
        const item = await lookupWorkItem(binding.workspace_slug, ref);
        if (!item) continue;
        await updatePlaneWorkItem({
          workspaceSlug: binding.workspace_slug,
          projectId: item.project_id,
          issueId: item.id,
          ghUserLogin: payload.sender?.login,
          stateId,
        });
      }
    } catch (err) {
      console.error(`[silo] pull_request_review crashed for binding=${binding.id}:`, err);
    }
  }
};

export const _internal = { parseRefs, lookupWorkItem };
