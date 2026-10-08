import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PRISM_API_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
      "/callback": {
        target: process.env.PRISM_API_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
      "^/t/[^/]+/[^/]+": {
        target: process.env.PRISM_API_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
