import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

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
  },
  plugins: [
    {
      name: "data-json-writer",
      configureServer(server) {
        server.middlewares.use("/api/save-data", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return;
          }
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const filePath = path.resolve("data.json");
              fs.writeFileSync(filePath, body, "utf-8");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
        });
      },
    },
  ],
});
