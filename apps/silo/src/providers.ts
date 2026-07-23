/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Integration manifest — the single place to register an integration.
 *
 * To add an integration: export its `Integration` here as ONE line. The
 * registry (integrations.ts) derives the active set from these exports
 * via Object.values, so nothing else changes. Static re-exports keep this
 * bundler-friendly (tsdown/rolldown resolves them at build time).
 */

export { slackIntegration } from "./slack";
export { githubIntegration } from "./github";
