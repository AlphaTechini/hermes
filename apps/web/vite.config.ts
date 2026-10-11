import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";

const API_TARGET = process.env.HERMES_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss(), nodePolyfills({ include: ["buffer", "process", "util", "stream", "crypto"], globals: { Buffer: true, process: true, global: true } })],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/hooks": { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: { port: 4173 },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
