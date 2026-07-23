/**
 * Copyright (c) 2026-present Zebaria.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./core"),
      "@/app": path.resolve(__dirname, "./app"),
      "@/helpers": path.resolve(__dirname, "./helpers"),
      "@/styles": path.resolve(__dirname, "./styles"),
      "@/plane-web": path.resolve(__dirname, "./ce"),
    },
  },
});
