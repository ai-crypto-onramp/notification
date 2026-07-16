import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "dist/**",
        "node_modules/**",
        "src/migrate.ts",
        "src/**/*.test.ts",
        "src/index.ts",
      ],
    },
  },
});