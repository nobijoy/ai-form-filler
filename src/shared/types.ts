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
  autoNextEnabled: true,
  autoNextMaxSteps: 10,
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
  /** When set, this text/textarea is only filled if the controlling checkbox is selected. */
  controllingCheckboxSid?: string;
}

export type FormMemory = {
  formType?: string;
  locale?: string;
  pageTitle?: string;
  jobCategory?: string;
  employmentType?: string;
  hiringCount?: string;
  agencyJob?: string;
  countryLanguage?: string;
  companySummary?: string;
  location?: string;
  transfer?: string;
  workStyle?: string;
  salaryType?: string;
  monthlyWorkHours?: string;
  overtime?: string;
  candidateProfile?: string;
};

export type ChunkDescriptor = {
  sectionName: string;
  fieldSids: string[];
};

export interface FillSnapshot {
  pageTitle: string;
  pageUrl: string;
  documentLocale: string;
  fillLocale: string;
  roundIndex: number;
  maxRounds: number;
  fields: FieldDescriptor[];
  heuristicSummary?: { syntheticId: string; value: string }[];
  chunkSection?: string;
  chunkCtx?: Partial<FormMemory>;
  retryOnly?: string[];
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

export interface FillRunResult {
  ok: boolean;
  warnings: string[];
}

export interface NavigationControlDescriptor {
  sid: string;
  tag: string;
  inputType?: string;
  labelText: string;
  ariaLabel?: string;
  name?: string;
  role?: string;
  inActiveForm: boolean;
  isSubmit: boolean;
  markerScore: number;
  position: "start" | "middle" | "end";
}

export interface NavigationSnapshot {
  pageTitle: string;
  pageUrl: string;
  documentLocale: string;
  fillLocale: string;
  visibleFillableFieldCount: number;
  unresolvedRequiredCount: number;
  multiStepHints: string[];
  controls: NavigationControlDescriptor[];
}

export interface NavigationDecision {
  isMultiStep: boolean;
  shouldAdvanceAfterFill: boolean;
  nextControlSid?: string;
  isFinalSubmit: boolean;
  confidence: number;
  source: "heuristic" | "ai";
}

export interface LlmNavigationResponse {
  ok: boolean;
  decision?: NavigationDecision;
  error?: string;
}

export interface OpenRouterModelOption {
  id: string;
  name: string;
  contextLength: number;
  label: string;
  isFallback?: boolean;
}
