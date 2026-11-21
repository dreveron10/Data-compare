import { defineConfig } from "@playwright/test";
// Smoke tests against the built site (npm run build first). Uses the installed Google Chrome.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  use: { baseURL: "http://localhost:4173", channel: "chrome", launchOptions: { args: ["--use-gl=swiftshader"] } },
  webServer: { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: true, timeout: 60_000 },
});
