import { defineConfig } from "vite";

// Served from https://dreveron10.github.io/data-compare/
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
