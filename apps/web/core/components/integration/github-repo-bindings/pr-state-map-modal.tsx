/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Phase 4f: workspace + per-project PR state map editor.
 *
 * The PR state map maps each of the 6 PR-lifecycle keys
 * (`draft`, `opened`, `review_requested`, `approved`, `merged`,
 * `closed_without_merge`) to a Plane state_id. Silo reads this on
 * each `pull_request` / `pull_request_review` event to flip the
 * linked Plane work item's state. An empty value means "leave Plane
 * state alone for that transition" — useful for installs that only
 * care about merge events.
 *
 * Storage: `WorkspaceEntityConnection(type='github-pr-state-map')`
 * rows. Workspace default is the row with `project_id IS NULL`;
 * per-project overrides set `project_id=<pid>`. Resolution (default
 * + override merge) happens server-side in
 * `SiloGithubPrStateMapEndpoint`; here we just manage CRUD.
 */

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";

import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { SiloIntegrationService } from "@/services/integrations";
import type { WorkspaceEntityConnection } from "@/services/integrations";

const silo = new SiloIntegrationService();

export const PR_STATE_MAP_TYPE = "github-pr-state-map";

const PR_STATE_KEYS = [
  { key: "draft", label: "Draft" },
  { key: "opened", label: "Opened" },
  { key: "review_requested", label: "Review requested" },
  { key: "approved", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "closed_without_merge", label: "Closed without merge" },
] as const;

export type PrStateKey = (typeof PR_STATE_KEYS)[number]["key"];
export type PrStateMap = Partial<Record<PrStateKey, string>>;

type Scope = "workspace" | { kind: "project"; projectId: string };

const scopeKey = (s: Scope) => (s === "workspace" ? "workspace" : `project:${s.projectId}`);

type Props = {
  workspaceSlug: string;
  workspaceConnectionId: string;
  rows: WorkspaceEntityConnection[];
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
};

