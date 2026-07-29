import { defineConfig } from "vite";

/**
 * Serves the regression fixture only. Kept separate from the extension's own
 * config so the CRX plugin does not try to build a manifest for it.
 *
 * React comes from a CDN, so the classic JSX transform is used: the automatic
 * runtime would emit a bare `react/jsx-runtime` import with nothing to resolve it.
 */
export default defineConfig({
  root: __dirname,
  esbuild: {
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
  },
  server: {
    port: 5174,
    open: true,
  },
});
