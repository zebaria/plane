/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Per-project GitHub repo binding rows. Each row binds a GitHub
 * repo (under the workspace's installed App) to one Plane project,
 * with sync direction and an issue state map. Persisted as
 * `WorkspaceEntityConnection` rows of `type='github-repo'`.
 *
 * Renders inline under the workspace GitHub card; gated on the
 * workspace having a GitHub install.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR, { mutate } from "swr";
import { Trash2 } from "lucide-react";

import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";

import { useProject } from "@/hooks/store/use-project";
import { SiloIntegrationService } from "@/services/integrations";
import type { GithubRepo, WorkspaceConnection } from "@/services/integrations";

import { AddRepoBindingModal } from "./add-binding-modal";
import { PR_STATE_MAP_TYPE, PrStateMapModal } from "./pr-state-map-modal";

const silo = new SiloIntegrationService();

export const GITHUB_REPO_BINDING_TYPE = "github-repo";

export type GithubRepoBindingConfig = {
  direction?: "uni" | "bi";
  mirrorAllIssues?: boolean;
  issueStateMap?: {
    open?: string;
    closed?: string;
  };
};

const ENTITY_KEY = (slug: string, connId: string) => `silo-entity-github:${slug}:${connId}`;
const PR_STATE_MAP_KEY = (slug: string, connId: string) => `silo-entity-github-pr-state-map:${slug}:${connId}`;
const REPOS_KEY = (slug: string, installationId: string) => `silo-github-repos:${slug}:${installationId}`;

type Props = {
  workspaceSlug: string;
  installed: WorkspaceConnection;
};

export const GithubRepoBindingsRoot = observer(function GithubRepoBindingsRoot({ workspaceSlug, installed }: Props) {
  const projectStore = useProject();

  const installationId = installed.connection_id;

  const { data: bindings, isLoading: bindingsLoading } = useSWR(
    workspaceSlug ? ENTITY_KEY(workspaceSlug, installed.id) : null,
    () =>
      silo.listEntityConnections(workspaceSlug, {
        workspaceConnectionId: installed.id,
        type: GITHUB_REPO_BINDING_TYPE,
      })
  );

  const { data: prStateMapRows } = useSWR(workspaceSlug ? PR_STATE_MAP_KEY(workspaceSlug, installed.id) : null, () =>
    silo.listEntityConnections(workspaceSlug, {
      workspaceConnectionId: installed.id,
      type: PR_STATE_MAP_TYPE,
    })
  );

  const { data: repos } = useSWR(
    workspaceSlug && installationId ? REPOS_KEY(workspaceSlug, installationId) : null,
    () => silo.listGithubRepos(workspaceSlug, installationId)
  );

  const repoById = new Map<string, GithubRepo>();
  for (const r of repos ?? []) repoById.set(r.id, r);

  const [addOpen, setAddOpen] = useState(false);
  const [prMapOpen, setPrMapOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await silo.deleteEntityConnection(workspaceSlug, id);
      await mutate(ENTITY_KEY(workspaceSlug, installed.id));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Repo binding removed",
      });
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Delete failed",
        message: (e as Error).message,
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="border-t border-subtle px-4 py-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-body-sm-medium">GitHub Issues ↔ Plane project bindings</div>
          <div className="text-body-xs-regular text-secondary">
            {bindings && bindings.length > 0
              ? `${bindings.length} repo binding${bindings.length === 1 ? "" : "s"}.`
              : "No repos bound to projects yet."}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setPrMapOpen(true)}>
            Configure PR state map
          </Button>
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            Add binding
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {bindingsLoading ? <div className="text-body-sm-regular text-secondary">Loading bindings…</div> : null}
        {bindings?.map((b) => {
          const project = b.project_id ? projectStore.getProjectById(b.project_id) : null;
          const repo = repoById.get(b.entity_id);
          const cfg = (b.config as GithubRepoBindingConfig | null) ?? {};
          const dir = cfg.direction === "bi" ? "GitHub ↔ Plane" : "GitHub → Plane";
          const gate = cfg.mirrorAllIssues === false ? "labeled only" : "all issues";
          return (
            <div
              key={b.id}
              className="flex items-center justify-between rounded border border-subtle bg-surface-1 px-4 py-3"
            >
              <div>
                <div className="text-body-sm-medium">
                  {project?.name ?? b.project_id ?? "Unknown project"}
                  <span className="mx-2 text-secondary">·</span>
                  {b.entity_slug ?? repo?.full_name ?? b.entity_id}
                </div>
                <div className="text-body-xs-regular text-secondary">
                  {dir} · {gate}
                </div>
              </div>
              <Button variant="error-outline" onClick={() => handleDelete(b.id)} loading={deletingId === b.id}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      {prMapOpen ? (
        <PrStateMapModal
          workspaceSlug={workspaceSlug}
          workspaceConnectionId={installed.id}
          rows={prStateMapRows ?? []}
          onClose={() => setPrMapOpen(false)}
          onSuccess={async () => {
            setPrMapOpen(false);
            await mutate(PR_STATE_MAP_KEY(workspaceSlug, installed.id));
          }}
        />
      ) : null}

      {addOpen ? (
        <AddRepoBindingModal
          workspaceSlug={workspaceSlug}
          workspaceConnectionId={installed.id}
          repos={repos ?? []}
          existingRepoIdsByProject={
            new Map((bindings ?? []).filter((b) => b.project_id).map((b) => [`${b.project_id}:${b.entity_id}`, true]))
          }
          onClose={() => setAddOpen(false)}
          onSuccess={async () => {
            setAddOpen(false);
            await mutate(ENTITY_KEY(workspaceSlug, installed.id));
          }}
        />
      ) : null}
    </div>
  );
});