export const PrStateMapModal = observer(function PrStateMapModal({
  workspaceSlug,
  workspaceConnectionId,
  rows,
  onClose,
  onSuccess,
}: Props) {
  const projectStore = useProject();
  const stateStore = useProjectState();

  // Computed inline (not useMemo) so the mobx observer recomputes when
  // joinedProjectIds changes — a [projectStore]-keyed memo would go
  // stale because the store ref is stable across project-list changes.
  const projects = projectStore.joinedProjectIds
    .map((id) => projectStore.getProjectById(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const [scope, setScope] = useState<Scope>("workspace");
  const [submitting, setSubmitting] = useState(false);
  const [draftMap, setDraftMap] = useState<PrStateMap>({});

  // Find the row for the selected scope. Workspace default = the one
  // with project_id == null; per-project = matching project_id.
  const currentRow = useMemo(() => {
    if (scope === "workspace") return rows.find((r) => r.project_id == null);
    return rows.find((r) => r.project_id === scope.projectId);
  }, [rows, scope]);

  // Reset the editor when the user switches scopes — show the saved
  // map for that scope (not a stale draft from a previous tab).
  useEffect(() => {
    const cfg = (currentRow?.config as { prStateMap?: PrStateMap } | null) ?? null;
    setDraftMap({ ...cfg?.prStateMap });
  }, [currentRow, scope]);

  // For per-project scope, fetch project states; for workspace scope,
  // fetch states across the workspace and group by project so the
  // user can see the picker isn't tied to one project's state list.
  const projectIdForStates = scope === "workspace" ? null : scope.projectId;
  useEffect(() => {
    if (!projectIdForStates) return;
    const existing = stateStore.getProjectStates(projectIdForStates);
    if (!existing) {
      stateStore.fetchProjectStates(workspaceSlug, projectIdForStates).catch(() => {});
    }
  }, [projectIdForStates, workspaceSlug, stateStore]);

  // Computed inline (not useMemo) so the mobx observer recomputes when
  // the underlying observables change — `getProjectStates` populates
  // asynchronously after the fetch below, and a useMemo keyed on the
  // (stable) store refs would never see it, leaving the dropdown empty.
  //
  // For workspace scope, pull all workspace states (one fetch covers
  // every project); for project scope, the project-states list is fine.
  // The workspace-default map writes the *same* state id everywhere,
  // which is wrong if states aren't shared across projects. Plane
  // doesn't share states across projects, so the workspace-default
  // picker shows all states across all projects (grouped), expected to
  // be used only when projects mirror the same state machine.
  const stateOptions =
    scope === "workspace"
      ? projectStore.joinedProjectIds.flatMap((pid) => {
          const proj = projectStore.getProjectById(pid);
          const states = stateStore.getProjectStates(pid) ?? [];
          return states.map((s) => ({
            id: s.id,
            label: `${proj?.name ?? "?"} · ${s.name} (${s.group})`,
          }));
        })
      : (stateStore.getProjectStates(scope.projectId) ?? []).map((s) => ({
          id: s.id,
          label: `${s.name} (${s.group})`,
        }));

  // For workspace-scope, eagerly fetch states for each project so the
  // grouped dropdown actually populates. Cheap (one cached call per
  // project) and only runs while the workspace tab is active.
  useEffect(() => {
    if (scope !== "workspace") return;
    for (const pid of projectStore.joinedProjectIds) {
      if (!stateStore.getProjectStates(pid)) {
        stateStore.fetchProjectStates(workspaceSlug, pid).catch(() => {});
      }
    }
  }, [scope, projectStore.joinedProjectIds, stateStore, workspaceSlug]);

  const handleSave = async () => {
    setSubmitting(true);
    try {
      // Empty-string entries are dropped server-side (silo absent ⇒
      // "leave state alone"), so we can let the user clear by selecting
      // the empty option without an extra delete step.
      const cleanMap: PrStateMap = {};
      for (const [k, v] of Object.entries(draftMap)) {
        if (v) cleanMap[k as PrStateKey] = v;
      }

      const allEmpty = Object.keys(cleanMap).length === 0;

      if (currentRow) {
        if (allEmpty) {
          await silo.deleteEntityConnection(workspaceSlug, currentRow.id);
        } else {
          await silo.updateEntityConnection(workspaceSlug, currentRow.id, {
            config: { prStateMap: cleanMap },
          });
        }
      } else {
        if (allEmpty) {
          // Nothing to save — same as not having a row at all.
        } else {
          await silo.createEntityConnection(workspaceSlug, {
            workspace_connection_id: workspaceConnectionId,
            // Workspace-scope rows: send the workspace's own id as a
            // pseudo-project_id is wrong — the BE expects nullable
            // project_id for the workspace default. The serializer
            // accepts null here.
            project_id: scope === "workspace" ? (null as unknown as string) : scope.projectId,
            type: PR_STATE_MAP_TYPE,
            entity_type: "pr-state-map",
            entity_id: scope === "workspace" ? "workspace" : scope.projectId,
            config: { prStateMap: cleanMap },
          });
        }
      }
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "PR state map saved",
      });
      await onSuccess();
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Save failed",
        message: (e as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const setKey = (k: PrStateKey, v: string) => {
    setDraftMap((prev) => ({ ...prev, [k]: v }));
  };

  return (
    <ModalCore
      isOpen
      handleClose={submitting ? () => {} : onClose}
      position={EModalPosition.CENTER}
      width={EModalWidth.XL}
    >
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h3 className="text-heading-md-semibold">PR state automation</h3>
          <p className="text-body-xs-regular text-secondary">
            When a GitHub PR references a Plane work item (e.g. <code>[TST-123]</code>), silo flips the linked Plane
            work item to the state below for each PR transition. Leave a row blank to skip that transition. Per-project
            entries override the workspace default.
          </p>
        </div>

        <div className="flex flex-wrap gap-1 border-b border-subtle pb-2">
          <button
            type="button"
            onClick={() => setScope("workspace")}
            className={`rounded px-2 py-1 text-body-xs-medium ${
              scopeKey(scope) === "workspace" ? "bg-surface-2 text-primary" : "text-secondary"
            }`}
          >
            Workspace default
          </button>
          {projects.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setScope({ kind: "project", projectId: p.id })}
              className={`rounded px-2 py-1 text-body-xs-medium ${
                scopeKey(scope) === `project:${p.id}` ? "bg-surface-2 text-primary" : "text-secondary"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {PR_STATE_KEYS.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`pr-${key}`} className="text-body-xs-regular text-secondary">
                {label} →
              </label>
              <select
                id={`pr-${key}`}
                value={draftMap[key] ?? ""}
                onChange={(e) => setKey(key, e.target.value)}
                className="mt-1 w-full rounded border border-subtle bg-surface-1 px-2 py-1 text-body-sm-regular"
                disabled={stateOptions.length === 0}
              >
                <option value="">— leave state alone —</option>
                {stateOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {stateOptions.length === 0 ? (
          <div className="text-body-xs-regular text-secondary">
            No states loaded for this scope yet. If you just connected a project, give it a moment.
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} loading={submitting}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
