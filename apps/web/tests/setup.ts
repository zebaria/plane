/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Side-effect import: registers jest-dom's custom matchers on vitest's
// expect. There's nothing to bind to a variable — this is the intended
// usage from the library's docs.
// oxlint-disable-next-line no-unassigned-import
import "@testing-library/jest-dom/vitest";
