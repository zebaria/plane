/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Integration registry for the silo's *lifecycle* concerns: loading an
 * integration's secrets at startup and mounting its HTTP routes. This is
 * the inbound/lifecycle counterpart to the outbound `dispatchers`
 * registry in notifications.ts.
 *
 * Adding an integration is a single line in providers.ts (the manifest);
 * INTEGRATIONS is derived from it automatically. The bootstrap loop
 * (start.ts) and the mount loop (server.ts) stay untouched.
 *
 * Each integration is optional and self-contained: if its secrets are
 * missing or unreadable, `load()` returns false, the service still boots,
 * and `mount()` is skipped so the integration's routes simply don't exist
 * (404) rather than erroring. Only a genuinely *malformed* secret (present
 * but missing required keys) is fatal — see secrets.ts SecretShapeError.
 */

import type { Router } from "express";

import type { IntegrationDispatcher } from "./events";

export type Integration = {
  /** Stable identifier, e.g. "slack", "github". */
  name: string;
  /**
   * Load this integration's secrets/config for the given env. Returns
   * true if the integration is configured and should be mounted, false
   * if it's absent/unavailable (integration stays disabled). May throw
   * only for a genuine misconfiguration that should halt startup.
   */
  load: (env: string) => Promise<boolean>;
  /**
   * Mount routes that must exist BEFORE the integration is configured —
   * i.e. the cold-start/bootstrap path that creates the secret `load()`
   * looks for. Called unconditionally, regardless of whether `load()`
   * returned true, so an unconfigured integration can still be set up
   * (e.g. GitHub's App-manifest flow). Optional — an integration with no
   * bootstrap step omits it.
   */
  bootstrap?: (router: Router) => void;
  /** Mount the integration's inbound routes onto the shared router. */
  mount: (router: Router) => void;
  /**
   * Outbound dispatcher: fans a work-item event out to this integration.
   * Optional — an integration may be inbound-only. The notifications
   * router collects these from the registry (see notifications.ts).
   */
  dispatcher?: IntegrationDispatcher;
};

import * as providers from "./providers";

// The registry, derived from the providers.ts manifest. Every Integration
// exported there is registered automatically — no edit needed here when
// adding one. Order follows declaration order in providers.ts.
export const INTEGRATIONS: Integration[] = Object.values(providers);

/**
 * Load every integration. Each is independent: one failing to load
 * (returning false) does not affect the others. Returns the subset that
 * reported themselves configured, so the caller can mount exactly those.
 */
export const loadIntegrations = async (env: string): Promise<Set<string>> => {
  const configured = new Set<string>();
  await Promise.all(
    INTEGRATIONS.map(async (i) => {
      if (await i.load(env)) configured.add(i.name);
    })
  );
  return configured;
};

/**
 * Mount every integration's bootstrap routes, UNCONDITIONALLY. These are
 * the cold-start paths (e.g. GitHub's App-manifest flow) that create the
 * secret `load()` looks for, so they cannot be gated on being configured
 * — that would be a chicken-and-egg deadlock. Safe to call before
 * loadIntegrations(); independent of the configured set.
 */
export const bootstrapIntegrations = (router: Router): void => {
  for (const i of INTEGRATIONS) {
    if (i.bootstrap) i.bootstrap(router);
  }
};

/** Mount the routes of every configured integration. */
export const mountIntegrations = (router: Router, configured: Set<string>): void => {
  for (const i of INTEGRATIONS) {
    if (configured.has(i.name)) i.mount(router);
  }
};

/** Every registered integration's outbound dispatcher, in registry order. */
export const integrationDispatchers = (): IntegrationDispatcher[] =>
  INTEGRATIONS.map((i) => i.dispatcher).filter((d): d is IntegrationDispatcher => d !== undefined);
