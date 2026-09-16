import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which pulls in the PWA plugin, irrelevant to
// tests) — node environment only, since the test layer covers pure logic
// (client/src/lib, client/src/utils), not components or localStorage.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
