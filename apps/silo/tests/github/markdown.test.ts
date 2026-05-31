/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Spec for the GH→Plane GFM-task-list rewriter. `marked` emits the
 * GFM shape (`<ul><li><input type="checkbox" disabled> …</li></ul>`),
 * which Plane's tiptap drops on its way through the editor's content
 * sanitizer. This rewriter reshapes it into tiptap's
 * `<ul data-type="taskList">…<li data-type="taskItem"
 * data-checked="…">…</li></ul>` form so the items become real,
 * toggleable task list items in Plane.
 */

import { marked } from "marked";
import { describe, expect, it } from "vitest";

import { convertTaskLists } from "../../src/github/markdown";

describe("convertTaskLists", () => {
  it("returns the input unchanged when there's no checkbox", () => {
    const html = "<ul><li>regular bullet</li></ul>";
    expect(convertTaskLists(html)).toBe(html);
  });

  it("returns empty string for empty input", () => {
    expect(convertTaskLists("")).toBe("");
  });

  it("rewrites a single unchecked GFM task list", () => {
    const md = "- [ ] thing\n";
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const out = convertTaskLists(html);
    expect(out).toContain('<ul data-type="taskList">');
    expect(out).toContain('<li data-type="taskItem" data-checked="false">');
    expect(out).not.toContain("<input");
    expect(out).toContain("thing");
  });

  it("rewrites a single checked GFM task list", () => {
    const md = "- [x] done\n";
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const out = convertTaskLists(html);
    expect(out).toContain('<li data-type="taskItem" data-checked="true">');
    expect(out).toContain("done");
  });

  it("rewrites mixed checked/unchecked items in one list", () => {
    const md = "- [ ] a\n- [x] b\n- [ ] c\n";
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const out = convertTaskLists(html);
    const checks = [...out.matchAll(/data-checked="(true|false)"/g)].map((m) => m[1]);
    expect(checks).toEqual(["false", "true", "false"]);
  });

  it("leaves a non-task <ul> alone even when a task <ul> sits next to it", () => {
    const md = "- plain bullet\n\n---\n\n- [x] task\n";
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const out = convertTaskLists(html);
    // The plain bullet list stays as-is.
    expect(out).toMatch(/<ul>\s*<li>plain bullet<\/li>\s*<\/ul>/);
    // The task list is rewritten.
    expect(out).toContain('<ul data-type="taskList">');
    expect(out).toContain('data-checked="true"');
  });

  it("strips marked's wrapper attrs (e.g. class='contains-task-list')", () => {
    // Some marked configs add `class="contains-task-list"` on the <ul>
    // and `class="task-list-item"` on each <li>. The rewriter should
    // not preserve them — Plane's editor would render them as opaque
    // class names with no meaning.
    const html =
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> x</li></ul>';
    const out = convertTaskLists(html);
    expect(out).not.toContain("contains-task-list");
    expect(out).not.toContain("task-list-item");
    expect(out).toContain('<ul data-type="taskList">');
  });

  it("preserves checkbox inside <li> when the <li> already has other content", () => {
    const html = '<ul><li><input type="checkbox" disabled> hello <strong>world</strong></li></ul>';
    const out = convertTaskLists(html);
    expect(out).toContain("<strong>world</strong>");
    expect(out).toContain('data-checked="false"');
  });
});
