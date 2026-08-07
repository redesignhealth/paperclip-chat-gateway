import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// This package is "type": "module", so bare `__dirname` (a CJS global) is
// not defined under Node's native ESM loader; Vite's own config loader
// happens to shim it in most cases, but that's an implementation detail,
// not a guarantee across Vite config-loading paths. Derive it explicitly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
