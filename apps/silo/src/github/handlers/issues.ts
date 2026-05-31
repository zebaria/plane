/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * `issues` event handler. Mirrors GitHub Issue lifecycle into Plane
 * work items. Idempotent on retries — every action either creates
 * the link row (POST is upsert) or short-circuits because the link
 * already exists.
 *
 * Mirror gate per binding:
 *   - `mirrorAllIssues: true`  → mirror every issue (default).
 *   - `mirrorAllIssues: false` → only mirror issues with the
 *     case-sensitive `Plane` label.
 *
 * State mapping uses `config.issueStateMap.{open,closed}` from the
 * binding. On `closed`/`reopened` we PATCH the linked work item;
 * non-binary GH state changes (label flips, assignees) are mirrored
 * back too but state is left untouched.
 */

/* Sequential awaits in this handler are deliberate: each iteration is
 * an ordered, rate-limit-friendly write to GitHub/Django over a small,
 * bounded set. Matches the project convention for webhook handlers. */
/* eslint-disable no-await-in-loop */

import { marked } from "marked";

import { callGithub } from "../api";
import { webBaseFor } from "../host";
import { convertTaskLists } from "../markdown";
import {
  createPlaneWorkItem,
  fetchRepoBindings,
  lookupIssueLink,
  persistIssueLink,
  updatePlaneWorkItem,
  type RepoBinding,
} from "../django";

type GhUser = { login: string; id: number; type?: string };
type GhLabel = { id: number; name: string };
type GhRepo = { id: number; full_name: string; name: string };
type GhIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: GhLabel[];
  user: GhUser;
  assignees: GhUser[];
  pull_request?: unknown;
};

export type IssuesPayload = {
  action: string;
  issue: GhIssue;
  repository: GhRepo;
  installation?: { id: number };
  sender?: GhUser;
  label?: GhLabel;
};

const PLANE_LABEL = "Plane";

const renderDescription = (issue: GhIssue, fullName: string, ghesBaseUrl?: string | null): string => {
  const body = issue.body ?? "";
  // GitHub issue bodies are GH-flavored markdown. Plane stores
  // descriptions as HTML (prosemirror-rendered), so convert before
  // shipping. `marked` handles headings, lists, checkboxes,
  // code fences, links — the common GH issue template surface.
  const html = body ? convertTaskLists(marked.parse(body, { async: false, gfm: true, breaks: true }) as string) : "";
  const ghUrl = `${webBaseFor(ghesBaseUrl)}/${fullName}/issues/${issue.number}`;
  return `${html}<p><em>Mirrored from <a href="${ghUrl}">${fullName}#${issue.number}</a></em></p>`;
};

const passesMirrorGate = (issue: GhIssue, binding: RepoBinding): boolean => {
  const cfg = binding.config as { mirrorAllIssues?: boolean };
  if (cfg.mirrorAllIssues !== false) return true;
  return (issue.labels ?? []).some((l) => l.name === PLANE_LABEL);
};

const stateIdForGhState = (binding: RepoBinding, ghState: "open" | "closed"): string | undefined => {
  const cfg = binding.config as { issueStateMap?: { open?: string; closed?: string } };
  return ghState === "closed" ? cfg.issueStateMap?.closed : cfg.issueStateMap?.open;
};

