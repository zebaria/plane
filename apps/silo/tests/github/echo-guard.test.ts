/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Echo-loop guard spec for the inbound `issues` and `issue_comment`
 * handlers. Plane → silo (outbound) posts to GitHub via the App's
 * installation token, which presents as `<app-name>[bot]` /
 * `user.type === "Bot"`. Without a guard, every silo-posted GH
 * comment fires `issue_comment` → Plane comment → outbound → GH
 * comment → … forever.
 *
 * The handlers should short-circuit before they call Django for a
 * binding lookup. We assert that by stubbing `fetchRepoBindings` and
 * checking it was never called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/django", () => ({
  fetchRepoBindings: vi.fn().mockResolvedValue([]),
  lookupIssueLink: vi.fn(),
  persistIssueLink: vi.fn(),
  createPlaneWorkItem: vi.fn(),
  updatePlaneWorkItem: vi.fn(),
  createPlaneComment: vi.fn(),
  editPlaneComment: vi.fn(),
  deletePlaneComment: vi.fn(),
}));

vi.mock("../../src/django-client", () => ({
  callDjango: vi.fn().mockResolvedValue({ status: 404, data: {} }),
}));

import { fetchRepoBindings } from "../../src/github/django";
import { handleIssueCommentEvent } from "../../src/github/handlers/issue-comment";
import { handleIssuesEvent } from "../../src/github/handlers/issues";

const mocked = fetchRepoBindings as unknown as ReturnType<typeof vi.fn>;

describe("issue_comment echo guard", () => {
  beforeEach(() => {
    mocked.mockClear();
  });

  it("skips comments authored by a bot (`user.type === 'Bot'`)", async () => {
    await handleIssueCommentEvent({
      action: "created",
      issue: { id: 1, number: 1 },
      comment: { id: 100, body: "echo", user: { login: "human", id: 1, type: "Bot" } },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("skips comments whose login ends with '[bot]'", async () => {
    await handleIssueCommentEvent({
      action: "created",
      issue: { id: 1, number: 1 },
      comment: {
        id: 100,
        body: "echo",
        user: { login: "plane-zebaria-local[bot]", id: 99 },
      },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("admits comments from real users (proceeds to bindings lookup)", async () => {
    await handleIssueCommentEvent({
      action: "created",
      issue: { id: 1, number: 1 },
      comment: { id: 100, body: "real", user: { login: "alice", id: 7 } },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
    });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("still bails when the issue is a PR (pre-existing PR shell guard)", async () => {
    await handleIssueCommentEvent({
      action: "created",
      issue: { id: 1, number: 1, pull_request: {} },
      comment: { id: 100, body: "PR comment", user: { login: "alice", id: 7 } },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
    });
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe("issues echo guard", () => {
  beforeEach(() => {
    mocked.mockClear();
  });

  it("skips events whose sender is a bot", async () => {
    await handleIssuesEvent({
      action: "edited",
      issue: {
        id: 1,
        number: 1,
        title: "x",
        body: "y",
        state: "open",
        labels: [],
        user: { login: "alice", id: 1 },
        assignees: [],
      },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
      sender: { login: "plane-zebaria-local[bot]", id: 99, type: "Bot" },
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("skips events whose sender login ends with '[bot]' even without type", async () => {
    await handleIssuesEvent({
      action: "edited",
      issue: {
        id: 1,
        number: 1,
        title: "x",
        body: "y",
        state: "open",
        labels: [],
        user: { login: "alice", id: 1 },
        assignees: [],
      },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
      sender: { login: "some-app[bot]", id: 42 },
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("admits human senders", async () => {
    await handleIssuesEvent({
      action: "edited",
      issue: {
        id: 1,
        number: 1,
        title: "x",
        body: "y",
        state: "open",
        labels: [],
        user: { login: "alice", id: 1 },
        assignees: [],
      },
      repository: { id: 7, full_name: "zebaria/plane", name: "plane" },
      installation: { id: 5 },
      sender: { login: "alice", id: 1, type: "User" },
    });
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
