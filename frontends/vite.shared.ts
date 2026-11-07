import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite bundles this config before evaluating it, so `import.meta.url` points at
// a temp file. Use the workspace root (cwd) instead.
const here = process.cwd();

/**
 * The front-end is built into ./frontend/ and served by the Rust backend at
 * the site root (`/`). The shared package is aliased to source so the app and
 * the A/B harness stay in one place.
 */
export function frontendConfig() {
  return defineConfig({
    base: "/",
    plugins: [react()],
    resolve: {
      // The shared package is consumed as TypeScript source.
      alias: {
        "@stride/shared": path.resolve(here, "../../shared/src/index.tsx"),
      },
    },
    server: {
      port: 5175,
      proxy: {
        "/api": "http://127.0.0.1:8080",
      },
    },
    build: {
      outDir: path.resolve(here, "../../frontend"),
      emptyOutDir: true,
    },
  });
}
