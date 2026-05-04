# AI Form Filler (Chrome extension)

A Chrome extension (Manifest V3) that helps **frontend developers and QA** fill long or multi-step forms quickly. It combines **fast local heuristics** (emails, URLs, common `autocomplete` fields) with **optional AI** (your own OpenRouter API key) so remaining fields get realistic test data based on labels, placeholders, and locale.

---

## What you need first

1. **Google Chrome** (or another Chromium browser that supports Chrome extensions).
2. **Node.js** (LTS version is fine)—so you can run `npm` to build the extension.
3. An **OpenRouter API key** if you want AI-filled fields. Heuristics-only mode works without any key for simple fields.

---

## Build the extension (one-time setup)

1. Open a terminal in the project folder:

   ```bash
   cd path/to/ai-form-filler
   ```

2. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

3. After a successful build, an output folder named **`dist`** appears. Chrome loads **that** folder, not the project root.

**Tip:** While you change code, you can run `npm run dev` to rebuild `dist` whenever files change; reload the extension in Chrome after each rebuild (see below).

---

## Install the extension in Chrome (load unpacked)

1. Open Chrome and go to **`chrome://extensions`**.
2. Turn **Developer mode** **ON** (top-right).
3. Click **Load unpacked**.
4. Select the **`dist`** folder inside this project (e.g. `.../ai-form-filler/dist`).
5. You should see **AI Form Filler** in your extensions list. Pin it to the toolbar if you like (puzzle icon → pin).

---

## Configure it (beginner steps)

1. Click the **extension icon** in the toolbar to open the **popup**.
2. Paste your **API key** (from [OpenRouter keys](https://openrouter.ai/keys)).
3. Choose whether to **remember the key across browser restarts** (stored in extension storage) or use a **session-only** key (cleared when you quit the browser)—see the checkbox in the popup.
4. Leave **API base URL** as `https://openrouter.ai/api/v1` (advanced users can override this).
5. Pick a **model** from the searchable free-model list (default is `openrouter/free`).
6. Set **Fill mode**:
   - **Hybrid** — fast local fill where possible, then AI for the rest (recommended).
   - **AI only** — everything goes through the model (slower, more cost).
   - **Heuristics only** — no API calls; only rule-based fills (good for quick smoke tests without a key).
7. Click **Save settings**.

**Security note:** The key stays in the extension (service worker / storage). It is **not** injected into web pages. Anyone who can use your Windows user profile and Chrome profile could open the extension—use a **locked screen** and avoid shared machines for production API keys.

---

## How to use it for frontend testing

### Basic workflow

1. Run your app locally (for example `npm run dev` on your React/Vue/Next app) or open a staging URL.
2. Open a page that contains the **form you want to test** (sign-up, checkout step, settings, etc.).
3. Make sure that tab is **active**, then either:
   - Click **Fill this tab** in the extension popup, or  
   - Press **`Alt+Shift+F`** (default shortcut; configurable under `chrome://extensions/shortcuts`).

The extension only runs on normal web pages—**not** on `chrome://` pages or the Chrome Web Store.

### What happens on the page

- The extension finds inputs, textareas, selects, and radio groups and fills **empty** fields (unless you turn off “fill empty only” in settings—useful for forcing a full refill).
- **Hybrid mode** fills obvious fields (like `type="email"`) immediately, then asks the AI for trickier fields (free text, selects, radios, conditional sections).
- **Multi-step / conditional forms:** it runs several **rounds** (default up to 5): fill → wait for the page to update → scan again. That helps when choosing “Country” reveals “State”, etc. Increase **max rounds** or **settle delay** in the popup if your UI updates slowly (heavy React re-renders, animations).

### Good practices for QA

- Test **one screen at a time** on long wizards: go to step 2, click fill again, and so on.
- Use **Heuristics only** first to see layout and validation without spending API tokens.
- For **non-English** UIs, use **Fill language → Auto** so the model follows the page language, or set an **override locale** if you need English test data on a localized site.
- If something fails, open **`chrome://extensions`**, find **AI Form Filler**, click **service worker** (for “Inspect views”) and check the console for API errors (invalid key, quota, wrong model).

---

## Changing the API host

The manifest allows requests only to **`https://openrouter.ai/*`**.

---

## Project scripts

| Command        | Purpose                                      |
|----------------|----------------------------------------------|
| `npm install`  | Install dependencies                         |
| `npm run build`| Typecheck + production build into `dist`     |
| `npm run dev`  | Watch mode: rebuild `dist` on file changes   |
| `npm run check`| TypeScript check only                        |

---

## Troubleshooting

| Problem | What to try |
|--------|--------------|
| **Fill does nothing** | Use an `https://` or `http://localhost` page (not `chrome://`). Reload the tab or the extension after rebuilding. |
| **API errors** | Verify the key, model name, and billing/quota on your provider. Check the service worker console. |
| **Wrong or partial fill** | Try **AI only**, raise **max rounds** / **settle ms**, or fill multi-step forms one step at a time. |
| **Extension outdated after edits** | Run `npm run build` (or `npm run dev`), then **Reload** the extension on `chrome://extensions`. |

---

## License

Private / use per your team policy. Add a license file if you publish the repo.
