import { defineConfig } from "vitest/config";

// Node environment only — the server has no DOM-dependent code.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
