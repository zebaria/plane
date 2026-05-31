/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4f FE: PrStateMapModal CRUD branches. We don't render the
 * surrounding bindings card — just the modal — and stub the silo
 * service + project/state stores so the component is the only thing
 * under test.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { createEntityConnection, updateEntityConnection, deleteEntityConnection } = vi.hoisted(() => ({
  createEntityConnection: vi.fn(),
  updateEntityConnection: vi.fn(),
  deleteEntityConnection: vi.fn(),
}));

vi.mock("@/services/integrations", () => ({
  SiloIntegrationService: class {
    createEntityConnection = createEntityConnection;
    updateEntityConnection = updateEntityConnection;
    deleteEntityConnection = deleteEntityConnection;
  },
}));

const projectStates: Record<string, Array<{ id: string; name: string; group: string }>> = {
  p1: [
    { id: "S_BACKLOG", name: "Backlog", group: "backlog" },
    { id: "S_DONE", name: "Done", group: "completed" },
  ],
};

vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    joinedProjectIds: ["p1"],
    getProjectById: (id: string) => (id === "p1" ? { id: "p1", name: "Test Project" } : null),
  }),
}));

vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({
    getProjectStates: (pid: string) => projectStates[pid],
    fetchProjectStates: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
}));

// `@plane/ui` and `@plane/propel/button` pull in heavy bundles; stub
// to bare-bones DOM so the modal renders in jsdom.
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XL: "xl" },
}));

vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick, disabled, loading }: any) => (
    <button onClick={onClick} disabled={disabled || loading}>
      {children}
    </button>
  ),
}));

import { PrStateMapModal } from "@/components/integration/github-repo-bindings/pr-state-map-modal";
import type { WorkspaceEntityConnection } from "@/services/integrations";

const wsRow = (overrides: Partial<WorkspaceEntityConnection> = {}): WorkspaceEntityConnection => ({
  id: "row-ws",
  workspace_id: "w1",
  workspace_connection_id: "wc1",
  project_id: null,
  issue_id: null,
  type: "github-pr-state-map",
  entity_type: "pr-state-map",
  entity_id: "workspace",
  entity_slug: null,
  entity_data: null,
  config: { prStateMap: { merged: "S_DONE" } },
  ...overrides,
});

const baseProps = {
  workspaceSlug: "ws",
  workspaceConnectionId: "wc1",
  onClose: vi.fn(),
  onSuccess: vi.fn().mockResolvedValue(undefined),
};

const clickSave = () => fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

describe("PrStateMapModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new workspace-default row when none exists", async () => {
    render(<PrStateMapModal {...baseProps} rows={[]} />);

    // Switch to project tab so the picker has options (workspace tab
    // shows grouped options across all projects, same store).
    fireEvent.click(screen.getByRole("button", { name: /Test Project/ }));

    const draftSelect = screen.getByLabelText(/Draft →/) as HTMLSelectElement;
    fireEvent.change(draftSelect, { target: { value: "S_BACKLOG" } });

    clickSave();

    await waitFor(() => expect(createEntityConnection).toHaveBeenCalledTimes(1));
    const [, body] = createEntityConnection.mock.calls[0];
    expect(body.project_id).toBe("p1");
    expect(body.type).toBe("github-pr-state-map");
    expect(body.config).toEqual({ prStateMap: { draft: "S_BACKLOG" } });
    expect(updateEntityConnection).not.toHaveBeenCalled();
    expect(deleteEntityConnection).not.toHaveBeenCalled();
  });

  it("updates an existing row when one is present for the scope", async () => {
    render(<PrStateMapModal {...baseProps} rows={[wsRow()]} />);

    // Workspace tab is active by default; the existing map seeded
    // `merged: S_DONE`. Add a `draft` and Save.
    const draftSelect = screen.getByLabelText(/Draft →/) as HTMLSelectElement;
    fireEvent.change(draftSelect, { target: { value: "S_BACKLOG" } });

    clickSave();

    await waitFor(() => expect(updateEntityConnection).toHaveBeenCalledTimes(1));
    const [, id, body] = updateEntityConnection.mock.calls[0];
    expect(id).toBe("row-ws");
    expect(body.config).toEqual({
      prStateMap: { merged: "S_DONE", draft: "S_BACKLOG" },
    });
    expect(createEntityConnection).not.toHaveBeenCalled();
  });

  it("deletes the row when the user clears every value", async () => {
    render(<PrStateMapModal {...baseProps} rows={[wsRow()]} />);

    const mergedSelect = screen.getByLabelText(/Merged →/) as HTMLSelectElement;
    fireEvent.change(mergedSelect, { target: { value: "" } });

    clickSave();

    await waitFor(() => expect(deleteEntityConnection).toHaveBeenCalledTimes(1));
    const [, id] = deleteEntityConnection.mock.calls[0];
    expect(id).toBe("row-ws");
    expect(updateEntityConnection).not.toHaveBeenCalled();
    expect(createEntityConnection).not.toHaveBeenCalled();
  });

  it("does nothing on the server when there is no row and the map is empty", async () => {
    render(<PrStateMapModal {...baseProps} rows={[]} />);
    clickSave();
    await waitFor(() => expect(baseProps.onSuccess).toHaveBeenCalled());
    expect(createEntityConnection).not.toHaveBeenCalled();
    expect(updateEntityConnection).not.toHaveBeenCalled();
    expect(deleteEntityConnection).not.toHaveBeenCalled();
  });

  it("loads the per-project row when switching scope", async () => {
    const projRow = wsRow({
      id: "row-proj",
      project_id: "p1",
      config: { prStateMap: { approved: "S_DONE" } },
    });
    render(<PrStateMapModal {...baseProps} rows={[wsRow(), projRow]} />);

    fireEvent.click(screen.getByRole("button", { name: /Test Project/ }));

    const approved = screen.getByLabelText(/Approved →/) as HTMLSelectElement;
    expect(approved.value).toBe("S_DONE");

    // Workspace-only `merged` should NOT bleed across — per-project
    // editor shows the project row's map verbatim.
    const merged = screen.getByLabelText(/Merged →/) as HTMLSelectElement;
    expect(merged.value).toBe("");
  });
});
