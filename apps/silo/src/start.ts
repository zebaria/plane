/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { config } from "./config";
import { loadIntegrations } from "./integrations";
import { createApp } from "./server";

// Load integrations first, then build the app: createApp() only mounts an
// integration's routes when it loaded successfully, so secret-loading must
// run before the router is assembled. Each integration is optional — a
// missing/unreadable secret disables just that one (see integrations.ts).
loadIntegrations(config.env)
  .then((configured) => {
    const app = createApp(configured);
    const server = app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`[silo] listening on :${config.port} basePath=${config.basePath}`);
    });

    const shutdown = (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`[silo] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return server;
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[silo] startup failed: ${(err as Error).message}`);
    process.exit(1);
  });
