/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Echo-loop guard. Actions performed by our own GitHub App (the
 * outbound Plane→GH mirror) arrive back as webhooks whose actor is a
 * GitHub App bot — `type === "Bot"` or a `login` ending in `[bot]`.
 * Mirroring those back into Plane would create a write loop, so every
 * inbound handler drops bot-authored events. Centralized here so the
 * issues / issue_comment / pull_request handlers can't drift apart.
 */

export type GhActor = { login?: string; type?: string } | null | undefined;

export const isBotActor = (actor: GhActor): boolean => actor?.type === "Bot" || (actor?.login ?? "").endsWith("[bot]");
