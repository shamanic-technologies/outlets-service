import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    env: {
      OUTLETS_SERVICE_API_KEY: "test-key",
    },
  },
});
