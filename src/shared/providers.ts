import type { LlmProviderId, ModelOption } from "./types";

/**
 * Provider catalog.
 *
 * Most vendors expose an OpenAI-compatible `/chat/completions` surface.
 * Anthropic does not: it uses `/v1/messages`, an `x-api-key` header, a top-level
 * `system` string, and returns content as a block array. The `kind`
 * discriminator selects the right request builder and response reader.
 */

export type ProviderKind = "openai_compatible" | "anthropic";

export interface ChatRequest {
  systemPrompt: string;
  userMessages: string[];
  model: string;
  maxTokens: number;
  temperature: number;
  /** Ask for a JSON object when the provider supports response formats. */
  jsonMode: boolean;
  /** OpenAI-compatible reasoning control, used by Gemini thinking models. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
}

export interface ProviderDefinition {
  id: LlmProviderId;
  kind: ProviderKind;
  label: string;
  keyLabel: string;
  docsUrl: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** Origin pattern required in the manifest for the service worker to reach it. */
  originPattern: string;
  fallbackModels: ModelOption[];
}

function model(id: string, name: string, contextLength: number): ModelOption {
  const context =
    contextLength >= 1000 ? `${Math.round(contextLength / 1000)}k context` : "unknown context";
  return { id, name, contextLength, label: `${name} - ${context}` };
}

