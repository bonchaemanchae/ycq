import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves on http://localhost:5173 and forwards /api/* to the
// FastAPI backend on port 8000, the same way nginx does in Docker.
// In Docker dev mode (docker-compose.dev.yml) API_URL points at the api
// container and VITE_POLLING makes it notice file changes made on Windows.
export default defineConfig({
  plugins: [react()],
  server: {
    watch: process.env.VITE_POLLING ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      "/api": {
        target: process.env.API_URL ?? "http://localhost:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
