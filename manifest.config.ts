import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extName__",
  description: "__MSG_extDescription__",
  version: "0.1.0",
  default_locale: "en",
  permissions: ["storage", "activeTab", "scripting"],
  host_permissions: ["https://openrouter.ai/*"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "__MSG_actionTitle__",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
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
