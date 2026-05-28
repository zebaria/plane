/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fetches project-scoped picker data (states, labels, members,
 * work-item types, priorities) from Django so the create-work-item
 * Slack modal can render real options instead of free text.
 *
 * Cached per (workspace, project) for `CACHE_TTL_MS` since this is
 * read once per modal open and rarely changes within a session.
 */

import { callDjango } from "../django-client";

export type ProjectState = { id: string; name: string; group: string; color: string };
export type ProjectLabel = { id: string; name: string; color: string };
export type ProjectMember = { id: string; display_name: string };
export type ProjectType = { id: string; name: string; is_default: boolean; is_epic: boolean };
export type ProjectPriority = { key: string; label: string };

export type ProjectMetadata = {
  states: ProjectState[];
  defaultStateId: string | null;
  labels: ProjectLabel[];
  members: ProjectMember[];
  defaultAssigneeId: string | null;
  types: ProjectType[];
  defaultTypeId: string | null;
  priorities: ProjectPriority[];
};

const CACHE_TTL_MS = 60_000;
// Bounded FIFO. Map preserves insertion order, so deleting the first
// key on overflow drops the oldest entry. invalidate is rarely called
// in practice, so without this the cache would grow unbounded.
const CACHE_MAX_ENTRIES = 1000;
type CacheEntry = { value: ProjectMetadata; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

const cacheKey = (workspaceSlug: string, projectId: string): string => `${workspaceSlug}::${projectId}`;

export const fetchProjectMetadata = async (workspaceSlug: string, projectId: string): Promise<ProjectMetadata> => {
  const key = cacheKey(workspaceSlug, projectId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const res = await callDjango<{
    states: ProjectState[];
    default_state_id: string | null;
    labels: ProjectLabel[];
    members: ProjectMember[];
    default_assignee_id: string | null;
    types: ProjectType[];
    default_type_id: string | null;
    priorities: ProjectPriority[];
  }>("POST", "/api/v1/silo/project-metadata/", {
    workspace_slug: workspaceSlug,
    project_id: projectId,
  });

  if (res.status >= 300 || !res.data || typeof res.data !== "object") {
    throw new Error(`project-metadata lookup failed: ${res.status}`);
  }

  const value: ProjectMetadata = {
    states: res.data.states ?? [],
    defaultStateId: res.data.default_state_id ?? null,
    labels: res.data.labels ?? [],
    members: res.data.members ?? [],
    defaultAssigneeId: res.data.default_assignee_id ?? null,
    types: res.data.types ?? [],
    defaultTypeId: res.data.default_type_id ?? null,
    priorities: res.data.priorities ?? [],
  };
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, fetchedAt: Date.now() });
  return value;
};

export const invalidateProjectMetadata = (workspaceSlug: string, projectId: string): void => {
  cache.delete(cacheKey(workspaceSlug, projectId));
};
