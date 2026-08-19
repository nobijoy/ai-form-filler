# Autofill AI Ninja

**Autofill AI Ninja** (context-aware AI form filler) is a Chrome extension that autofills web forms with realistic AI-generated test data. Use it to fill forms automatically on signup, checkout, and onboarding pages — including **React**, **Vue**, **Angular**, and **multi-step form** wizards that normal autofill tools get wrong.

You do not need a paid OpenAI account. [Google AI Studio](https://aistudio.google.com/apikey) and [Groq Cloud](https://console.groq.com/keys) issue a free key. For testing, use **Gemini 3.1 Flash**.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF.svg)](https://vitejs.dev/)

**Chrome Web Store:** [Add to Chrome](https://chromewebstore.google.com/detail/ai-form-filler/kacfbgoplpkcmhamjcdfddjnhgacemfh)  
**Docs & tutorials:** [https://nobijoy.github.io/ai-form-filler/](https://nobijoy.github.io/ai-form-filler/)  
**Privacy Policy:** [https://nobijoy.github.io/ai-form-filler/privacy.html](https://nobijoy.github.io/ai-form-filler/privacy.html)

## Contents

- [Overview](#overview)
- [Capabilities](#capabilities)
- [Side panel reference](#side-panel-reference)
- [Architecture](#architecture)
- [Fill workflow](#fill-workflow)
- [Why reactive forms need special handling](#why-reactive-forms-need-special-handling)
- [Multi-step navigation](#multi-step-navigation)
- [Custom requests and language](#custom-requests-and-language)
- [Configuration](#configuration)
- [LLM providers](#llm-providers)
- [Security and storage](#security-and-storage)
- [Project layout](#project-layout)
- [Development](#development)
- [License](#-license)

## Overview

Manual form testing is slow and brittle: labels change, wizards add steps, and framework-controlled inputs ignore naive value assignment. Autofill AI Ninja runs inside the page, discovers fillable controls through widget adapters, resolves what it can locally, and delegates the rest to a configured LLM through the background service worker. Every write goes through the DOM's native property setters and a realistic event sequence, which is what React, Vue, Svelte, and Angular actually listen for.

The run is stateful. A step epoch scopes what has been filled, and a semantic run context carries facts and identity values forward, so a step-4 "confirm your email" matches the address entered in step 1.

You bring your own API key. **You do not need a paid OpenAI or Anthropic account.** [Google AI Studio](https://aistudio.google.com/apikey) and [Groq Cloud](https://console.groq.com/keys) both issue a free API key with enough quota for typical extension use (no credit card). Keys stay in the extension service worker and are never exposed to the page being filled. Step-by-step: [get a free key](https://nobijoy.github.io/ai-form-filler/tutorial.html#free-keys).

## Capabilities

| Area | Behavior |
| --- | --- |
| Fill modes | **Hybrid** (heuristics then AI), **AI only**, or **Heuristics only** (no API key required) |
| Triggers | Side panel button, context menu ("Fill this form with AI"), keyboard shortcut (`Alt+Shift+F`) |
| Native controls | Text inputs, textareas, selects, radio groups, checkboxes |
| ARIA widgets | `role="checkbox"`, `role="switch"`, `role="radiogroup"`, `role="combobox"` / `listbox`, `contenteditable` |
| Multi-step forms | Automatic advancing with content-fingerprint step detection, up to 50 steps |
| Conditional fields | `MutationObserver` settling picks up fields revealed by a checkbox or select |
| Cross-step identity | Email, name, phone, and other slots stay coherent across the whole run |
| Error recovery | Reads the page's own validation messages and re-asks the model with them quoted |
| Custom requests | One free-text box for user rules, injected at highest prompt priority |
| Multilingual | Follows the page's language, or an explicit BCP-47 override, with per-field `lang` support |
| Providers | OpenAI, Anthropic, Google AI Studio, xAI, Groq, OpenRouter, Cerebras |
| Live progress | Streamed to the side panel while the run is in flight |

- [Installation](https://nobijoy.github.io/ai-form-filler/installation.html) — [Chrome Web Store](https://chromewebstore.google.com/detail/ai-form-filler/kacfbgoplpkcmhamjcdfddjnhgacemfh) or build from GitHub  
- [Tutorial](https://nobijoy.github.io/ai-form-filler/tutorial.html) — configure and fill forms (includes [free API keys](https://nobijoy.github.io/ai-form-filler/tutorial.html#free-keys))

## Side panel reference

| Section | Controls |
| --- | --- |
| **Run** | Custom request textarea, **Fill this page**, status line |
| **Progress** | Live log of the current/last run, **Clear** |
| **Connection** | Provider, API key (Test / Save / Remove), remember & encrypt options, model |
| **Behavior** | Fill mode, language, auto-next, step/round/settle limits, empty-only, sensitive skip |
| **Save settings** | Persists behavior and connection choices (keys are saved separately via **Save key**) |

UI strings ship in English and German (`_locales/en`, `_locales/de`).

## Architecture

Work is split across isolated Chrome contexts. The content script owns DOM access and orchestration; the service worker owns credentials and all outbound HTTP; the side panel is configuration, the custom request box, and the progress log.

```mermaid
flowchart TB
  subgraph Page["Host page"]
    DOM[DOM / forms]
  end

  subgraph CS["Content script"]
    Entry[index.ts]
    Orch[fillOrchestrator]
    RunState["runState: step epochs"]
    FieldId["fieldId: content-hash sids"]
    Scan[scan]
    Widgets["widgets: native + aria adapters"]
    Settle["settle: MutationObserver"]
    Validate[validate]
    Nav[navigation]
  end

  subgraph BG["Service worker"]
    Router[message router]
    LLM[llm]
    Adapters["provider adapters"]
    Vault["keyVault: AES-GCM"]
    Store[storage]
  end

  subgraph SP["Side panel"]
    Panel[main.ts]
    Log[progress log]
  end

  Panel -->|RUN_FILL| Entry
  Entry --> Orch
  Orch --> RunState
  Orch --> Scan
  Scan --> FieldId
  Scan --> Widgets
  Widgets --> DOM
  Orch --> Settle
  Orch --> Validate
  Orch --> Nav
  Nav --> DOM
  Orch -->|RUN_PROGRESS| Log
  Orch <-->|LLM_FILL| Router
  Router --> LLM
  LLM --> Adapters
  Router --> Store
  Store --> Vault
  Adapters -->|HTTPS| Cloud[(Provider APIs)]
```

### Runtime contexts

| Context | Entry point | Responsibility |
| --- | --- | --- |
| Content script | `src/content/index.ts` | Owns the DOM. Scans, applies, validates, navigates, streams progress |
| Service worker | `src/background/index.ts` | Message router. Holds keys, builds prompts, performs all network calls |
| Side panel | `src/sidepanel/main.ts` | Provider and model config, custom request, run trigger, live log |

The page never sees an API key: the content script asks the worker for values and receives only the values back.

## Fill workflow

```mermaid
sequenceDiagram
  participant U as User
  participant SP as Side panel
  participant CS as Content script
  participant DOM as Page DOM
  participant BG as Service worker
  participant API as Provider

  U->>SP: Fill this page
  SP->>CS: RUN_FILL
  CS->>BG: GET_SETTINGS
  BG-->>CS: settings (no key material)

  loop Each form step
    CS->>CS: beginEpoch, fresh applied map
    CS->>DOM: scan via widget adapters
    CS->>CS: chunk by fieldset / role=group / heading
    loop Each chunk, bounded by maxRounds
      CS->>BG: LLM_FILL(snapshot + run context)
      BG->>API: chat completion
      API-->>BG: JSON values
      BG-->>CS: values
      CS->>CS: validate, resolve option labels
      CS->>DOM: apply via native setters + events
      CS->>DOM: waitForDomQuiet (reveals conditionals)
      CS-->>SP: RUN_PROGRESS
    end
    CS->>DOM: click next, compare field fingerprint
    alt Page reported validation errors
      CS->>BG: LLM_FILL(corrections)
      CS->>DOM: repair, click next again
    end
  end

  CS-->>SP: fields filled, steps completed
```

## Why reactive forms need special handling

Three distinct problems, each addressed by a specific mechanism:

**1. Frameworks revert direct writes.** React installs an instance-level `value` property to track changes. Assigning `el.value = x` updates that tracker too, so the `input` event that follows looks like a no-op and React restores its own state. Writes therefore go through the prototype's setter:

```20:31:src/content/widgets/dom.ts
export function setNativeValue(el: HTMLElement, value: string): void {
  const descriptor =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value") ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set) descriptor.set.call(el, value);
  else (el as HTMLInputElement).value = value;
}
```

Every apply verifies the result afterwards and reports failure rather than assuming success.

**2. DOM nodes are recycled between steps.** React reuses the same `<input>` elements across wizard steps, so identity derived from the element alone makes step 2 inherit step 1's recorded values — the run then sees nothing left to fill and exits. Synthetic ids are instead `s{epoch}_{hash}`, where the hash covers structural path, `name`, `id`, label text, control type and option signature, and the epoch increments on every step change. A recycled node cannot collide with a previous step's state, because crossing a step boundary starts a fresh applied map rather than pruning the old one.

Framework-generated identifiers (`:r3:`, `mui-1234`, `radix-…`) are excluded from the hash, since they change on every mount.

**3. Option values are not option labels.** For `<option value="13">Tokyo</option>`, a model told only about `"13"` has nothing to reason with; told about `Tokyo`, it answers `"Tokyo"`, which exact-value comparison then rejects. Prompts now carry `[value, label]` pairs, and `resolveOptionValue` matches from strictest to loosest — exact value, exact label, NFKC/case/punctuation-normalized, then unique containment — refusing to guess when a loose match is ambiguous.

## Multi-step navigation

Step change is detected by a **content fingerprint** of the visible field set (labels, kinds, option counts) plus URL and active step-indicator text. Synthetic ids are deliberately not part of it: they are namespaced per step and would report a change on every scan.

Forward controls are ranked by multilingual label markers, position, and membership of the active form; back, cancel and reset controls are scored out. Final-submit controls (pay, place order, checkout) are only clicked when explicitly allowed, which by default they are not — the run stops with the form filled and the last click left to you.

When a click does not change the fingerprint, the page is inspected for `aria-invalid`, `aria-errormessage`, and `role="alert"` text. Those messages are quoted back to the model as a `corrections` block for a repair round, then the click is retried once.

**Search / lookup fields:** after filling a search-like control, the extension waits for a results list or table and clicks the best matching row (using the typed value and any quoted name in the custom request). Search inputs are not blurred immediately so typeahead panels stay open.

## Custom requests and language

The side panel has a single free-text box, empty by default. Anything entered is injected into the prompt as a clearly delimited block:

```
USER RULES (highest priority, override anything above that conflicts):
Phone as 090-XXXX-XXXX. User names in Japanese.
```

It is carried into every chunk and into the navigation call, so it applies uniformly across a long form.

Language resolution has three levels, most specific first:

1. A field's own `lang` attribute, collected during the scan.
2. An explicit BCP-47 override, when **Value language** is set to *Always use…*.
3. The page's `<html lang>`, otherwise the browser locale.

## Configuration

Settings live in `chrome.storage.local` under `aff_settings` and are sanitized on every read.

| Setting | Default | Meaning |
| --- | --- | --- |
| `provider` / `baseUrl` / `model` | OpenAI / `https://api.openai.com/v1` / `gpt-4o-mini` | Selected provider, endpoint, and model |
| `fillMode` | `hybrid` | `hybrid`, `ai_only`, or `heuristics_only` |
| `fillLanguage` / `fillLocaleOverride` | `auto` / empty | Follow the page, or force a BCP-47 locale |
| `customRequest` | empty | Free-text user rules |
| `maxRounds` | `24` (range 1–60) | Chunk attempts per step |
| `settleMs` | `120` (0–3000) | Extra delay after writes, on top of mutation-based settling |
| `autoNextEnabled` / `autoNextMaxSteps` | `true` / `15` (cap 50) | Automatic advancing |
| `fillEmptyOnly` | `true` | Skip fields that already hold a value |
| `excludeSensitiveFields` | `false` | Skip password and payment (`cc-*`) fields |
| `rememberKeyAcrossRestarts` | `true` | Persist keys, or drop them on browser start |
| `encryptKeys` | `false` | Encrypt stored keys at rest behind a passphrase |

## LLM providers

**Free keys (recommended to start):** [Google AI Studio](https://aistudio.google.com/apikey) and [Groq Cloud](https://console.groq.com/keys) both give you an API key at no charge. Their free tiers are enough for filling forms while you test. Walkthrough: [Tutorial → Get a free API key](https://nobijoy.github.io/ai-form-filler/tutorial.html#free-keys).

**Recommended models for testing:** Google AI Studio → **Gemini 3.1 Flash** (`gemini-3.1-flash`) for fewer fill errors and better efficiency. Groq Cloud → **Llama 3.3 70B Versatile** (`llama-3.3-70b-versatile`).

| Provider | Kind | Default model | Notes |
| --- | --- | --- | --- |
| Google AI Studio | OpenAI-compatible | `gemini-3.1-flash` | Free tier; use Gemini 3.1 Flash for testing |
| Groq Cloud | OpenAI-compatible | `llama-3.3-70b-versatile` | Free tier, no credit card |
| OpenAI | OpenAI-compatible | `gpt-4o-mini` | Paid |
| Anthropic | Anthropic messages | `claude-3-5-haiku-latest` | Paid |
| xAI | OpenAI-compatible | `grok-3-mini` | Paid |
| OpenRouter | OpenAI-compatible | `openrouter/auto` | Mix of paid and some free models |
| Cerebras | OpenAI-compatible | `llama-3.3-70b` | Has a limited free tier |

Anthropic differs enough to need its own adapter: `POST /v1/messages`, an `x-api-key` header, `anthropic-version`, a top-level `system` string, a mandatory `max_tokens`, and content returned as a block array. The `kind` discriminator on each provider selects the request builder and response reader.

**Only the selected provider is contacted.** Form contents are not sent to another vendor. Provider base URLs are pinned in code to each vendor's catalog origin before any authenticated fetch; a mistyped or attacker-supplied base URL cannot receive a key even though the manifest also lists `http://*/*` and `https://*/*` for page injection.

Within a provider, a failed request walks the configured model, then the provider's default, then its fallback list, and steps down through decreasing output-token budgets when a request is rejected as too large. Authentication failures and the per-chunk request budget stop the walk immediately, since neither improves with another model.

## Security and storage

- API keys live in extension storage and are read only by the service worker. Web pages, including the page being filled, never receive them.
- The background message router rejects senders whose `id` is not this extension, and vault/key mutations are limited to extension pages (not content scripts).
- The worker reports key **presence** and encryption state to the UI, never key material, and nothing key-derived is logged.
- `rememberKeyAcrossRestarts: false` keeps keys in a separate local bucket stamped with a `chrome.storage.session` browser-session id, and clears them on `onStartup` / `onInstalled`. A crash or missed startup still invalidates the stamp, so those keys do not outlive the browser session the user expected.
- With `encryptKeys` enabled, keys are wrapped with AES-GCM under a PBKDF2-derived key (250k iterations, SHA-256, random per-profile salt). Passphrases must be at least 8 characters and confirmed in the UI. The derived key is held in `chrome.storage.session`, so it survives service-worker restarts but not a browser restart. Off by default.
- Manual fills start from an explicit user action (side panel, context menu, or command). Multi-step wizards may auto-resume after navigation from a short-lived session checkpoint, but only on the same tab that started the run.
- Password and payment fields can be skipped via `excludeSensitiveFields` (off by default). Turning off "fill empty only" shows a warning that existing values may be sent to the LLM.
- Content scripts run with `all_frames: false` on purpose: the extension stays out of third-party payment widgets and cross-origin iframes.
- Anyone with access to the browser profile can use a stored key. Encryption raises the bar for at-rest access; it is not a defence against a compromised profile in use.

## Project layout

```
ai-form-filler/
├── manifest.config.ts        # MV3 manifest; provider origins + http(s) wildcards for injection
├── docs/                     # GitHub Pages documentation site
├── _locales/{en,de}/         # UI strings
└── src/
    ├── background/
    │   ├── index.ts          # Message router, lifecycle, context menu
    │   ├── llm.ts            # Prompts, model discovery, provider walk
    │   ├── storage.ts        # Settings and key persistence
    │   └── keyVault.ts       # Optional AES-GCM encryption at rest
    ├── content/
    │   ├── index.ts          # RUN_FILL listener, progress streaming
    │   ├── fillOrchestrator.ts # Step and round state machine
    │   ├── runState.ts       # Step epochs, applied values, run context
    │   ├── runPersistence.ts # Session checkpoints across navigations
    │   ├── fieldId.ts        # Content-hash synthetic ids
    │   ├── scan.ts           # Adapter-driven DOM scan
    │   ├── chunking.ts       # DOM-structure grouping
    │   ├── apply.ts          # Batch writes, drift reconciliation
    │   ├── validate.ts       # Model output validation
    │   ├── settle.ts         # MutationObserver settling
    │   ├── navigation.ts     # Step detection and advancing
    │   ├── candidates.ts     # Unresolved-field selection
    │   └── widgets/          # native.ts, aria.ts, dom.ts adapters
    ├── shared/
    │   ├── types.ts          # Settings, descriptors, messages
    │   ├── providers.ts      # Provider catalog and request shaping
    │   ├── optionMatch.ts    # Option and boolean resolution
    │   ├── heuristics.ts     # Network-free value generation
    │   ├── fillable.ts       # Fillability rules
    │   ├── patternCoerce.ts  # Pattern-aware value coercion
    │   └── llmResponseSchema.ts # Response parsing
    └── sidepanel/            # index.html, main.ts, sidepanel.css
```

## Development

```bash
npm install
npm run build      # tsc --noEmit && vite build
npm run dev        # rebuild on change
npm run check      # typecheck only
```

Load the extension from `dist/` via `chrome://extensions` → **Load unpacked**. Click the toolbar icon to open the side panel.

Adding support for a new widget family means writing one adapter with `match` / `describe` / `read` / `apply` in `src/content/widgets/` and registering it in `widgets/index.ts`. ARIA adapters are registered before native ones, so a `role="combobox"` input is driven as a combobox rather than as plain text.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Privacy Policy: [https://nobijoy.github.io/ai-form-filler/privacy.html](https://nobijoy.github.io/ai-form-filler/privacy.html)
