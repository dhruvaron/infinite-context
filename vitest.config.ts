import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/worker/**/*.test.ts", "scripts/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/**/*.test.ts", "apps/web/**/*.test.tsx"],
          setupFiles: ["apps/web/src/test/setup.ts"],
          css: true
        }
      }
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"]
    }
  }
});
