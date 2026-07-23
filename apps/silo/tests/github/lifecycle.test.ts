/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Spec for the GitHub install lifecycle handlers — specifically the
 * label-seeding behavior and the 422 idempotency contract.
 *
 * On `installation.created` and `installation_repositories.added`,
 * silo POSTs `Plane` and `GitHub` labels onto each affected repo so
 * the inbound mirror gates have something to gate on. GitHub returns
 * 422 ("already_exists") if the label is present — we MUST treat
 * that as success, otherwise re-installs spam log noise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/api", () => ({
  callGithub: vi.fn(),
}));

vi.mock("../../src/django-client", () => ({
  callDjango: vi.fn().mockResolvedValue({ status: 200, data: {} }),
}));

import { callGithub } from "@/github/api";
import { handleInstallationEvent, handleInstallationRepositoriesEvent } from "@/github/handlers/lifecycle";

const mockedCallGh = callGithub as unknown as ReturnType<typeof vi.fn>;

describe("handleInstallationEvent — label seeding", () => {
  beforeEach(() => {
    mockedCallGh.mockReset();
  });

  it("seeds Plane and GitHub labels on every selected repo on install", async () => {
    mockedCallGh.mockResolvedValue({ status: 201 });
    await handleInstallationEvent({
      action: "created",
      installation: { id: 42 },
      repositories: [
        { id: 1, full_name: "zebaria/a", name: "a" },
        { id: 2, full_name: "zebaria/b", name: "b" },
      ],
    });
    // 2 repos * 2 labels = 4 calls
    expect(mockedCallGh).toHaveBeenCalledTimes(4);
    const labelNames = mockedCallGh.mock.calls.map((c) => (c[3] as { name: string }).name).toSorted();
    expect(labelNames).toEqual(["GitHub", "GitHub", "Plane", "Plane"]);
  });

  it("treats 422 (already_exists) as success — no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedCallGh.mockResolvedValue({ status: 422 });
    await handleInstallationEvent({
      action: "created",
      installation: { id: 42 },
      repositories: [{ id: 1, full_name: "zebaria/a", name: "a" }],
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns on non-201/422 statuses but doesn't throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedCallGh.mockResolvedValue({ status: 500 });
    await expect(
      handleInstallationEvent({
        action: "created",
        installation: { id: 42 },
        repositories: [{ id: 1, full_name: "zebaria/a", name: "a" }],
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does NOT seed labels on uninstall (delete is destructive)", async () => {
    mockedCallGh.mockResolvedValue({ status: 201 });
    await handleInstallationEvent({
      action: "deleted",
      installation: { id: 42 },
      repositories: [{ id: 1, full_name: "zebaria/a", name: "a" }],
    });
    expect(mockedCallGh).not.toHaveBeenCalled();
  });

  it("logs and no-ops on suspend/unsuspend (no v1 handling)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockedCallGh.mockResolvedValue({ status: 201 });
    await handleInstallationEvent({
      action: "suspend",
      installation: { id: 42 },
    });
    expect(mockedCallGh).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("handleInstallationRepositoriesEvent — label seeding", () => {
  beforeEach(() => {
    mockedCallGh.mockReset();
  });

  it("seeds labels on newly added repos only (not on removed)", async () => {
    mockedCallGh.mockResolvedValue({ status: 201 });
    await handleInstallationRepositoriesEvent({
      action: "added",
      installation: { id: 42 },
      repositories_added: [{ id: 1, full_name: "zebaria/new", name: "new" }],
      repositories_removed: [{ id: 2, full_name: "zebaria/old", name: "old" }],
    });
    expect(mockedCallGh).toHaveBeenCalledTimes(2); // 1 added repo * 2 labels
    const targets = mockedCallGh.mock.calls.map((c) => c[2]);
    expect(targets.every((p) => (p as string).startsWith("/repos/zebaria/new/"))).toBe(true);
  });
});
