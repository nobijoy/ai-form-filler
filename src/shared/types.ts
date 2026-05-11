export type FillMode = "hybrid" | "ai_only" | "heuristics_only";
export type LlmProviderId = "openrouter" | "groq" | "google" | "cerebras";

export type FillLanguagePolicy = "auto" | "override";

export interface ExtensionSettings {
  provider: LlmProviderId;
  baseUrl: string;
  model: string;
  fillMode: FillMode;
  fillLanguage: FillLanguagePolicy;
  fillLocaleOverride: string;
  personaJson: string;
  maxRounds: number;
  settleMs: number;
  autoNextEnabled: boolean;
  autoNextMaxSteps: number;
  fillEmptyOnly: boolean;
  rememberKeyAcrossRestarts: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openrouter/free",
  fillMode: "hybrid",
  fillLanguage: "auto",
  fillLocaleOverride: "",
  personaJson: "",
  maxRounds: 5,
  settleMs: 100,
  autoNextEnabled: false,
  autoNextMaxSteps: 3,
  fillEmptyOnly: true,
  rememberKeyAcrossRestarts: true,
};

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDescriptor {
  syntheticId: string;
  tag: "input" | "textarea" | "select";
  inputType?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  required?: boolean;
  pattern?: string;
  maxLength?: number;
  autoComplete?: string;
  ariaLabel?: string;
  labelText?: string;
  formPurpose?: string;
  surroundingText?: string;
  options?: FieldOption[];
  radioGroup?: string;
  radioChoices?: FieldOption[];
  currentValue: string;
  disabled: boolean;
  visible: boolean;
  fieldLocale?: string;
}

export interface FillSnapshot {
  pageTitle: string;
  pageUrl: string;
  documentLocale: string;
  fillLocale: string;
  roundIndex: number;
  maxRounds: number;
  fields: FieldDescriptor[];
  heuristicSummary?: { syntheticId: string; value: string }[];
}

export interface LlmFillRequest {
  type: "LLM_FILL";
  snapshot: FillSnapshot;
}

export interface LlmFillResponse {
  ok: boolean;
  values?: Record<string, string>;
  error?: string;
  skipped?: boolean;
}

export interface OpenRouterModelOption {
  id: string;
  name: string;
  contextLength: number;
  label: string;
  isFallback?: boolean;
}
