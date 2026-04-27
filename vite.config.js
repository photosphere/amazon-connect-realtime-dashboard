import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "agent_metrics.html",
    },
  },
  server: {
    port: 8080,
    open: "/agent_metrics.html",
    // 开发环境把 /api 请求转发到后端
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
