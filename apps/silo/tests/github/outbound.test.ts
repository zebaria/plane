/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Spec for the Plane → GitHub outbound mirror's pure helpers. The
 * I/O paths (callGithub, callDjango) are covered by the dispatch
 * integration tests; this file pins down the decision logic that
 * drives them: state mapping, direction gating, mirror-gate, and
 * the HTML→markdown converter.
 */

import { describe, expect, it } from "vitest";

import type { RepoBinding } from "../../src/github/django";
import {
  ghStateForPlaneState,
  htmlToMarkdown,
  isBidirectional,
  passesOutboundGate,
  rewriteMentionsForGithub,
} from "../../src/github/outbound";

const baseBinding: RepoBinding = {
  id: "b1",
  workspace_id: "w1",
  workspace_slug: "wz",
  workspace_connection_id: "wc1",
  installation_id: "1234" as unknown as string,
  project_id: "p1",
  entity_id: "999",
  entity_slug: "zebaria/plane",
  config: {},
};

describe("htmlToMarkdown", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("turns headings into atx markdown", () => {
    expect(htmlToMarkdown("<h3>Summary</h3>")).toBe("### Summary");
  });

  it("converts unordered lists with the configured bullet", () => {
    // Turndown uses an indented bullet (`-   item`) by default; we just
    // care that it picked our `-` marker, not `*` or `+`.
    const md = htmlToMarkdown("<ul><li>a</li><li>b</li></ul>");
    expect(md).toMatch(/^-\s+a/m);
    expect(md).toMatch(/^-\s+b/m);
  });

  it("converts <strong> and <em> to markdown emphasis", () => {
    expect(htmlToMarkdown("<p><strong>bold</strong></p>")).toContain("**bold**");
    expect(htmlToMarkdown("<p><em>italic</em></p>")).toContain("_italic_");
  });

  it("preserves links as inline markdown", () => {
    const md = htmlToMarkdown('<a href="https://x.test">click</a>');
    expect(md).toBe("[click](https://x.test)");
  });
});

describe("isBidirectional", () => {
  it("treats missing direction as bidirectional (default)", () => {
    expect(isBidirectional({ ...baseBinding, config: {} })).toBe(true);
  });

  it("treats explicit 'bi' as bidirectional", () => {
    expect(isBidirectional({ ...baseBinding, config: { direction: "bi" } })).toBe(true);
  });

  it("blocks outbound for 'uni' bindings", () => {
    expect(isBidirectional({ ...baseBinding, config: { direction: "uni" } })).toBe(false);
  });
});

describe("ghStateForPlaneState", () => {
  const binding = {
    ...baseBinding,
    config: { issueStateMap: { open: "STATE_OPEN", closed: "STATE_CLOSED" } },
  };

  it("returns 'closed' when state_id matches map.closed", () => {
    expect(ghStateForPlaneState(binding, "STATE_CLOSED", null)).toBe("closed");
  });

  it("returns 'open' when state_id matches map.open", () => {
    expect(ghStateForPlaneState(binding, "STATE_OPEN", null)).toBe("open");
  });

  it("falls back to state_group when explicit map doesn't match", () => {
    expect(ghStateForPlaneState(binding, "OTHER", "completed")).toBe("closed");
    expect(ghStateForPlaneState(binding, "OTHER", "cancelled")).toBe("closed");
    expect(ghStateForPlaneState(binding, "OTHER", "started")).toBe("open");
    expect(ghStateForPlaneState(binding, "OTHER", "backlog")).toBe("open");
    expect(ghStateForPlaneState(binding, "OTHER", "unstarted")).toBe("open");
  });

  it("returns undefined when neither map nor group resolves", () => {
    expect(ghStateForPlaneState(binding, "OTHER", "weird")).toBeUndefined();
    expect(ghStateForPlaneState(binding, null, null)).toBeUndefined();
  });

  it("works without an issueStateMap (group-only mode)", () => {
    const noMap = { ...baseBinding, config: {} };
    expect(ghStateForPlaneState(noMap, "STATE_X", "completed")).toBe("closed");
    expect(ghStateForPlaneState(noMap, "STATE_X", "started")).toBe("open");
  });
});

describe("rewriteMentionsForGithub", () => {
  it("returns empty string for null/undefined", () => {
    expect(rewriteMentionsForGithub(null, {})).toBe("");
    expect(rewriteMentionsForGithub(undefined, {})).toBe("");
  });

  it("passes html through untouched when no mention-component is present", () => {
    const html = "<p>just text</p>";
    expect(rewriteMentionsForGithub(html, { "uid-1": "alice" })).toBe(html);
  });

  it("rewrites a mapped user as @gh_login", () => {
    const html =
      '<p>hey <mention-component entity_name="user_mention" entity_identifier="uid-1">@Alice</mention-component> ping</p>';
    const out = rewriteMentionsForGithub(html, { "uid-1": "alice-gh" });
    expect(out).toBe("<p>hey @alice-gh ping</p>");
  });

  it("falls back to display name with whitespace stripped when user is unmapped", () => {
    const html =
      '<p><mention-component entity_name="user_mention" entity_identifier="uid-x">@Erik Selberg</mention-component></p>';
    expect(rewriteMentionsForGithub(html, {})).toBe("<p>@ErikSelberg</p>");
  });

  it("does not touch non-user mention-component types", () => {
    const html =
      '<mention-component entity_name="project_mention" entity_identifier="proj-1">#Proj</mention-component>';
    expect(rewriteMentionsForGithub(html, {})).toBe("#Proj");
  });

  it("rewrites multiple mentions independently in one pass", () => {
    const html =
      '<p><mention-component entity_name="user_mention" entity_identifier="u1">@A</mention-component> and <mention-component entity_name="user_mention" entity_identifier="u2">@B</mention-component></p>';
    expect(rewriteMentionsForGithub(html, { u1: "alice-gh", u2: "bob-gh" })).toBe("<p>@alice-gh and @bob-gh</p>");
  });
});

describe("passesOutboundGate", () => {
  it("admits everything when mirrorAllIssues is unset (default true)", () => {
    expect(passesOutboundGate({ ...baseBinding, config: {} }, [])).toBe(true);
  });

  it("admits everything when mirrorAllIssues=true", () => {
    expect(passesOutboundGate({ ...baseBinding, config: { mirrorAllIssues: true } }, [])).toBe(true);
  });

  it("requires the Plane label when mirrorAllIssues=false", () => {
    const b = { ...baseBinding, config: { mirrorAllIssues: false } };
    expect(passesOutboundGate(b, [])).toBe(false);
    expect(passesOutboundGate(b, [{ id: "1", name: "bug" }])).toBe(false);
    expect(passesOutboundGate(b, [{ id: "2", name: "Plane" }])).toBe(true);
  });

  it("treats missing labels list as empty (no implicit pass)", () => {
    expect(passesOutboundGate({ ...baseBinding, config: { mirrorAllIssues: false } }, undefined)).toBe(false);
  });
});