const postBacklinkComment = async (
  installationId: number,
  fullName: string,
  issueNumber: number,
  workspaceSlug: string,
  projectIdentifier: string,
  sequenceId: number,
  webBaseUrl: string,
  planeProjectId: string,
  planeIssueId: string,
  ghesBaseUrl?: string | null
): Promise<void> => {
  const ref = `${projectIdentifier}-${sequenceId}`;
  const url = `${webBaseUrl}/${workspaceSlug}/projects/${planeProjectId}/issues/${planeIssueId}`;
  const body = `Linked Plane work item: [${ref}](${url})`;
  const r = await callGithub(
    String(installationId),
    "POST",
    `/repos/${fullName}/issues/${issueNumber}/comments`,
    { body },
    ghesBaseUrl
  );
  if (r.status >= 300) {
    console.warn(`[silo] backlink comment failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

const handleOpenedOrLabeled = async (
  binding: RepoBinding,
  payload: IssuesPayload,
  webBaseUrl: string
): Promise<void> => {
  const issue = payload.issue;
  if (!binding.project_id) return;
  if (!passesMirrorGate(issue, binding)) return;

  // Idempotent: a webhook retry on the same issue should not
  // create a second work item. The link upsert is keyed on
  // (workspace_connection, gh_issue_id).
  const existing = await lookupIssueLink(issue.id, binding.workspace_connection_id);
  if (existing && existing.plane_issue_id) {
    return;
  }

  const created = await createPlaneWorkItem({
    workspaceSlug: binding.workspace_slug,
    projectId: binding.project_id,
    title: issue.title,
    description: renderDescription(issue, payload.repository.full_name, binding.ghes_base_url),
    ghUserLogin: issue.user?.login,
  });
  if (!created) return;

  await persistIssueLink({
    workspaceConnectionId: binding.workspace_connection_id,
    projectId: binding.project_id,
    ghIssueId: issue.id,
    ghIssueNumber: issue.number,
    ghRepoFullName: payload.repository.full_name,
    planeIssueId: created.id,
    planeProjectId: binding.project_id,
  });

  if (payload.installation?.id) {
    await postBacklinkComment(
      payload.installation.id,
      payload.repository.full_name,
      issue.number,
      binding.workspace_slug,
      created.project_identifier,
      created.sequence_id,
      webBaseUrl,
      binding.project_id,
      created.id,
      binding.ghes_base_url
    );
  }
};

const handleEditedClosedReopened = async (binding: RepoBinding, payload: IssuesPayload): Promise<void> => {
  const issue = payload.issue;
  if (!binding.project_id) return;
  const link = await lookupIssueLink(issue.id, binding.workspace_connection_id);
  if (!link || !link.plane_issue_id) return;

  const stateId = stateIdForGhState(binding, issue.state);
  await updatePlaneWorkItem({
    workspaceSlug: binding.workspace_slug,
    projectId: binding.project_id,
    issueId: link.plane_issue_id,
    ghUserLogin: payload.sender?.login,
    name: payload.action === "edited" ? issue.title : undefined,
    descriptionHtml:
      payload.action === "edited"
        ? renderDescription(issue, payload.repository.full_name, binding.ghes_base_url)
        : undefined,
    stateId,
  });
};

export const handleIssuesEvent = async (payload: IssuesPayload): Promise<void> => {
  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  if (!installationId || !repoId) {
    console.warn("[silo] github issues missing installation.id or repository.id");
    return;
  }
  // Plane uses both `issues` events for issues *and* PRs (GitHub
  // posts PRs through the `pull_request` event channel separately,
  // but issue payloads include a `pull_request` key when the issue
  // is actually a PR comment shell). Skip when present — the PR
  // handler covers that surface.
  if (payload.issue?.pull_request) return;

  // Echo guard: actions performed by our own GH App (outbound mirror)
  // arrive as `sender.type === "Bot"` / `sender.login` ending in
  // `[bot]`. Mirroring them back into Plane creates a write loop. The
  // create path is already idempotent via the link row, but edits /
  // closes / label flips still need this gate.
  const sender = payload.sender;
  if (sender?.type === "Bot" || (sender?.login ?? "").endsWith("[bot]")) {
    console.log(`[silo] skip bot-driven issues.${payload.action} from ${sender?.login}`);
    return;
  }

  const bindings = await fetchRepoBindings(installationId, repoId);
  if (bindings.length === 0) return;

  const webBaseUrl = process.env.PLANE_PUBLIC_URL ?? process.env.WEB_BASE_URL ?? "http://localhost:3000";

  for (const binding of bindings) {
    try {
      switch (payload.action) {
        case "opened":
        case "labeled":
        case "reopened": {
          // For `opened`/`labeled` we may need to create the link.
          // For `reopened` we may also need to create it (issue was
          // never `Plane`-labeled when first opened, then later
          // labeled + reopened) — fall through to opened path first,
          // then sync state.
          if (payload.action === "reopened") {
            await handleEditedClosedReopened(binding, payload);
          } else {
            await handleOpenedOrLabeled(binding, payload, webBaseUrl);
          }
          break;
        }
        case "edited":
        case "closed":
        case "unlabeled":
        case "assigned":
        case "unassigned":
          await handleEditedClosedReopened(binding, payload);
          break;
        default:
          // deleted / transferred / pinned / etc. — log + skip.
          console.log(`[silo] github issues.${payload.action} (no-op for binding=${binding.id})`);
      }
    } catch (err) {
      console.error(`[silo] issues handler crashed for binding=${binding.id}:`, err);
    }
  }
};
