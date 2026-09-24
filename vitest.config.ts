import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Booting PGlite (Postgres in WASM) takes a few seconds on slower machines.
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
