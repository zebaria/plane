/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Slack integration config state. Owned by the Slack integration so the
 * provider's runtime config lives next to its code, not in a shared file.
 */

export type SlackProviderConfig = {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUrl: string;
};

let slackConfig: SlackProviderConfig | null = null;

export const setSlackConfig = (s: SlackProviderConfig): void => {
  slackConfig = s;
};

export const getSlackConfig = (): SlackProviderConfig => {
  if (!slackConfig) throw new Error("Slack config not loaded yet");
  return slackConfig;
};

export const isSlackConfigured = (): boolean => slackConfig !== null;
