/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shared helpers for resolving a Plane work item from either a URL
 * (link unfurls) or a `IDENT-SEQ` reference (message shortcut "Link
 * to work item"). Backed by Django's HMAC-only
 * `POST /api/v1/silo/work-items/lookup/` endpoint.
 */

import { callDjango } from "../django-client";

const BROWSE_URL_RE = /^https?:\/\/[^/]+\/([^/]+)\/browse\/([A-Za-z0-9_]+)-(\d+)/;
const LEGACY_URL_RE = /^https?:\/\/[^/]+\/([^/]+)\/projects\/([0-9a-f-]{36})\/issues\/([0-9a-f-]{36})/i;
const REF_RE = /^([A-Za-z0-9_]+)-(\d+)$/;

export type ParsedWorkItemUrl =
  | {
      kind: "browse";
      workspaceSlug: string;
      projectIdentifier: string;
      sequenceId: number;
    }
  | {
      kind: "legacy";
      workspaceSlug: string;
      projectId: string;
      issueId: string;
    };

export const parseWorkItemUrl = (url: string): ParsedWorkItemUrl | null => {
  const b = BROWSE_URL_RE.exec(url);
  if (b) {
    const seq = Number.parseInt(b[3], 10);
    if (!Number.isSafeInteger(seq)) return null;
    return {
      kind: "browse",
      workspaceSlug: b[1],
      projectIdentifier: b[2].toUpperCase(),
      sequenceId: seq,
    };
  }
  const l = LEGACY_URL_RE.exec(url);
  if (l) {
    return { kind: "legacy", workspaceSlug: l[1], projectId: l[2], issueId: l[3] };
  }
  return null;
};

export const parseWorkItemRef = (ref: string, workspaceSlug: string): ParsedWorkItemUrl | null => {
  const m = REF_RE.exec(ref.trim());
  if (!m) return null;
  const seq = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(seq)) return null;
  return {
    kind: "browse",
    workspaceSlug,
    projectIdentifier: m[1].toUpperCase(),
    sequenceId: seq,
  };
};

export type WorkItemLookup = {
  id: string;
  sequence_id: number;
  name: string;
  project_identifier: string;
  state_name: string | null;
  state_group: string | null;
  priority: string | null;
  workspace_slug: string;
  project_id: string;
};

export const lookupWorkItem = async (parsed: ParsedWorkItemUrl): Promise<WorkItemLookup | null> => {
  const body: Record<string, unknown> =
    parsed.kind === "browse"
      ? {
          workspace_slug: parsed.workspaceSlug,
          project_identifier: parsed.projectIdentifier,
          sequence_id: parsed.sequenceId,
        }
      : {
          workspace_slug: parsed.workspaceSlug,
          project_id: parsed.projectId,
          issue_id: parsed.issueId,
        };
  const r = await callDjango<WorkItemLookup>("POST", "/api/v1/silo/work-items/lookup/", body);
  if (r.status === 404) return null;
  if (r.status >= 300) {
    console.error(`[silo] work-item lookup failed: ${r.status} ${JSON.stringify(r.data)}`);
    return null;
  }
  return r.data;
};
