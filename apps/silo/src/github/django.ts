/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Thin wrappers around the silo→Django HMAC channel for the GitHub
 * webhook handlers. Centralized here so handler files don't need
 * to know which v1 path corresponds to which operation.
 */

import { callDjango } from "../django-client";

export type RepoBinding = {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_connection_id: string;
  installation_id: string;
  ghes_base_url?: string | null;
  project_id: string | null;
  entity_id: string;
  entity_slug: string | null;
  config:
    | {
        direction?: "uni" | "bi";
        mirrorAllIssues?: boolean;
        issueStateMap?: { open?: string; closed?: string };
      }
    | Record<string, unknown>;
};

export const fetchRepoBindings = async (
  installationId: string | number,
  repoId: string | number
): Promise<RepoBinding[]> => {
  const r = await callDjango<{ bindings: RepoBinding[] }>("POST", "/api/v1/silo/github/repo-bindings/", {
    installation_id: String(installationId),
    repo_id: String(repoId),
  });
  if (r.status >= 300) throw new Error(`repo-bindings ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data?.bindings ?? [];
};

export type IssueLink = {
  id: string;
  workspace_connection_id: string;
  project_id: string | null;
  plane_issue_id: string | null;
  entity_data: Record<string, unknown>;
};

export const lookupIssueLink = async (
  ghIssueId: string | number,
  workspaceConnectionId?: string
): Promise<IssueLink | null> => {
  const body: Record<string, unknown> = { gh_issue_id: String(ghIssueId) };
  if (workspaceConnectionId) body.workspace_connection_id = workspaceConnectionId;
  const r = await callDjango<IssueLink>("POST", "/api/v1/silo/github/issue-link/lookup/", body);
  if (r.status === 404) return null;
  if (r.status >= 300) throw new Error(`issue-link/lookup ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

export const persistIssueLink = async (params: {
  workspaceConnectionId: string;
  projectId: string;
  ghIssueId: string | number;
  ghIssueNumber: number;
  ghRepoFullName: string;
  planeIssueId: string;
  planeProjectId: string;
}): Promise<void> => {
  const r = await callDjango("POST", "/api/v1/silo/github/issue-link/", {
    workspace_connection_id: params.workspaceConnectionId,
    project_id: params.projectId,
    gh_issue_id: String(params.ghIssueId),
    gh_issue_number: params.ghIssueNumber,
    gh_repo_full_name: params.ghRepoFullName,
    plane_issue_id: params.planeIssueId,
    plane_project_id: params.planeProjectId,
  });
  if (r.status >= 300) throw new Error(`issue-link ${r.status}: ${JSON.stringify(r.data)}`);
};

export const createPlaneWorkItem = async (params: {
  workspaceSlug: string;
  projectId: string;
  title: string;
  description?: string;
  ghUserLogin?: string;
}): Promise<{ id: string; sequence_id: number; project_identifier: string; url: string } | null> => {
  // SiloCreateWorkItemEndpoint requires actor resolution. For GitHub
  // mirrors we pass `gh_user_login` so the endpoint can look up the
  // WorkspaceUserConnection; the endpoint falls back to the workspace
  // installer if no mapping exists.
  const r = await callDjango<{
    id: string;
    sequence_id: number;
    project_identifier: string;
    url: string;
  }>("POST", "/api/v1/silo/work-items/", {
    workspace_slug: params.workspaceSlug,
    project_id: params.projectId,
    title: params.title,
    // GH path renders markdown to HTML upstream — send via
    // description_html so Django doesn't escape the tags.
    description_html: params.description ?? "",
    gh_user_login: params.ghUserLogin,
  });
  if (r.status >= 300) {
    console.error(`[silo] work-item create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data;
};

export const updatePlaneWorkItem = async (params: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  ghUserLogin?: string;
  name?: string;
  descriptionHtml?: string;
  stateId?: string;
}): Promise<boolean> => {
  const body: Record<string, unknown> = {
    workspace_slug: params.workspaceSlug,
    project_id: params.projectId,
    issue_id: params.issueId,
    gh_user_login: params.ghUserLogin,
  };
  if (params.name !== undefined) body.name = params.name;
  if (params.descriptionHtml !== undefined) body.description_html = params.descriptionHtml;
  if (params.stateId !== undefined) body.state_id = params.stateId;
  const r = await callDjango("POST", "/api/v1/silo/work-items/update/", body);
  if (r.status >= 300) {
    console.error(`[silo] work-item update failed: ${r.status} ${JSON.stringify(r.data)}`);
    return false;
  }
  return true;
};

export const createPlaneComment = async (params: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  commentHtml: string;
  ghUserLogin?: string;
}): Promise<{ id: string } | null> => {
  const r = await callDjango<{ id: string }>("POST", "/api/v1/silo/comments/", {
    workspace_slug: params.workspaceSlug,
    project_id: params.projectId,
    issue_id: params.issueId,
    comment_html: params.commentHtml,
    gh_user_login: params.ghUserLogin,
  });
  if (r.status >= 300) {
    console.error(`[silo] comment create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data;
};

export const editPlaneComment = async (
  commentId: string,
  commentHtml: string,
  scope: { workspaceSlug: string; issueId: string }
): Promise<boolean> => {
  const r = await callDjango("POST", "/api/v1/silo/comments/update/", {
    comment_id: commentId,
    action: "edit",
    comment_html: commentHtml,
    // Ownership scope — Django verifies the comment belongs to this
    // workspace + work item before mutating, so a bug can't address
    // an arbitrary comment by pk.
    workspace_slug: scope.workspaceSlug,
    issue_id: scope.issueId,
  });
  return r.status < 300;
};

export const deletePlaneComment = async (
  commentId: string,
  scope: { workspaceSlug: string; issueId: string }
): Promise<boolean> => {
  const r = await callDjango("POST", "/api/v1/silo/comments/update/", {
    comment_id: commentId,
    action: "delete",
    workspace_slug: scope.workspaceSlug,
    issue_id: scope.issueId,
  });
  return r.status < 300;
};
