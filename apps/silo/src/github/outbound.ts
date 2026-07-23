/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Plane → GitHub outbound mirror. Receives `WorkItemEvent` from
 * the silo notifications router (Django → silo HMAC channel) and,
 * for each `github-repo` binding bound to the event's project,
 * mirrors the change onto the GitHub Issue side.
 *
 * Direction gating: bindings with `config.direction === "uni"` only
 * receive inbound mirrors (GH → Plane). Outbound writes require
 * `direction === "bi"` (default for repo bindings created via the
 * UI). This avoids surprise writes back to GitHub on installs that
 * intended one-way ingestion.
 *
 * Idempotency: persisted on the `github-issue-link` row. We look up
 * by `plane_issue_id` first; if a link exists we PATCH/comment, if
 * not we POST a new GH issue and persist the resulting numeric id
 * back as the link's entity_id.
 */
import TurndownService from "turndown";

import { callDjango } from "../django-client";
import type { IntegrationDispatcher, WorkItemEvent } from "../events";
import { callGithub } from "./api";
import { isGithubConfigured } from "./config";
import { persistIssueLink, type RepoBinding } from "./django";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

export const htmlToMarkdown = (html: string | null | undefined): string => {
  if (!html) return "";
  try {
    return turndown.turndown(html);
  } catch (err) {
    console.warn("[silo] turndown failed, falling back to raw html:", err);
    return html;
  }
};

// Strip HTML tags repeatedly until the string is stable. A single
// pass of /<[^>]+>/g can leave fragments behind when tags are nested
// or malformed (the classic incomplete-sanitization footgun); looping
// to a fixed point closes that. Bounded — each pass strictly shrinks
// the string or stops.
const stripTags = (s: string): string => {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/<[^>]*>/g, "");
  } while (cur !== prev);
  return cur;
};

// Rewrite Plane's `<mention-component entity_name="user_mention"
// entity_identifier="<plane_user_id>">@Display Name</mention-component>`
// into `@<gh_login>` (or, when the user hasn't linked a GitHub
// identity, `@<display_name>` with the @ stripped of any spaces) so
// the GH side renders a real notification ping rather than a literal
// "@Display Name" string. Operates on the html before turndown so the
// substitution survives markdown conversion intact.
export const rewriteMentionsForGithub = (
  html: string | null | undefined,
  mentionMap: Record<string, string> | undefined
): string => {
  if (!html) return "";
  if (!html.includes("mention-component")) return html;
  const map = mentionMap ?? {};
  return html.replace(
    /<mention-component\b([^>]*)>([\s\S]*?)<\/mention-component>/gi,
    (_full, attrs: string, inner: string) => {
      const entity = /entity_name=["']([^"']+)["']/i.exec(attrs)?.[1];
      if (entity !== "user_mention") return inner;
      const planeId = /entity_identifier=["']([^"']+)["']/i.exec(attrs)?.[1];
      const ghLogin = planeId ? map[planeId] : undefined;
      if (ghLogin) return `@${ghLogin}`;
      // Fall back to the inner text (Plane writes "@Display Name")
      // with whitespace collapsed so GH doesn't try to ping a name
      // with a space in it. Strip a leading "@" since we re-add it.
      //
      // The output then has all non-word chars removed, so even an
      // incompletely-stripped tag fragment (e.g. a stray "<script")
      // can't survive into the GH mention — `\W` drops `<`, `/`, etc.
      // (CodeQL js/incomplete-multi-character-sanitization).
      const txt = stripTags(inner).trim().replace(/^@/, "");
      const safe = txt.replace(/[^\w.-]/g, "");
      return safe ? `@${safe}` : inner;
    }
  );
};

const fetchRepoBindingsForProject = async (
  workspaceSlug: string,
  projectId: string
): Promise<(RepoBinding & { installation_id: string })[]> => {
  const r = await callDjango<{ bindings: (RepoBinding & { installation_id: string })[] }>(
    "POST",
    "/api/v1/silo/github/repo-bindings/",
    { workspace_slug: workspaceSlug, project_id: projectId }
  );
  if (r.status >= 300) {
    throw new Error(`repo-bindings (outbound) ${r.status}: ${JSON.stringify(r.data)}`);
  }
  return r.data?.bindings ?? [];
};

