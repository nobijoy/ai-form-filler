import { defineManifest } from "@crxjs/vite-plugin";
import { PROVIDER_ORIGIN_PATTERNS } from "./src/shared/providers";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extName__",
  description: "__MSG_extDescription__",
  version: "1.1.0",
  default_locale: "en",
  icons: {
    16: "icons/icon16.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  permissions: ["storage", "activeTab", "scripting", "contextMenus", "sidePanel"],
  // Provider origins for LLM calls, plus every http(s) page so the content
  // script can be injected into localhost and ordinary sites from the side panel
  // (activeTab alone is not granted on a panel button click).
  host_permissions: [...PROVIDER_ORIGIN_PATTERNS, "http://*/*", "https://*/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_title: "__MSG_actionTitle__",
    default_icon: {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  commands: {
    "fill-form": {
      suggested_key: {
        default: "Alt+Shift+F",
        mac: "Alt+Shift+F",
      },
      description: "__MSG_commandFill__",
    },
  },
});
