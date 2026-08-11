import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Chrome rejects <link rel="modulepreload"> for extension chunks
    // ("cross-world extension resource mismatch").
    modulePreload: false,
  },
});