export const isBidirectional = (binding: RepoBinding): boolean => {
  const cfg = binding.config as { direction?: "uni" | "bi" };
  return (cfg.direction ?? "bi") === "bi";
};

// Reverse the binding's issueStateMap: given a Plane state_id, decide
// whether the GH issue should be "open" or "closed". Falls back to
// state_group if the explicit map doesn't include the state. Returns
// undefined when we can't tell — caller leaves the GH state alone.
export const ghStateForPlaneState = (
  binding: RepoBinding,
  stateId: string | null | undefined,
  stateGroup: string | null | undefined
): "open" | "closed" | undefined => {
  const cfg = binding.config as { issueStateMap?: { open?: string; closed?: string } };
  const map = cfg.issueStateMap ?? {};
  if (stateId && map.closed && stateId === map.closed) return "closed";
  if (stateId && map.open && stateId === map.open) return "open";
  if (stateGroup === "completed" || stateGroup === "cancelled") return "closed";
  if (stateGroup === "backlog" || stateGroup === "unstarted" || stateGroup === "started") return "open";
  return undefined;
};

const issueGateLabel = "Plane";

// `mirrorAllIssues=false` means "only mirror items carrying the Plane
// label" — both directions. For outbound this is the v1 author-intent
// gate: a Plane work item without the Plane label was created in
// Plane and shouldn't auto-spawn a GH issue.
export const passesOutboundGate = (
  binding: RepoBinding,
  labels: { id: string; name: string }[] | undefined
): boolean => {
  const cfg = binding.config as { mirrorAllIssues?: boolean };
  if (cfg.mirrorAllIssues !== false) return true;
  return (labels ?? []).some((l) => l.name === issueGateLabel);
};

type GhIssueResponse = { id: number; number: number };
type GhCommentResponse = { id: number };

