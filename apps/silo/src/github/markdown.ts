/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * GH→Plane markdown helpers. `marked` produces standard GFM HTML for
 * task lists:
 *
 *   <ul>
 *     <li><input type="checkbox" disabled> task one</li>
 *     <li><input type="checkbox" checked disabled> task two</li>
 *   </ul>
 *
 * Plane's tiptap editor renders task lists from a different shape:
 *
 *   <ul data-type="taskList">
 *     <li data-type="taskItem" data-checked="false">…</li>
 *     <li data-type="taskItem" data-checked="true">…</li>
 *   </ul>
 *
 * Without the rewrite, GH checkboxes render as plain bullets in Plane
 * (the `<input>` is stripped by tiptap's content sanitizer) and the
 * items can't be toggled. This module rewrites the GFM shape into
 * tiptap's shape on its way into Django.
 */

const TASK_INPUT_RE = /<input[^>]*type=["']checkbox["'][^>]*>/i;
const CHECKED_ATTR_RE = /\bchecked\b/i;

// Find any <ul>...</ul> whose first <li> contains a checkbox input,
// and rewrite the whole list as a tiptap taskList. Lists without
// checkboxes are left alone (regular bullet lists in Plane).
//
// We deliberately stop at the first level — nested task lists in GH
// issue bodies are rare, and prosemirror's nested taskList support is
// inconsistent across Plane editor variants. If/when we need them,
// recurse on the inner html before substituting.
export const convertTaskLists = (html: string): string => {
  if (!html || !TASK_INPUT_RE.test(html)) return html;

  return html.replace(/<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi, (full, attrs: string, inner: string) => {
    if (!TASK_INPUT_RE.test(inner)) return full;

    const items = inner.replace(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi, (liFull, _liAttrs: string, liInner: string) => {
      const inputMatch = liInner.match(/<input[^>]*type=["']checkbox["'][^>]*>/i);
      if (!inputMatch) return liFull; // not a task item — leave it
      const checked = CHECKED_ATTR_RE.test(inputMatch[0]);
      const rest = liInner.replace(/<input[^>]*type=["']checkbox["'][^>]*>\s*/i, "");
      return `<li data-type="taskItem" data-checked="${checked}">${rest}</li>`;
    });

    // Drop class attrs marked sometimes adds (e.g. "contains-task-list")
    // and replace the wrapper with the tiptap shape.
    void attrs;
    return `<ul data-type="taskList">${items}</ul>`;
  });
};