export const PROVIDERS: Record<LlmProviderId, ProviderDefinition> = {
  openai: {
    id: "openai",
    kind: "openai_compatible",
    label: "OpenAI",
    keyLabel: "OpenAI API key",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    originPattern: "https://api.openai.com/*",
    fallbackModels: [
      model("gpt-4o-mini", "GPT-4o mini", 128000),
      model("gpt-4o", "GPT-4o", 128000),
      model("gpt-4.1-mini", "GPT-4.1 mini", 1047576),
    ],
  },
  anthropic: {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic",
    keyLabel: "Anthropic API key",
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    originPattern: "https://api.anthropic.com/*",
    fallbackModels: [
      model("claude-3-5-haiku-latest", "Claude 3.5 Haiku", 200000),
      model("claude-3-5-sonnet-latest", "Claude 3.5 Sonnet", 200000),
      model("claude-sonnet-4-0", "Claude Sonnet 4", 200000),
    ],
  },
  google: {
    id: "google",
    kind: "openai_compatible",
    label: "Google AI Studio",
    keyLabel: "Gemini API key",
    docsUrl: "https://aistudio.google.com/apikey",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.1-flash",
    originPattern: "https://generativelanguage.googleapis.com/*",
    fallbackModels: [
      model("gemini-3.1-flash", "Gemini 3.1 Flash", 1048576),
      model("gemini-2.5-flash", "Gemini 2.5 Flash", 1048576),
      model("gemini-2.0-flash", "Gemini 2.0 Flash", 1048576),
      model("gemini-2.5-pro", "Gemini 2.5 Pro", 1048576),
    ],
  },
  xai: {
    id: "xai",
    kind: "openai_compatible",
    label: "xAI",
    keyLabel: "xAI API key",
    docsUrl: "https://console.x.ai/",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3-mini",
    originPattern: "https://api.x.ai/*",
    fallbackModels: [
      model("grok-3-mini", "Grok 3 mini", 131072),
      model("grok-3", "Grok 3", 131072),
      model("grok-2-1212", "Grok 2", 131072),
    ],
  },
  groq: {
    id: "groq",
    kind: "openai_compatible",
    label: "Groq Cloud",
    keyLabel: "Groq API key",
    docsUrl: "https://console.groq.com/keys",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    originPattern: "https://api.groq.com/*",
    fallbackModels: [
      model("llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", 131072),
      model("llama-3.1-8b-instant", "Llama 3.1 8B Instant", 131072),
      model("openai/gpt-oss-120b", "GPT OSS 120B", 131072),
    ],
  },
  openrouter: {
    id: "openrouter",
    kind: "openai_compatible",
    label: "OpenRouter",
    keyLabel: "OpenRouter API key",
    docsUrl: "https://openrouter.ai/keys",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    originPattern: "https://openrouter.ai/*",
    fallbackModels: [
      { id: "openrouter/auto", name: "Auto-Router", contextLength: 0, label: "Auto-Router" },
      model("meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B (Free)", 131072),
      model("google/gemma-3-27b-it:free", "Gemma 3 27B (Free)", 131072),
    ],
  },
  cerebras: {
    id: "cerebras",
    kind: "openai_compatible",
    label: "Cerebras",
    keyLabel: "Cerebras API key",
    docsUrl: "https://cloud.cerebras.ai/platform/api-keys",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    originPattern: "https://api.cerebras.ai/*",
    fallbackModels: [
      model("llama-3.3-70b", "Llama 3.3 70B", 131072),
      model("llama3.1-8b", "Llama 3.1 8B", 131072),
      model("gpt-oss-120b", "GPT OSS 120B", 131072),
    ],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as LlmProviderId[];

export const PROVIDER_ORIGIN_PATTERNS = PROVIDER_IDS.map((id) => PROVIDERS[id].originPattern);

export function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

/**
 * True when `baseUrl` targets the same origin as the provider's default endpoint.
 * Host wildcards in the manifest allow page injection; this pin stops API keys
 * from being sent to an attacker-controlled base URL.
 */
export function isAllowedBaseUrl(provider: ProviderDefinition, baseUrl: string): boolean {
  try {
    const candidate = new URL(baseUrl);
    const expected = new URL(provider.defaultBaseUrl);
    return candidate.origin === expected.origin;
  } catch {
    return false;
  }
}

/** Returns a provider-safe base URL, falling back to the catalog default. */
export function resolveProviderBaseUrl(provider: ProviderDefinition, baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed && isAllowedBaseUrl(provider, trimmed)) return trimmed.replace(/\/+$/, "");
  return provider.defaultBaseUrl.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const OPENROUTER_APP_URL = "https://github.com/";
const OPENROUTER_APP_TITLE = "AI Form Filler";

export function prepareRequest(
  provider: ProviderDefinition,
  baseUrl: string,
  apiKey: string,
  request: ChatRequest,
): PreparedRequest {
  const base = baseUrl.replace(/\/+$/, "");

  if (provider.kind === "anthropic") {
    return {
      url: `${base}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for requests originating from an extension context.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        system: request.systemPrompt,
        messages: request.userMessages.map((content) => ({ role: "user", content })),
      }),
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = OPENROUTER_APP_URL;
    headers["X-Title"] = OPENROUTER_APP_TITLE;
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    messages: [
      { role: "system", content: request.systemPrompt },
      ...request.userMessages.map((content) => ({ role: "user", content })),
    ],
  };
  if (request.jsonMode) body.response_format = { type: "json_object" };
  if (provider.id === "openrouter") body.include_reasoning = false;
  if (provider.id === "google" && request.reasoningEffort) {
    body.reasoning_effort = request.reasoningEffort;
  }

  return { url: `${base}/chat/completions`, headers, body: JSON.stringify(body) };
}

export interface ProviderReply {
  content: string | null;
  finishReason: string | null;
}

export function readReply(provider: ProviderDefinition, rawBody: string): ProviderReply {
  const parsed: unknown = JSON.parse(rawBody);

  if (provider.kind === "anthropic") {
    const data = parsed as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string | null;
    };
    const text = (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    return { content: text || null, finishReason: data.stop_reason ?? null };
  }

  const data = parsed as {
    choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
  };
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    finishReason: choice?.finish_reason ?? null,
  };
}

/** Extracts a human-usable message from a provider's error body. */
export function readProviderError(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string; code?: number | string; metadata?: { raw?: string } } | string;
      message?: string;
      code?: string;
    };

    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.metadata?.raw) return parsed.error.metadata.raw;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
    if (parsed.code) return String(parsed.code);
  } catch {
    // Non-JSON error body.
  }
  return rawBody.slice(0, 300);
}
