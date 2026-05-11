import type { LlmProviderId, OpenRouterModelOption } from "./types";

export interface ProviderDefinition {
  id: LlmProviderId;
  label: string;
  keyLabel: string;
  docsUrl: string;
  defaultBaseUrl: string;
  defaultModel: string;
  fallbackModels: OpenRouterModelOption[];
}

export const PROVIDERS: Record<LlmProviderId, ProviderDefinition> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyLabel: "OpenRouter API key",
    docsUrl: "https://openrouter.ai/keys",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    fallbackModels: [
      { id: "openrouter/free", name: "Auto-Router (Free)", contextLength: 0, label: "Auto-Router (Free)" },
      {
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Instruct (Free)",
        contextLength: 131072,
        label: "Llama 3.3 70B Instruct (Free) - 131k context",
        isFallback: true,
      },
      {
        id: "google/gemma-3-27b-it:free",
        name: "Gemma 3 27B IT (Free)",
        contextLength: 131072,
        label: "Gemma 3 27B IT (Free) - 131k context",
        isFallback: true,
      },
    ],
  },
  groq: {
    id: "groq",
    label: "Groq Cloud",
    keyLabel: "Groq API key",
    docsUrl: "https://console.groq.com/keys",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.1-8b-instant",
    fallbackModels: [
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", contextLength: 131072, label: "Llama 3.1 8B Instant" },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", contextLength: 131072, label: "Llama 3.3 70B Versatile" },
    ],
  },
  google: {
    id: "google",
    label: "Google AI Studio",
    keyLabel: "Gemini API key",
    docsUrl: "https://aistudio.google.com/apikey",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    fallbackModels: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextLength: 1048576, label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1048576, label: "Gemini 2.5 Pro" },
    ],
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    keyLabel: "Cerebras API key",
    docsUrl: "https://cloud.cerebras.ai/platform/api-keys",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama3.1-8b",
    fallbackModels: [
      { id: "llama3.1-8b", name: "Llama 3.1 8B", contextLength: 131072, label: "Llama 3.1 8B" },
      { id: "gpt-oss-120b", name: "GPT OSS 120B", contextLength: 131072, label: "GPT OSS 120B" },
    ],
  },
};