const createGhIssue = async (
  installationId: string,
  fullName: string,
  title: string,
  bodyHtml: string,
  workspaceSlug: string,
  projectId: string,
  projectIdentifier: string,
  sequenceId: number,
  webBaseUrl: string,
  planeIssueId: string,
  mentionMap: Record<string, string> | undefined,
  ghesBaseUrl?: string | null
): Promise<GhIssueResponse | null> => {
  const ref = `${projectIdentifier}-${sequenceId}`;
  const url = `${webBaseUrl}/${workspaceSlug}/projects/${projectId}/issues/${planeIssueId}`;
  const body = `${htmlToMarkdown(rewriteMentionsForGithub(bodyHtml, mentionMap))}\n\n---\n_Mirrored from Plane work item [${ref}](${url})._`;
  const r = await callGithub<GhIssueResponse>(
    installationId,
    "POST",
    `/repos/${fullName}/issues`,
    { title, body, labels: ["Plane"] },
    ghesBaseUrl
  );
  if (r.status >= 300) {
    console.error(`[silo] outbound create issue failed ${r.status}: ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data;
};

const handleCreated = async (
  binding: RepoBinding & { installation_id: string },
  event: WorkItemEvent,
  webBaseUrl: string
): Promise<void> => {
  if (!event.issue) return;
  if (!binding.entity_slug) return;
  if (!passesOutboundGate(binding, event.issue.labels)) return;

  // Idempotent: a duplicate event delivery for the same Plane work
  // item must not double-create on GitHub. The lookup returns 200
  // (already mirrored → skip) or 404 (no link → create). Treat any
  // other status as "unknown" and abort rather than risk a duplicate
  // GH issue with no link row — a transient 5xx must not fall through
  // to create.
  const link = await callDjango<unknown>("POST", "/api/v1/silo/github/issue-link/lookup/", {
    plane_issue_id: event.issue.id,
    workspace_connection_id: binding.workspace_connection_id,
  });
  if (link.status === 200) return; // already mirrored
  if (link.status !== 404) {
    console.error(
      `[silo] outbound create aborted: issue-link lookup returned ${link.status} (expected 200 or 404) for plane_issue=${event.issue.id}`
    );
    return;
  }

  const created = await createGhIssue(
    binding.installation_id,
    binding.entity_slug,
    event.issue.name,
    event.issue.description_html ?? "",
    event.workspace_slug,
    event.project_id,
    event.project_identifier,
    event.issue.sequence_id,
    webBaseUrl,
    event.issue.id,
    event.mention_map,
    binding.ghes_base_url
  );
  if (!created) return;

  if (!binding.project_id) return;
  await persistIssueLink({
    workspaceConnectionId: binding.workspace_connection_id,
    projectId: binding.project_id,
    ghIssueId: created.id,
    ghIssueNumber: created.number,
    ghRepoFullName: binding.entity_slug,
    planeIssueId: event.issue.id,
    planeProjectId: binding.project_id,
  });
};

const handleUpdated = async (
  binding: RepoBinding & { installation_id: string },
  event: WorkItemEvent
): Promise<void> => {
  if (!event.issue || !binding.entity_slug) return;
  const link = await callDjango<{
    entity_id: string;
    entity_slug: string;
    entity_data: { gh_issue_number?: number };
  }>("POST", "/api/v1/silo/github/issue-link/lookup/", {
    plane_issue_id: event.issue.id,
    workspace_connection_id: binding.workspace_connection_id,
  });
  if (link.status !== 200) return;
  const issueNumber = link.data.entity_data?.gh_issue_number;
  if (!issueNumber) return;

  const patch: Record<string, unknown> = {};
  patch.title = event.issue.name;
  patch.body = htmlToMarkdown(rewriteMentionsForGithub(event.issue.description_html ?? "", event.mention_map));
  const ghState = ghStateForPlaneState(binding, event.issue.state_id, event.state_change?.to_group);
  if (ghState) patch.state = ghState;

  const r = await callGithub(
    binding.installation_id,
    "PATCH",
    `/repos/${link.data.entity_slug}/issues/${issueNumber}`,
    patch,
    binding.ghes_base_url
  );
  if (r.status >= 300) {
    console.error(`[silo] outbound update failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

const handleStateChanged = async (
  binding: RepoBinding & { installation_id: string },
  event: WorkItemEvent
): Promise<void> => {
  if (!event.issue || !binding.entity_slug) return;
  const ghState = ghStateForPlaneState(binding, event.issue.state_id, event.state_change?.to_group);
  if (!ghState) return;

  const link = await callDjango<{
    entity_slug: string;
    entity_data: { gh_issue_number?: number };
  }>("POST", "/api/v1/silo/github/issue-link/lookup/", {
    plane_issue_id: event.issue.id,
    workspace_connection_id: binding.workspace_connection_id,
  });
  if (link.status !== 200) return;
  const issueNumber = link.data.entity_data?.gh_issue_number;
  if (!issueNumber) return;

  const r = await callGithub(
    binding.installation_id,
    "PATCH",
    `/repos/${link.data.entity_slug}/issues/${issueNumber}`,
    { state: ghState },
    binding.ghes_base_url
  );
  if (r.status >= 300) {
    console.error(`[silo] outbound state failed ${r.status}: ${JSON.stringify(r.data)}`);
  }
};

const handleCommented = async (
  binding: RepoBinding & { installation_id: string },
  event: WorkItemEvent
): Promise<void> => {
  if (!event.issue || !event.comment) return;
  const link = await callDjango<{
    id: string;
    project_id: string | null;
    entity_id: string;
    entity_slug: string;
    plane_issue_id: string;
    entity_data: {
      gh_issue_number?: number;
      gh_repo_full_name?: string;
      gh_comment_map?: Record<string, string>;
      // Also track Plane-comment-id → GH-comment-id, for idempotency
      // on outbound-only comments (created in Plane, mirrored to GH).
      plane_comment_map?: Record<string, string>;
    };
  }>("POST", "/api/v1/silo/github/issue-link/lookup/", {
    plane_issue_id: event.issue.id,
    workspace_connection_id: binding.workspace_connection_id,
  });
  if (link.status !== 200) return;
  const issueNumber = link.data.entity_data?.gh_issue_number;
  if (!issueNumber) return;
  const planeCommentMap = link.data.entity_data?.plane_comment_map ?? {};
  const ghCommentMap = link.data.entity_data?.gh_comment_map ?? {};
  const planeCommentId = event.comment.id;

  // If this comment originated on GitHub (it's already in
  // gh_comment_map values), we're seeing the activity hook for the
  // mirrored Plane comment we just created — skip the round-trip.
  if (Object.values(ghCommentMap).includes(planeCommentId)) return;
  // If we already mirrored this Plane comment outward, skip retry.
  if (planeCommentMap[planeCommentId]) return;

  // Author attribution comes from `event.actor`. The GH `[bot]`
  // sender already tells the GH-side reader this is automated, so we
  // only add a one-line "from <user>" so they know which Plane user
  // wrote it. No "from Plane" — the bot login already says so.
  const who = event.actor?.display_name ?? event.actor?.email ?? "Plane user";
  const body = `${htmlToMarkdown(
    rewriteMentionsForGithub(event.comment.comment_html, event.mention_map)
  )}\n\n_— ${who}_`;

  const r = await callGithub<GhCommentResponse>(
    binding.installation_id,
    "POST",
    `/repos/${link.data.entity_slug}/issues/${issueNumber}/comments`,
    { body },
    binding.ghes_base_url
  );
  if (r.status >= 300) {
    console.error(`[silo] outbound comment failed ${r.status}: ${JSON.stringify(r.data)}`);
    return;
  }

  // Persist the plane→gh comment id mapping so a Plane edit/delete
  // can find the right GH comment, and so we don't double-post on a
  // duplicate event delivery.
  if (!link.data.project_id) return;
  planeCommentMap[planeCommentId] = String(r.data.id);
  await callDjango("POST", "/api/v1/silo/github/issue-link/", {
    workspace_connection_id: binding.workspace_connection_id,
    project_id: link.data.project_id,
    gh_issue_id: link.data.entity_id,
    gh_issue_number: issueNumber,
    gh_repo_full_name: link.data.entity_slug,
    plane_issue_id: link.data.plane_issue_id,
    plane_project_id: link.data.project_id,
    plane_comment_map: planeCommentMap,
  });
};

const dispatchForBinding = async (
  binding: RepoBinding & { installation_id: string },
  event: WorkItemEvent,
  webBaseUrl: string
): Promise<void> => {
  if (!isBidirectional(binding)) return;

  switch (event.event_type) {
    case "work_item.created":
      await handleCreated(binding, event, webBaseUrl);
      return;
    case "work_item.updated":
      await handleUpdated(binding, event);
      return;
    case "work_item.state_changed":
    case "work_item.completed":
      await handleStateChanged(binding, event);
      return;
    case "work_item.commented":
      await handleCommented(binding, event);
      return;
  }
};

const dispatch = async (event: WorkItemEvent, webBaseUrl: string): Promise<void> => {
  // If GitHub isn't configured (no secret loaded at startup), don't try
  // to mirror — calling GitHub would throw on getGithubConfig(). A stale
  // repo binding can outlive its config (e.g. secret removed, or never
  // bootstrapped in this env), so gate on the integration, not just the
  // binding. No-op with a clear note rather than crashing the dispatcher.
  if (!isGithubConfigured()) {
    console.warn(
      `[silo] github outbound skipped for project=${event.project_id}: GitHub integration not configured ` +
        `(a repo binding exists but no GitHub secret is loaded — bootstrap GitHub or remove the binding)`
    );
    return;
  }
  const bindings = await fetchRepoBindingsForProject(event.workspace_slug, event.project_id);
  if (bindings.length === 0) return;
  console.log(
    `[silo] outbound github bindings=${bindings.length} event=${event.event_type} project=${event.project_id}`
  );
  await Promise.all(
    bindings.map(async (b) => {
      try {
        await dispatchForBinding(b, event, webBaseUrl);
      } catch (err) {
        console.error(`[silo] outbound binding=${b.id} crashed:`, err);
      }
    })
  );
};

export const githubOutboundDispatcher: IntegrationDispatcher = {
  name: "github",
  mappingType: "github-repo",
  dispatch,
};
