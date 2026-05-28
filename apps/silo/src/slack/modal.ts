/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack Block Kit view for the "Create Work Item" modal opened from
 * the /plane slash command. Project picker drives the metadata-aware
 * pickers (type, state, priority, labels, assignees) — when the user
 * changes project, the interactions handler re-renders the view with
 * the new project's options via views.update.
 */

import type { ProjectMetadata } from "./project-metadata";
import type { SlackTeamProject } from "./team-context";

export const CREATE_WORK_ITEM_CALLBACK = "plane_create_work_item";
export const PROJECT_SELECT_ACTION = "project_id";

export type CreateWorkItemMetadata = {
  workspaceSlug: string;
  channelId: string;
  triggerUserId: string;
  installerUserId: string | null;
  initialText?: string;
};

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

const buildPriorityBlock = (priorities: ProjectMetadata["priorities"]): Record<string, unknown> | null => {
  if (!priorities.length) return null;
  const options = priorities.map((p) => ({
    text: { type: "plain_text", text: truncate(p.label, 75) },
    value: p.key,
  }));
  const initial = options.find((o) => o.value === "none") ?? options[0];
  return {
    type: "input",
    block_id: "priority",
    optional: true,
    label: { type: "plain_text", text: "Priority" },
    element: {
      type: "static_select",
      action_id: "priority",
      options,
      initial_option: initial,
    },
  };
};

const buildTypeBlock = (meta: ProjectMetadata): Record<string, unknown> | null => {
  if (!meta.types.length) return null;
  const options = meta.types.map((t) => ({
    text: { type: "plain_text", text: truncate(t.is_epic ? `${t.name} (epic)` : t.name, 75) },
    value: t.id,
  }));
  const initial = (meta.defaultTypeId && options.find((o) => o.value === meta.defaultTypeId)) || options[0];
  return {
    type: "input",
    block_id: "type",
    optional: true,
    label: { type: "plain_text", text: "Type" },
    element: {
      type: "static_select",
      action_id: "type_id",
      options,
      initial_option: initial,
    },
  };
};

const buildStateBlock = (meta: ProjectMetadata): Record<string, unknown> | null => {
  if (!meta.states.length) return null;
  const options = meta.states.map((s) => ({
    text: { type: "plain_text", text: truncate(`${s.name} [${s.group}]`, 75) },
    value: s.id,
  }));
  const initial = (meta.defaultStateId && options.find((o) => o.value === meta.defaultStateId)) || options[0];
  return {
    type: "input",
    block_id: "state",
    optional: true,
    label: { type: "plain_text", text: "State" },
    element: {
      type: "static_select",
      action_id: "state_id",
      options,
      initial_option: initial,
    },
  };
};

const buildLabelsBlock = (meta: ProjectMetadata): Record<string, unknown> | null => {
  if (!meta.labels.length) return null;
  const options = meta.labels.slice(0, 100).map((l) => ({
    text: { type: "plain_text", text: truncate(l.name, 75) },
    value: l.id,
  }));
  return {
    type: "input",
    block_id: "labels",
    optional: true,
    label: { type: "plain_text", text: "Labels" },
    element: {
      type: "multi_static_select",
      action_id: "label_ids",
      placeholder: { type: "plain_text", text: "Optional" },
      options,
    },
  };
};

const buildAssigneesBlock = (meta: ProjectMetadata): Record<string, unknown> | null => {
  if (!meta.members.length) return null;
  const options = meta.members.slice(0, 100).map((m) => ({
    text: { type: "plain_text", text: truncate(m.display_name, 75) },
    value: m.id,
  }));
  const initialAssignee = meta.defaultAssigneeId && options.find((o) => o.value === meta.defaultAssigneeId);
  const element: Record<string, unknown> = {
    type: "multi_static_select",
    action_id: "assignee_ids",
    placeholder: { type: "plain_text", text: "Optional" },
    options,
  };
  if (initialAssignee) {
    element.initial_options = [initialAssignee];
  }
  return {
    type: "input",
    block_id: "assignees",
    optional: true,
    label: { type: "plain_text", text: "Assignees" },
    element,
  };
};

export const buildCreateWorkItemView = (
  projects: SlackTeamProject[],
  metadata: CreateWorkItemMetadata,
  selectedProjectId: string | null,
  projectMeta: ProjectMetadata | null,
  initialText = "",
  initialDescription = ""
): Record<string, unknown> => {
  const projectOptions = projects.slice(0, 100).map((p) => ({
    text: { type: "plain_text", text: truncate(`${p.identifier} — ${p.name}`, 75) },
    value: p.id,
  }));

  const effectiveText = initialText || metadata.initialText || "";

  const projectBlock: Record<string, unknown> | null =
    projectOptions.length > 0
      ? (() => {
          const initial =
            (selectedProjectId && projectOptions.find((o) => o.value === selectedProjectId)) || projectOptions[0];
          return {
            type: "input",
            block_id: "project",
            label: { type: "plain_text", text: "Project" },
            // dispatch_action so changing project triggers a
            // block_actions interaction; the handler re-renders this
            // view with metadata for the newly selected project.
            dispatch_action: true,
            element: {
              type: "static_select",
              action_id: PROJECT_SELECT_ACTION,
              placeholder: { type: "plain_text", text: "Select a project" },
              options: projectOptions,
              initial_option: initial,
            },
          };
        })()
      : {
          type: "section",
          block_id: "no_projects",
          text: {
            type: "mrkdwn",
            text: "_No projects in this workspace yet — create one in Plane first._",
          },
        };

  const blocks: Record<string, unknown>[] = [
    projectBlock as Record<string, unknown>,
    {
      type: "input",
      block_id: "title",
      label: { type: "plain_text", text: "Title" },
      element: {
        type: "plain_text_input",
        action_id: "title",
        initial_value: effectiveText.slice(0, 250),
        max_length: 255,
      },
    },
    {
      type: "input",
      block_id: "description",
      optional: true,
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "plain_text_input",
        action_id: "description",
        multiline: true,
        initial_value: initialDescription || undefined,
      },
    },
  ];

  if (projectMeta) {
    for (const block of [
      buildTypeBlock(projectMeta),
      buildStateBlock(projectMeta),
      buildPriorityBlock(projectMeta.priorities),
      buildAssigneesBlock(projectMeta),
      buildLabelsBlock(projectMeta),
    ]) {
      if (block) blocks.push(block);
    }

    // "Add as Intake" — when checked, the work item lands in the
    // project's Intake queue (triage state) instead of the main board.
    // Caller-supplied state is ignored server-side for intake items.
    // Only render if the project has Intake enabled; otherwise the
    // toggle would create a stray Intake the user never opted into.
    if (projectMeta.intakeEnabled) {
      blocks.push({
        type: "input",
        block_id: "as_intake",
        optional: true,
        label: { type: "plain_text", text: " " },
        element: {
          type: "checkboxes",
          action_id: "as_intake",
          options: [
            {
              text: { type: "plain_text", text: "Add as Intake" },
              description: {
                type: "plain_text",
                text: "Send to the project's Intake queue for triage instead of the main board.",
              },
              value: "1",
            },
          ],
        },
      });
    }
  }

  return {
    type: "modal",
    callback_id: CREATE_WORK_ITEM_CALLBACK,
    private_metadata: JSON.stringify({ ...metadata, initialText: effectiveText }),
    title: { type: "plain_text", text: "Create work item" },
    submit: projectOptions.length > 0 ? { type: "plain_text", text: "Create" } : undefined,
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
};
