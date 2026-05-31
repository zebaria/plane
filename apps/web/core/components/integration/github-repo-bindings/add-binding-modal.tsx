/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Modal: pick a Plane project + a GitHub repo, pick sync direction,
 * and map GitHub open/closed → Plane state. Persists as a
 * `WorkspaceEntityConnection` row of `type=github-repo`.
 */

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";

import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";

import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { SiloIntegrationService } from "@/services/integrations";
import type { GithubRepo } from "@/services/integrations";

import { GITHUB_REPO_BINDING_TYPE } from "./root";

const silo = new SiloIntegrationService();

type Props = {
  workspaceSlug: string;
  workspaceConnectionId: string;
  repos: GithubRepo[];
  existingRepoIdsByProject: Map<string, boolean>;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
};

export const AddRepoBindingModal = observer(function AddRepoBindingModal({
  workspaceSlug,
  workspaceConnectionId,
  repos,
  existingRepoIdsByProject,
  onClose,
  onSuccess,
}: Props) {
  const projectStore = useProject();
  const stateStore = useProjectState();

  const [projectId, setProjectId] = useState<string>("");
  const [repoFilter, setRepoFilter] = useState("");
  const [repoIds, setRepoIds] = useState<Set<string>>(new Set());
  const [direction, setDirection] = useState<"uni" | "bi">("bi");
  const [mirrorAllIssues, setMirrorAllIssues] = useState(true);
  const [openStateId, setOpenStateId] = useState<string>("");
  const [closedStateId, setClosedStateId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const projects = projectStore.joinedProjectIds
    .map((id) => projectStore.getProjectById(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  // Fetch states for the selected project on demand. Pre-select sensible
  // defaults (first "unstarted" → open, first "completed" → closed) the
  // first time states arrive for a project.
  useEffect(() => {
    if (!projectId) return;
    const existing = stateStore.getProjectStates(projectId);
    if (!existing) {
      stateStore.fetchProjectStates(workspaceSlug, projectId).catch(() => {});
    }
  }, [projectId, workspaceSlug, stateStore]);

  const projectStates = projectId ? stateStore.getProjectStates(projectId) : undefined;

  useEffect(() => {
    if (!projectStates || projectStates.length === 0) {
      setOpenStateId("");
      setClosedStateId("");
      return;
    }
    const open = projectStates.find((s) => s.group === "unstarted") ?? projectStates[0];
    const closed = projectStates.find((s) => s.group === "completed") ?? projectStates[projectStates.length - 1];
    setOpenStateId(open.id);
    setClosedStateId(closed.id);
  }, [projectStates]);

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    return repos.filter((r) => {
      if (projectId && existingRepoIdsByProject.has(`${projectId}:${r.id}`)) return false;
      if (!q) return true;
      return r.full_name.toLowerCase().includes(q);
    });
  }, [repos, repoFilter, projectId, existingRepoIdsByProject]);

  const canSubmit = !!projectId && repoIds.size > 0 && !!openStateId && !!closedStateId && !submitting;

  const toggleRepo = (id: string) => {
    setRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const selected = repos.filter((r) => repoIds.has(r.id));
    if (selected.length === 0) return;
    setSubmitting(true);
    try {
      const results = await Promise.allSettled(
        selected.map((repo) =>
          silo.createEntityConnection(workspaceSlug, {
            workspace_connection_id: workspaceConnectionId,
            project_id: projectId,
            type: GITHUB_REPO_BINDING_TYPE,
            entity_type: "repository",
            entity_id: repo.id,
            entity_slug: repo.full_name,
            entity_data: {
              name: repo.name,
              private: repo.private,
              default_branch: repo.default_branch,
            },
            config: {
              direction,
              mirrorAllIssues,
              issueStateMap: {
                open: openStateId,
                closed: closedStateId,
              },
            },
          })
        )
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const ok = results.length - failed;
      if (ok > 0) {
        setToast({
          type: failed > 0 ? TOAST_TYPE.WARNING : TOAST_TYPE.SUCCESS,
          title: failed > 0 ? `Bound ${ok} of ${results.length} repos` : "Repos bound",
          message: failed > 0 ? `${failed} failed; check console.` : `${ok} repo${ok === 1 ? "" : "s"} linked.`,
        });
      } else {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "Failed to add bindings",
          message: (results[0] as PromiseRejectedResult).reason?.message ?? "Unknown error",
        });
      }
      await onSuccess();
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Failed to add bindings",
        message: (e as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
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
          <h3 className="text-heading-md-semibold">Bind GitHub Issues from a repo</h3>
          <p className="text-body-xs-regular text-secondary">
            Choose a project, the repos to mirror, and how GitHub Issues should map to Plane states.
          </p>
        </div>

        <div>
          <label htmlFor="binding-project" className="text-body-xs-medium">
            Project
          </label>
          <select
            id="binding-project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setRepoIds(new Set());
            }}
            className="mt-1 w-full rounded border border-subtle bg-surface-1 px-2 py-1 text-body-sm-regular"
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="binding-repo-filter" className="text-body-xs-medium">
            Repository
          </label>
          <input
            id="binding-repo-filter"
            type="text"
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            placeholder="Filter repos…"
            className="mt-1 w-full rounded border border-subtle bg-surface-1 px-2 py-1 text-body-sm-regular"
            disabled={!projectId}
          />
          <div className="mt-2 max-h-56 overflow-y-auto rounded border border-subtle bg-surface-1">
            {!projectId ? (
              <div className="p-3 text-body-xs-regular text-secondary">Pick a project first.</div>
            ) : filteredRepos.length === 0 ? (
              <div className="p-3 text-body-xs-regular text-secondary">No repos match.</div>
            ) : (
              filteredRepos.map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-subtle px-3 py-2 last:border-b-0 hover:bg-surface-2"
                >
                  <input type="checkbox" checked={repoIds.has(r.id)} onChange={() => toggleRepo(r.id)} />
                  <span className="text-body-sm-regular">
                    {r.full_name}
                    {r.private ? <span className="ml-1 text-body-xs-regular text-secondary">private</span> : null}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="text-body-xs-medium">Sync direction</div>
          <div className="mt-2 flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <input type="radio" name="direction" checked={direction === "uni"} onChange={() => setDirection("uni")} />
              <span className="text-body-sm-regular">GitHub → Plane (mirror GitHub Issues into Plane)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="direction" checked={direction === "bi"} onChange={() => setDirection("bi")} />
              <span className="text-body-sm-regular">GitHub ↔ Plane (two-way sync of GitHub Issues)</span>
            </label>
            <div className="ml-6 text-body-xs-regular text-secondary">
              Two-way sync only applies to work items that originated from or were manually linked to a GitHub Issue.
              Plane-only work items stay in Plane.
            </div>
          </div>
        </div>

        <div>
          <div className="text-body-xs-medium">Which issues to mirror</div>
          <div className="mt-2 flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={mirrorAllIssues} onChange={(e) => setMirrorAllIssues(e.target.checked)} />
              <span className="text-body-sm-regular">Mirror all GitHub Issues in this repo</span>
            </label>
            <div className="ml-6 text-body-xs-regular text-secondary">
              Off → mirror only Issues with the <code>Plane</code> label. Useful when the repo has external bug
              reporters but you only want triaged ones in Plane.
            </div>
          </div>
        </div>

        <div>
          <div className="text-body-xs-medium">GitHub Issue state map</div>
          <div className="text-body-xs-regular text-secondary">
            GitHub Issues only have two states (open / closed). Map each to a Plane state.
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="map-open" className="text-body-xs-regular text-secondary">
                When GitHub Issue is open / reopened →
              </label>
              <select
                id="map-open"
                value={openStateId}
                onChange={(e) => setOpenStateId(e.target.value)}
                disabled={!projectStates}
                className="mt-1 w-full rounded border border-subtle bg-surface-1 px-2 py-1 text-body-sm-regular"
              >
                {!projectStates ? <option value="">Loading…</option> : null}
                {projectStates?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.group})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="map-closed" className="text-body-xs-regular text-secondary">
                When GitHub Issue is closed →
              </label>
              <select
                id="map-closed"
                value={closedStateId}
                onChange={(e) => setClosedStateId(e.target.value)}
                disabled={!projectStates}
                className="mt-1 w-full rounded border border-subtle bg-surface-1 px-2 py-1 text-body-sm-regular"
              >
                {!projectStates ? <option value="">Loading…</option> : null}
                {projectStates?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.group})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            {submitting ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
