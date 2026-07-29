export type FillMode = "hybrid" | "ai_only" | "heuristics_only";

export type LlmProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "groq"
  | "openrouter"
  | "cerebras";

export type FillLanguagePolicy = "auto" | "override";

/** Upper bound on wizard steps a single run may traverse. */
export const MAX_FORM_STEPS = 50;

export interface ExtensionSettings {
  provider: LlmProviderId;
  baseUrl: string;
  model: string;
  fillMode: FillMode;
  fillLanguage: FillLanguagePolicy;
  /** BCP-47 tag, or empty to follow the page. */
  fillLocaleOverride: string;
  /**
   * Free-text instructions from the user, normally empty. Only supplied when the
   * user has a specific requirement ("phone as 090-XXXX-XXXX", "names in Japanese").
   */
  customRequest: string;
  maxRounds: number;
  settleMs: number;
  autoNextEnabled: boolean;
  autoNextMaxSteps: number;
  fillEmptyOnly: boolean;
  rememberKeyAcrossRestarts: boolean;
  /**
   * Providers to try if the selected one fails. Empty by default: form contents
   * must not be sent to a vendor the user did not choose.
   */
  fallbackProviders: LlmProviderId[];
  /** Encrypt stored API keys at rest behind a passphrase. */
  encryptKeys: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  fillMode: "hybrid",
  fillLanguage: "auto",
  fillLocaleOverride: "",
  customRequest: "",
  maxRounds: 24,
  settleMs: 120,
  autoNextEnabled: true,
  autoNextMaxSteps: 15,
  fillEmptyOnly: true,
  rememberKeyAcrossRestarts: true,
  fallbackProviders: [],
  encryptKeys: false,
};

export interface FieldOption {
  value: string;
  label: string;
}

export type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "aria-checkbox"
  | "aria-radio"
  | "aria-switch"
  | "aria-combobox"
  | "contenteditable";

export interface FieldDescriptor {
  syntheticId: string;
  tag: "input" | "textarea" | "select" | "custom";
  /** Normalized control kind, set by the widget adapter that produced this descriptor. */
  kind?: FieldKind;
  inputType?: string;
  /** ARIA role, when the control is not a native form element. */
  role?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  required?: boolean;
  pattern?: string;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  inputMode?: string;
  autoComplete?: string;
  ariaLabel?: string;
  labelText?: string;
  formPurpose?: string;
  surroundingText?: string;
  /**
   * Help text the field points at with `aria-describedby`. This is where forms
   * normally state a required format, so it matters more than most context.
   */
  describedByText?: string;
  options?: FieldOption[];
  radioGroup?: string;
  radioChoices?: FieldOption[];
  currentValue: string;
  disabled: boolean;
  visible: boolean;
  fieldLocale?: string;
  /** Stable key of the enclosing fieldset / role=group / heading section. */
  groupKey?: string;
  /** Human-readable name of that section, used for chunk naming and prompts. */
  groupLabel?: string;
  /** Checkboxes sharing this key form one logical multi-select group. */
  checkboxGroupKey?: string;
  /** Hard cap on selections, only set when the DOM actually declares one. */
  maxSelections?: number;
  /** Set when the page is currently reporting this field as invalid. */
  ariaInvalid?: boolean;
  /** Validation text the page surfaced for this field. */
  validationMessage?: string;
  /** When set, this text/textarea is only filled if the controlling checkbox is selected. */
  controllingCheckboxSid?: string;
}

/**
 * Cross-step memory for a single fill run. Deliberately schema-free: the model
 * decides which facts matter for the form in front of it, rather than being
 * constrained to a fixed set of keys for one particular form.
 */
export interface RunContext {
  /**
   * Unique for each manual run. It asks the model and local heuristics for a
   * different synthetic profile while keeping every step in that run coherent.
   */
  variationSeed: string;
  /** Facts about the form discovered while filling, e.g. { orderType: "delivery" }. */
  facts: Record<string, string>;
  /**
   * Values already committed, keyed by semantic slot (email, firstName, phone,
   * …) so a later step's "confirm email" reuses the earlier value.
   */
  identity: Record<string, string>;
  /** One short line per completed step, giving the model narrative continuity. */
  stepSummaries: string[];
}

export type ChunkDescriptor = {
  /** Human-readable group name derived from the DOM (legend, heading, aria-label). */
  sectionName: string;
  fieldSids: string[];
};

export interface ValidationIssue {
  sid?: string;
  message: string;
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
  chunkSection?: string;
  /** Step number (1-based) this chunk belongs to, for prompt context. */
  stepIndex?: number;
  runContext?: RunContext;
  retryOnly?: string[];
  /** Validation messages the page surfaced for these fields on a previous attempt. */
  validationErrors?: ValidationIssue[];
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
  stepsCompleted: number;
  fieldsFilled: number;
}

/** Streamed to the side panel while a run is in progress. */
export interface RunProgressMessage {
  type: "RUN_PROGRESS";
  message: string;
  at: number;
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

export interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
  label: string;
  isFallback?: boolean;
}
