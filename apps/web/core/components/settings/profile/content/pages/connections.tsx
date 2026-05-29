/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Profile → Connections. Per-user integration links (Slack identity,
 * GitHub user OAuth — coming) so creates and comments attribute to
 * the actual user instead of falling back to the workspace installer.
 *
 * The workspace must already have the integration installed by an
 * admin; otherwise we render an explainer instead of the connect UI.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR, { mutate } from "swr";
import { CheckCircle } from "lucide-react";

import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";

import GithubLogo from "@/app/assets/services/github.png?url";
import SlackLogo from "@/app/assets/services/slack.png?url";
import { useUser, useUserSettings } from "@/hooks/store/user";
import { SiloIntegrationService } from "@/services/integrations";

const silo = new SiloIntegrationService();

const WORKSPACE_KEY = (slug: string) => `silo-connections-slack:${slug}`;
const USER_KEY = (slug: string) => `silo-user-connections-slack:${slug}`;
const GH_WORKSPACE_KEY = (slug: string) => `silo-connections-github:${slug}`;
const GH_USER_KEY = (slug: string) => `silo-user-connections-github:${slug}`;

export const ConnectionsProfileSettings = observer(function ConnectionsProfileSettings() {
  const userStore = useUser();
  const currentUser = userStore.data;
  const settings = useUserSettings().data as unknown as { workspace?: { last_workspace_slug?: string } } | null;
  const lastWorkspaceSlug = settings?.workspace?.last_workspace_slug ?? "";

  const { data: wsConnections } = useSWR(lastWorkspaceSlug ? WORKSPACE_KEY(lastWorkspaceSlug) : null, () =>
    silo.listConnections(lastWorkspaceSlug, "slack")
  );
  const workspaceInstalled = wsConnections && wsConnections.length > 0 ? wsConnections[0] : null;

  const { data: userConnections } = useSWR(
    lastWorkspaceSlug && workspaceInstalled ? USER_KEY(lastWorkspaceSlug) : null,
    () => silo.listUserConnections(lastWorkspaceSlug, "slack")
  );
  const slackUserConnection =
    userConnections?.find((c) => (c as unknown as { user_id?: string }).user_id === currentUser?.id) ?? null;

  const { data: ghWsConnections } = useSWR(lastWorkspaceSlug ? GH_WORKSPACE_KEY(lastWorkspaceSlug) : null, () =>
    silo.listConnections(lastWorkspaceSlug, "github")
  );
  const ghWorkspaceInstalled = ghWsConnections && ghWsConnections.length > 0 ? ghWsConnections[0] : null;

  const { data: ghUserConnections } = useSWR(
    lastWorkspaceSlug && ghWorkspaceInstalled ? GH_USER_KEY(lastWorkspaceSlug) : null,
    () => silo.listUserConnections(lastWorkspaceSlug, "github")
  );
  const ghUserConnection =
    ghUserConnections?.find((c) => (c as unknown as { user_id?: string }).user_id === currentUser?.id) ?? null;

  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isGhConnecting, setIsGhConnecting] = useState(false);
  const [isGhDisconnecting, setIsGhDisconnecting] = useState(false);

  const handleConnect = async () => {
    if (!currentUser || !lastWorkspaceSlug) return;
    setIsConnecting(true);
    try {
      const url = await silo.getSlackUserAuthUrl(lastWorkspaceSlug, currentUser.id);
      window.location.assign(url);
    } catch (e) {
      setIsConnecting(false);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Slack connect failed",
        message: (e as Error).message,
      });
    }
  };

  const handleGhConnect = async () => {
    if (!currentUser || !lastWorkspaceSlug) return;
    setIsGhConnecting(true);
    try {
      const url = await silo.getGithubUserAuthUrl(lastWorkspaceSlug, currentUser.id);
      window.location.assign(url);
    } catch (e) {
      setIsGhConnecting(false);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "GitHub connect failed",
        message: (e as Error).message,
      });
    }
  };

  const handleGhDisconnect = async () => {
    if (!ghUserConnection || !lastWorkspaceSlug) return;
    setIsGhDisconnecting(true);
    try {
      await silo.deleteUserConnection(lastWorkspaceSlug, ghUserConnection.id);
      await mutate(GH_USER_KEY(lastWorkspaceSlug));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "GitHub unlinked",
        message: "Your GitHub identity is no longer linked.",
      });
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Disconnect failed",
        message: (e as Error).message,
      });
    } finally {
      setIsGhDisconnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!slackUserConnection || !lastWorkspaceSlug) return;
    setIsDisconnecting(true);
    try {
      await silo.deleteUserConnection(lastWorkspaceSlug, slackUserConnection.id);
      await mutate(USER_KEY(lastWorkspaceSlug));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "Slack unlinked",
        message: "Your Slack identity is no longer linked.",
      });
    } catch (e) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Disconnect failed",
        message: (e as Error).message,
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-heading-lg-semibold">Connections</h3>
        <p className="text-body-sm-regular text-secondary">
          Link your accounts on third-party services so work items, comments, and mentions attribute to you.
        </p>
      </div>

      <div className="rounded border border-subtle bg-surface-1">
        <div className="flex items-center justify-between gap-2 px-4 py-6">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 flex-shrink-0">
              <img src={SlackLogo} className="h-full w-full object-cover" alt="Slack" />
            </div>
            <div>
              <h4 className="flex items-center gap-2 text-body-xs-medium">
                Slack
                {slackUserConnection ? (
                  <CheckCircle className="h-3.5 w-3.5 fill-transparent text-success-primary" />
                ) : null}
              </h4>
              <p className="text-body-xs-regular text-secondary">
                {!workspaceInstalled
                  ? "A workspace admin needs to install the Slack integration first."
                  : slackUserConnection
                    ? "Linked. /plane will create work items as you."
                    : "Link your Slack identity so /plane creates and Slack comments attribute to you."}
              </p>
            </div>
          </div>
          {workspaceInstalled ? (
            slackUserConnection ? (
              <Button variant="error-outline" onClick={handleDisconnect} loading={isDisconnecting}>
                {isDisconnecting ? "Unlinking..." : "Unlink"}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleConnect} loading={isConnecting}>
                {isConnecting ? "Redirecting..." : "Link my Slack"}
              </Button>
            )
          ) : null}
        </div>
      </div>

      <div className="rounded border border-subtle bg-surface-1">
        <div className="flex items-center justify-between gap-2 px-4 py-6">
          <div className="flex items-start gap-4">
            <div className="h-10 w-10 flex-shrink-0">
              <img src={GithubLogo} className="h-full w-full object-cover" alt="GitHub" />
            </div>
            <div>
              <h4 className="flex items-center gap-2 text-body-xs-medium">
                GitHub
                {ghUserConnection ? (
                  <CheckCircle className="h-3.5 w-3.5 fill-transparent text-success-primary" />
                ) : null}
              </h4>
              <p className="text-body-xs-regular text-secondary">
                {!ghWorkspaceInstalled
                  ? "A workspace admin needs to install the GitHub integration first."
                  : ghUserConnection
                    ? "Linked. GitHub-originated activity will attribute to you."
                    : "Link your GitHub identity so issues, comments, and mentions attribute to you."}
              </p>
            </div>
          </div>
          {ghWorkspaceInstalled ? (
            ghUserConnection ? (
              <Button variant="error-outline" onClick={handleGhDisconnect} loading={isGhDisconnecting}>
                {isGhDisconnecting ? "Unlinking..." : "Unlink"}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleGhConnect} loading={isGhConnecting}>
                {isGhConnecting ? "Redirecting..." : "Link my GitHub"}
              </Button>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});
