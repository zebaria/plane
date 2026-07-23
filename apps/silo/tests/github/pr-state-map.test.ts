/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Pure-helper spec for the PR state map (Phase 4f). Maps a
 * `pull_request` / `pull_request_review` event to one of the 6 PR
 * state keys (`draft`, `opened`, `review_requested`, `approved`,
 * `merged`, `closed_without_merge`). The integration with binding
 * lookup + Django config fetch is covered by the handler test suite.
 */

import { describe, expect, it } from "vitest";

import { prStateKeyForPullRequest, prStateKeyForReview } from "@/github/handlers/pull-request";

const basePr = {
  id: 1,
  number: 1,
  title: "t",
  body: "",
  state: "open" as const,
  user: { login: "alice", id: 1 },
  html_url: "https://github.com/zebaria/plane/pull/1",
};

describe("prStateKeyForPullRequest", () => {
  it("opened on a draft PR → draft", () => {
    expect(
      prStateKeyForPullRequest({
        action: "opened",
        pull_request: { ...basePr, draft: true },
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("draft");
  });

  it("opened on a non-draft → opened", () => {
    expect(
      prStateKeyForPullRequest({
        action: "opened",
        pull_request: { ...basePr, draft: false },
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("opened");
  });

  it("ready_for_review → review_requested", () => {
    expect(
      prStateKeyForPullRequest({
        action: "ready_for_review",
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("review_requested");
  });

  it("review_requested → review_requested", () => {
    expect(
      prStateKeyForPullRequest({
        action: "review_requested",
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("review_requested");
  });

  it("converted_to_draft → draft", () => {
    expect(
      prStateKeyForPullRequest({
        action: "converted_to_draft",
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("draft");
  });

  it("closed + merged → merged", () => {
    expect(
      prStateKeyForPullRequest({
        action: "closed",
        pull_request: { ...basePr, merged: true, state: "closed" },
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("merged");
  });

  it("closed without merge → closed_without_merge", () => {
    expect(
      prStateKeyForPullRequest({
        action: "closed",
        pull_request: { ...basePr, merged: false, state: "closed" },
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("closed_without_merge");
  });

  it("reopened → opened", () => {
    expect(
      prStateKeyForPullRequest({
        action: "reopened",
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("opened");
  });

  it("synchronize / edited / labeled → undefined (leave state alone)", () => {
    for (const action of ["synchronize", "edited", "labeled", "unlabeled"]) {
      expect(
        prStateKeyForPullRequest({
          action,
          pull_request: basePr,
          repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
        })
      ).toBeUndefined();
    }
  });
});

describe("prStateKeyForReview", () => {
  it("submitted + approved → approved", () => {
    expect(
      prStateKeyForReview({
        action: "submitted",
        review: { state: "approved", user: { login: "alice", id: 1 } },
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBe("approved");
  });

  it("submitted + changes_requested → undefined (not in the 6 keys)", () => {
    expect(
      prStateKeyForReview({
        action: "submitted",
        review: { state: "changes_requested", user: { login: "alice", id: 1 } },
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBeUndefined();
  });

  it("submitted + commented → undefined", () => {
    expect(
      prStateKeyForReview({
        action: "submitted",
        review: { state: "commented", user: { login: "alice", id: 1 } },
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBeUndefined();
  });

  it("dismissed (any state) → undefined", () => {
    expect(
      prStateKeyForReview({
        action: "dismissed",
        review: { state: "approved", user: { login: "alice", id: 1 } },
        pull_request: basePr,
        repository: { id: 1, full_name: "zebaria/plane", name: "plane" },
      })
    ).toBeUndefined();
  });
});
