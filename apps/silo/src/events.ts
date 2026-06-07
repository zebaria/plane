/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shared types for the work-item event pipeline: the event payload Django
 * sends to the silo, the dispatcher contract each integration implements,
 * and the project-mapping shape Django returns. Kept in a neutral module
 * so integrations and the notifications router can depend on them without
 * importing each other.
 */

export type IssuePayload = {
  id: string;
  sequence_id: number;
  name: string;
  state_name: string | null;
  state_group: string | null;
  priority: string | null;
};

export type ActorPayload = {
  id: string;
  display_name: string;
  email: string;
};

export type StateChangePayload = {
  from_name: string | null;
  from_group: string | null;
  to_name: string | null;
  to_group: string | null;
};

export type DmTarget = {
  plane_user_id: string;
  slack_user_id: string;
};

export type WorkItemEvent = {
  event_type:
    | "work_item.created"
    | "work_item.updated"
    | "work_item.state_changed"
    | "work_item.commented"
    | "work_item.completed";
  activity_type: string;
  workspace_slug: string;
  workspace_id: string;
  project_id: string;
  project_identifier: string;
  // Integration mapping types live on the project (e.g.
  // "slack-channel-notification", "github-repo"). Dispatchers gate
  // themselves on this so we don't, say, build GH state for a
  // Slack-only project.
  live_mapping_types: string[];
  issue:
    | (IssuePayload & {
        description_html?: string;
        state_id?: string | null;
        labels?: { id: string; name: string }[];
      })
    | null;
  actor: ActorPayload | null;
  comment_text: string | null;
  comment?: { id: string; comment_html: string } | null;
  state_change: StateChangePayload | null;
  dm_targets: DmTarget[];
  // Plane user_id → external login map used by integration-specific
  // mention rewrites (currently only GitHub: rewrites
  // `<mention-component>` tags into `@gh_login`). Empty / absent
  // when no mapped users are mentioned in the event's html bodies.
  mention_map?: Record<string, string>;
};

// A dispatcher decides whether it cares about an event (based on
// live_mapping_types + event_type) and, if so, fans it out to its
// integration's API. Each integration owns its own dispatcher.
export type IntegrationDispatcher = {
  name: string;
  // The WorkspaceEntityConnection.type this dispatcher handles. Used
  // for the gate against `live_mapping_types`.
  mappingType: string;
  dispatch: (event: WorkItemEvent, webBaseUrl: string) => Promise<void>;
};

export type ProjectMapping = {
  id: string;
  workspace_connection_id: string;
  connection_type: string;
  connection_team_id: string;
  project_id: string | null;
  type: string;
  entity_type: string;
  entity_id: string;
  entity_slug: string | null;
  config: { events?: string[] } | null;
};
