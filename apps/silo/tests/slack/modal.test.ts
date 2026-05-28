/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Spec for buildCreateWorkItemView — the Block Kit view shown when
 * a user runs `/lplane`. Covers project picker, dispatch_action for
 * the project-change interaction, and the metadata-driven pickers
 * (type / state / priority / labels / assignees).
 */

import { describe, expect, it } from "vitest";

import { CREATE_WORK_ITEM_CALLBACK, PROJECT_SELECT_ACTION, buildCreateWorkItemView } from "../../src/slack/modal";
import type { ProjectMetadata } from "../../src/slack/project-metadata";

const meta = {
  workspaceSlug: "wz",
  channelId: "C123",
  triggerUserId: "U456",
  installerUserId: "user-id-uuid",
};

const projects = [
  { id: "p1", name: "Backend", identifier: "BE" },
  { id: "p2", name: "Frontend", identifier: "FE" },
];

const fullMeta: ProjectMetadata = {
  states: [
    { id: "s-backlog", name: "Backlog", group: "backlog", color: "#999" },
    { id: "s-todo", name: "Todo", group: "unstarted", color: "#aaa" },
    { id: "s-doing", name: "In Progress", group: "started", color: "#bbb" },
  ],
  defaultStateId: "s-todo",
  labels: [
    { id: "l1", name: "bug", color: "#f00" },
    { id: "l2", name: "feature", color: "#0f0" },
  ],
  members: [
    { id: "u1", display_name: "Alice" },
    { id: "u2", display_name: "Bob" },
  ],
  defaultAssigneeId: "u2",
  types: [
    { id: "t1", name: "Story", is_default: true, is_epic: false },
    { id: "t2", name: "Big Thing", is_default: false, is_epic: true },
  ],
  defaultTypeId: "t1",
  priorities: [
    { key: "urgent", label: "Urgent" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
    { key: "none", label: "None" },
  ],
};

type Block = Record<string, unknown>;
type Element = Record<string, unknown>;
type Option = { text: { text: string }; value: string };

const blocksOf = (view: Record<string, unknown>): Block[] => view.blocks as Block[];
const findBlock = (view: Record<string, unknown>, id: string): Block | undefined =>
  blocksOf(view).find((b) => b.block_id === id);

describe("buildCreateWorkItemView", () => {
  it("uses the canonical callback id (matches interactions handler)", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    expect(view.callback_id).toBe(CREATE_WORK_ITEM_CALLBACK);
  });

  it("round-trips metadata + initialText through private_metadata", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null, "kickoff");
    const decoded = JSON.parse(view.private_metadata as string);
    expect(decoded).toMatchObject(meta);
    expect(decoded.initialText).toBe("kickoff");
  });

  it("renders one option per project with REF — name label", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    const projectBlock = findBlock(view, "project")!;
    const element = projectBlock.element as Element;
    const options = element.options as Option[];
    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("p1");
    expect(options[0].text.text).toBe("BE — Backend");
    expect(options[1].text.text).toBe("FE — Frontend");
  });

  it("project picker has dispatch_action so changes trigger views.update", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    const projectBlock = findBlock(view, "project")!;
    expect(projectBlock.dispatch_action).toBe(true);
    const element = projectBlock.element as Element;
    expect(element.action_id).toBe(PROJECT_SELECT_ACTION);
  });

  it("preselects selectedProjectId via initial_option", () => {
    const view = buildCreateWorkItemView(projects, meta, "p2", null);
    const element = findBlock(view, "project")!.element as Element;
    expect((element.initial_option as Option).value).toBe("p2");
  });

  it("falls back to the first project when selectedProjectId is null", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    const element = findBlock(view, "project")!.element as Element;
    expect((element.initial_option as Option).value).toBe("p1");
  });

  it("clamps project label length to 75 chars (Slack hard limit)", () => {
    const longProjects = [{ id: "p", name: "x".repeat(200), identifier: "ZZ" }];
    const view = buildCreateWorkItemView(longProjects, meta, null, null);
    const element = blocksOf(view)[0].element as Element;
    const options = element.options as Option[];
    expect(options[0].text.text.length).toBeLessThanOrEqual(75);
  });

  it("caps the project picker at 100 options", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      identifier: `P${i}`,
    }));
    const view = buildCreateWorkItemView(many, meta, null, null);
    const element = blocksOf(view)[0].element as Element;
    expect((element.options as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it("falls back to an explainer block + no submit button when no projects exist", () => {
    const view = buildCreateWorkItemView([], meta, null, null);
    expect(view.submit).toBeUndefined();
    expect(blocksOf(view)[0].block_id).toBe("no_projects");
  });

  it("pre-fills initial title text, truncated at 250", () => {
    const longText = "x".repeat(500);
    const view = buildCreateWorkItemView(projects, meta, null, null, longText);
    const titleEl = findBlock(view, "title")!.element as Element;
    expect(titleEl.initial_value).toBe(longText.slice(0, 250));
  });

  it("description is optional", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    const descBlock = findBlock(view, "description")!;
    expect(descBlock.optional).toBe(true);
  });

  it("omits picker blocks when no projectMeta is supplied (degraded modal)", () => {
    const view = buildCreateWorkItemView(projects, meta, null, null);
    expect(findBlock(view, "type")).toBeUndefined();
    expect(findBlock(view, "state")).toBeUndefined();
    expect(findBlock(view, "priority")).toBeUndefined();
    expect(findBlock(view, "labels")).toBeUndefined();
    expect(findBlock(view, "assignees")).toBeUndefined();
  });

  describe("with projectMeta", () => {
    it("renders type picker with default selected", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const block = findBlock(view, "type")!;
      const el = block.element as Element;
      expect(el.action_id).toBe("type_id");
      expect((el.initial_option as Option).value).toBe("t1");
    });

    it("renders state picker with default selected", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const el = findBlock(view, "state")!.element as Element;
      expect(el.action_id).toBe("state_id");
      expect((el.initial_option as Option).value).toBe("s-todo");
      const opts = el.options as Option[];
      expect(opts.map((o) => o.value)).toEqual(["s-backlog", "s-todo", "s-doing"]);
    });

    it("renders priority picker defaulting to 'none'", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const el = findBlock(view, "priority")!.element as Element;
      expect(el.action_id).toBe("priority");
      expect((el.initial_option as Option).value).toBe("none");
    });

    it("renders multi-select labels picker (no preselection)", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const block = findBlock(view, "labels")!;
      expect(block.optional).toBe(true);
      const el = block.element as Element;
      expect(el.type).toBe("multi_static_select");
      expect(el.action_id).toBe("label_ids");
      expect(el.initial_options).toBeUndefined();
    });

    it("renders multi-select assignees picker preselecting the project default", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const el = findBlock(view, "assignees")!.element as Element;
      expect(el.type).toBe("multi_static_select");
      expect(el.action_id).toBe("assignee_ids");
      const initial = el.initial_options as Option[];
      expect(initial).toHaveLength(1);
      expect(initial[0].value).toBe("u2");
    });

    it("skips empty pickers gracefully", () => {
      const sparse: ProjectMetadata = {
        ...fullMeta,
        states: [],
        labels: [],
        members: [],
        types: [],
      };
      const view = buildCreateWorkItemView(projects, meta, "p1", sparse);
      expect(findBlock(view, "state")).toBeUndefined();
      expect(findBlock(view, "labels")).toBeUndefined();
      expect(findBlock(view, "assignees")).toBeUndefined();
      expect(findBlock(view, "type")).toBeUndefined();
      // priority is static so it still renders
      expect(findBlock(view, "priority")).toBeDefined();
    });

    it("annotates epic types in the label", () => {
      const view = buildCreateWorkItemView(projects, meta, "p1", fullMeta);
      const opts = (findBlock(view, "type")!.element as Element).options as Option[];
      const epic = opts.find((o) => o.value === "t2")!;
      expect(epic.text.text).toContain("(epic)");
    });
  });
});
