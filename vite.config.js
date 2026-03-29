import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
  },
  server: {
    port: 8080,
    open: "/agent_metrics.html",
  },
});
