import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// VITE_BASE lets the static build live under a GitHub Pages sub-path later (e.g. /clientscope-dashboard/).
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
});
