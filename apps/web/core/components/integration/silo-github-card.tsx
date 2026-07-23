/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR, { mutate } from "swr";
import { CheckCircle } from "lucide-react";

import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";

import GithubLogo from "@/app/assets/services/github.png?url";
import { useUser } from "@/hooks/store/user/user-user";
import { useUserPermissions } from "@/hooks/store/user";
import { SiloIntegrationService } from "@/services/integrations";

import { GithubRepoBindingsRoot } from "./github-repo-bindings";
import { normalizeGhesHost } from "./ghes-host";

const silo = new SiloIntegrationService();

const SWR_KEY = (slug: string) => `silo-connections-github:${slug}`;

export const SiloGithubCard = observer(function SiloGithubCard() {
  const { workspaceSlug } = useParams() as { workspaceSlug: string };
  const userStore = useUser();
  const currentUser = userStore.data;
  const { allowPermissions } = useUserPermissions();
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);

  const [isInstalling, setIsInstalling] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  // Phase 4g: GitHub Enterprise Server. When the admin reveals the
  // enterprise option and enters a host, the install routes through
  // that GHES origin instead of cloud github.com.
  const [showEnterprise, setShowEnterprise] = useState(false);
  const [ghesHost, setGhesHost] = useState("");

  const { data: connections } = useSWR(workspaceSlug ? SWR_KEY(String(workspaceSlug)) : null, () =>
    silo.listConnections(String(workspaceSlug), "github")
  );

  const installed = connections && connections.length > 0 ? connections[0] : null;

  const handleInstall = async (ghesBaseUrl?: string) => {
    if (!isAdmin || !currentUser) return;
    setIsInstalling(true);
    try {
      const url = await silo.getGithubInstallUrl(String(workspaceSlug), currentUser.id, ghesBaseUrl);
      window.location.assign(url);
    } catch (e) {
      setIsInstalling(false);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "GitHub connect failed",
        message: (e as Error).message,
      });
    }
  };

  const handleEnterpriseInstall = () => {
    const host = normalizeGhesHost(ghesHost);
    if (!host) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Hostname required",
        message: "Enter your GitHub Enterprise Server hostname, e.g. ghe.acme.com.",
      });
      return;
    }
    void handleInstall(host);
  };

  const handleUninstall = async () => {
    if (!isAdmin || !installed) return;
    setIsUninstalling(true);
    try {
      await silo.deleteConnection(String(workspaceSlug), installed.id);
      await mutate(SWR_KEY(String(workspaceSlug)));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "GitHub disconnected",
        message:
          "Workspace install removed. The GitHub App is still installed on your org — uninstall from github.com if you want it gone entirely.",
      });
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Disconnect failed",
        message: (e as Error).message,
      });
    } finally {
      setIsUninstalling(false);
    }
  };

  return (
    <div className="border-b border-subtle bg-surface-1">
      <div className="flex items-center justify-between gap-2 px-4 py-6">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 flex-shrink-0">
            <img src={GithubLogo} className="h-full w-full object-cover" alt="GitHub" />
          </div>
          <div>
            <h3 className="flex items-center gap-2 text-body-xs-medium">
              GitHub
              {installed ? <CheckCircle className="h-3.5 w-3.5 fill-transparent text-success-primary" /> : null}
            </h3>
            <p className="text-body-xs-regular text-secondary">
              {installed
                ? `Connected to ${installed.connection_slug || installed.connection_id}.`
                : "Connect GitHub to sync issues, PRs, and comments with your repos."}
            </p>
          </div>
        </div>
        {installed ? (
          <Button variant="error-fill" onClick={handleUninstall} disabled={!isAdmin} loading={isUninstalling}>
            {isUninstalling ? "Disconnecting..." : "Disconnect"}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => handleInstall()} disabled={!isAdmin} loading={isInstalling}>
            {isInstalling ? "Redirecting..." : "Connect"}
          </Button>
        )}
      </div>
      {!installed && isAdmin ? (
        <div className="-mt-2 px-4 pb-6">
          {!showEnterprise ? (
            <button
              type="button"
              onClick={() => setShowEnterprise(true)}
              className="text-body-xs-regular text-secondary underline hover:text-primary"
            >
              Using GitHub Enterprise Server?
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-2 p-3">
              <label htmlFor="ghes-host" className="text-body-xs-medium">
                GitHub Enterprise Server hostname
              </label>
              <p className="text-body-xs-regular text-secondary">
                Enter your GHES origin (e.g. <code>ghe.acme.com</code>). The install and all API calls route to that
                host instead of github.com.
              </p>
              <div className="flex items-center gap-2">
                <input
                  id="ghes-host"
                  type="text"
                  value={ghesHost}
                  onChange={(e) => setGhesHost(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleEnterpriseInstall();
                  }}
                  placeholder="ghe.acme.com"
                  className="focus:border-primary flex-1 rounded-md border border-subtle bg-surface-1 px-3 py-1.5 text-body-xs-regular outline-none"
                />
                <Button variant="primary" onClick={handleEnterpriseInstall} loading={isInstalling}>
                  {isInstalling ? "Redirecting..." : "Connect Enterprise"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {installed ? <GithubRepoBindingsRoot workspaceSlug={String(workspaceSlug)} installed={installed} /> : null}
    </div>
  );
});
