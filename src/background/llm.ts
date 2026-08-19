import { isFillableField } from "../shared/fillable";
import { dateTypeForPrompt } from "../shared/dateField";
import { parseLlmValues, parseNavigationDecision } from "../shared/llmResponseSchema";
import {
  PROVIDERS,
  isAllowedBaseUrl,
  prepareRequest,
  readProviderError,
  readReply,
  resolveProviderBaseUrl,
  type ChatRequest,
  type ProviderDefinition,
} from "../shared/providers";
import type {
  ExtensionSettings,
  FieldDescriptor,
  FillSnapshot,
  LlmProviderId,
  ModelOption,
  NavigationSnapshot,
  RunContext,
} from "../shared/types";

const MAX_HTTP_CALLS_PER_FILL = 8;
const MAX_ATTEMPTS_PER_MODEL = 3;
const CUSTOM_REQUEST_LIMIT = 1500;

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

interface ModelRecord {
  id?: string;
  name?: string;
  display_name?: string;
  context_length?: number | null;
  context_window?: number | null;
  pricing?: { prompt?: string | number; completion?: string | number };
}

function formatContextLabel(contextLength: number): string {
  if (!Number.isFinite(contextLength) || contextLength <= 0) return "unknown context";
  if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}k context`;
  return `${contextLength} context`;
}

function toModelOption(record: ModelRecord): ModelOption | null {
  if (!record.id) return null;
  const contextLength = Number(record.context_length ?? record.context_window ?? 0);
  const safeContext = Number.isFinite(contextLength) ? contextLength : 0;
  const name = (record.display_name || record.name || record.id).trim();
  return {
    id: record.id,
    name,
    contextLength: safeContext,
    label: `${name} - ${formatContextLabel(safeContext)}`,
  };
}

function modelsEndpointFor(provider: ProviderDefinition, baseUrl: string): string | null {
  const base = baseUrl.replace(/\/+$/, "");
  if (provider.kind === "anthropic") return `${base}/v1/models`;
  return `${base}/models`;
}

function modelsHeadersFor(provider: ProviderDefinition, apiKey: string): Record<string, string> {
  if (provider.kind === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Live model list where the provider offers one, static fallback otherwise.
 * Never throws: an unavailable list must not block configuration.
 */
export async function getProviderModels(
  providerId: LlmProviderId,
  apiKey?: string,
  baseUrlOverride?: string,
): Promise<{ models: ModelOption[]; fromFallback: boolean }> {
  const provider = PROVIDERS[providerId];
  const fallback = { models: provider.fallbackModels, fromFallback: true };

  const key = (apiKey ?? "").trim();
  if (!key) return fallback;

  const rawBase = baseUrlOverride?.trim() || provider.defaultBaseUrl;
  if (!isAllowedBaseUrl(provider, rawBase)) return fallback;

  const endpoint = modelsEndpointFor(provider, resolveProviderBaseUrl(provider, rawBase));
  if (!endpoint) return fallback;

  try {
    const res = await fetch(endpoint, { headers: modelsHeadersFor(provider, key) });
    if (!res.ok) return fallback;

    const payload = (await res.json()) as { data?: ModelRecord[]; models?: ModelRecord[] };
    const records = payload.data ?? payload.models;
    if (!Array.isArray(records)) return fallback;

    const options = records
      .map(toModelOption)
      .filter((option): option is ModelOption => option !== null)
      .sort((a, b) => b.contextLength - a.contextLength || a.id.localeCompare(b.id));

    if (options.length === 0) return fallback;

    // Keep the curated default first so a sensible model is preselected.
    const preferred = options.filter((option) => option.id === provider.defaultModel);
    const rest = options.filter((option) => option.id !== provider.defaultModel);
    return { models: [...preferred, ...rest], fromFallback: false };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function fieldLabel(field: FieldDescriptor): string {
  return (field.labelText ?? field.ariaLabel ?? field.placeholder ?? field.name ?? "").slice(0, 140);
}

/**
 * Options are sent as `[value, label]` pairs.
 *
 * Sending only machine values (`["1","2"]`) left the model guessing what an
 * option meant, so its answers were rejected for not matching. With the visible
 * label present it can choose meaningfully, and either form resolves on apply.
 */
function encodeOptions(options: { value: string; label: string }[] | undefined): unknown {
  if (!options || options.length === 0) return undefined;
  return options
    .filter((option) => option.value !== "" || option.label !== "")
    .slice(0, 40)
    .map((option) => (option.label && option.label !== option.value
      ? [option.value, option.label.slice(0, 60)]
      : [option.value]));
}

interface CompactField {
  sid: string;
  type: string;
  label: string;
  required?: true;
  group?: string;
  placeholder?: string;
  options?: unknown;
  maxLen?: number;
  pattern?: string;
  min?: string;
  max?: string;
  lang?: string;
  /** ISO country selected by a composite phone input. */
  country?: string;
  /** The field's own help text, which usually states the required format. */
  help?: string;
  hint?: string;
  /** Set when this field only applies if another checkbox is selected. */
  requiresChecked?: string;
  /** Present when the DOM caps how many of a group may be selected. */
  maxSelections?: number;
  current?: string;
}

function compactField(field: FieldDescriptor): CompactField {
  const compact: CompactField = {
    sid: field.syntheticId,
    type: dateTypeForPrompt(field) || field.kind || field.inputType || field.tag,
    label: fieldLabel(field),
  };

  if (field.required) compact.required = true;
  if (field.checkboxGroupKey) compact.group = field.checkboxGroupKey;
  if (field.maxSelections) compact.maxSelections = field.maxSelections;
  if (field.placeholder) compact.placeholder = field.placeholder.slice(0, 80);
  if (field.maxLength) compact.maxLen = field.maxLength;
  if (field.pattern) compact.pattern = field.pattern;
  if (field.min) compact.min = field.min;
  if (field.max) compact.max = field.max;
  if (field.fieldLocale) compact.lang = field.fieldLocale;
  if (field.phoneCountry) compact.country = field.phoneCountry;
  if (field.controllingCheckboxSid) compact.requiresChecked = field.controllingCheckboxSid;
  if (field.currentValue) compact.current = field.currentValue.slice(0, 60);

  const options = encodeOptions(field.options ?? field.radioChoices);
  if (options) compact.options = options;

  // Always sent: this is where forms state the format they expect, so it is the
  // difference between a guessed phone number and a conforming one.
  if (field.describedByText) compact.help = field.describedByText.slice(0, 160);

  // Surrounding copy is a weaker signal, worth the tokens only when the field is
  // otherwise poorly described.
  const poorlyDescribed = compact.label.length < 4 || (!!field.pattern && !compact.help);
  if (poorlyDescribed && field.surroundingText) {
    compact.hint = field.surroundingText.slice(0, 160);
  }

  return compact;
}

function encodeRunContext(context: RunContext | undefined): unknown {
  if (!context) return undefined;
  const hasIdentity = Object.keys(context.identity).length > 0;
  const hasSummaries = context.stepSummaries.length > 0;
  const sequenceMatch = /^v(\d+)-/.exec(context.variationSeed);
  const variationIndex = sequenceMatch ? Number(sequenceMatch[1]) : undefined;

  const persona: Record<string, string> = {};
  const otherFacts: Record<string, string> = {};
  for (const [key, value] of Object.entries(context.facts)) {
    if (key.startsWith("persona.")) persona[key.slice("persona.".length)] = value;
    else otherFacts[key] = value;
  }

  return {
    variationSeed: context.variationSeed,
    variationIndex,
    // Concrete person for this run. The model must reuse these identity fields.
    persona: Object.keys(persona).length > 0 ? persona : undefined,
    facts: Object.keys(otherFacts).length > 0 ? otherFacts : undefined,
    // Reusing these keeps "confirm email" style fields consistent across steps.
    alreadyUsed: hasIdentity ? context.identity : undefined,
    previousSteps: hasSummaries ? context.stepSummaries.slice(-6) : undefined,
  };
}

function buildUserPayload(snapshot: FillSnapshot): string {
  const eligible = snapshot.fields.filter((field) => isFillableField(field));

  const payload = {
    language: snapshot.fillLocale || snapshot.documentLocale,
    page: snapshot.pageTitle?.slice(0, 100) || undefined,
    step: snapshot.stepIndex,
    section: snapshot.chunkSection || undefined,
    context: encodeRunContext(snapshot.runContext),
    corrections:
      snapshot.validationErrors && snapshot.validationErrors.length > 0
        ? snapshot.validationErrors.slice(0, 12)
        : undefined,
    retryOnly: snapshot.retryOnly,
    fields: eligible.map(compactField),
  };

  return JSON.stringify(payload, (_key, value) =>
    value === undefined || value === null || value === "" ? undefined : value,
  );
}

function languageDirective(settings: ExtensionSettings, snapshot: FillSnapshot): string {
  const explicit = settings.fillLanguage === "override" && settings.fillLocaleOverride.trim();
  const target = explicit
    ? settings.fillLocaleOverride.trim()
    : snapshot.fillLocale || snapshot.documentLocale;

  const base = explicit
    ? `Write every generated value in ${target}, regardless of the page's own language.`
    : `Write values in the language of the form (${target}). Names, addresses and free text must look native to that language, not transliterated English.`;

  return `${base} A field carrying its own "lang" differs from the form default: follow the field's language for that field.`;
}

function systemPrompt(settings: ExtensionSettings, snapshot: FillSnapshot): string {
  const sections: string[] = [
    `You generate realistic test data for QA engineers filling web forms.`,
    `Reply with a minified JSON object mapping each field's "sid" to a string value. No markdown, no commentary.`,
    ``,
    `Rules:`,
    `- Respect required, type, maxLen, min and max.`,
    `- For type "date" answer YYYY-MM-DD. If help/placeholder uses slashes or a mask such as yyyy/mm/dd, match that format instead.`,
    `- For type "time" answer with a single clock time as HH:mm (24-hour). Never return a range such as "14:00-16:00"; pick one concrete time inside the requested window.`,
    `- For type "datetime-local" answer as YYYY-MM-DDTHH:mm.`,
    `- Always fill date fields. When two dates form a validity window, start = today or a recent date, end = a later date in the same run. A mask like yyyy/mm/dd is empty, not a value.`,
    `- "pattern" is a JavaScript regular expression the value must match in full. "help" is the field's own instruction text. When either states a format, follow it literally, including separators: for pattern "0\\d{2}-\\d{4}-\\d{4}" answer "090-1234-5678", not "+81 90 1234 5678".`,
    `- For telephone fields with "country", return a genuinely valid test number for that ISO country in international E.164 form (for example +12025550123 for US). Do not use fictional +1555 numbers; phone validation libraries reject many of them.`,
    `- For select, radio and combobox fields answer with one of the given options: either its value or its visible label, copied exactly.`,
    `- For checkbox and switch fields answer only "true" or "false". Omit the ones you leave unchecked.`,
    `- Fields sharing a "group" form one multi-select. Choose the combination a real user would pick; honour "maxSelections" when present.`,
    `- A field with "requiresChecked" only applies when that checkbox is set to true. Otherwise omit it.`,
    `- Never echo a field's placeholder or label back as its value.`,
    `- Data must be plausible but obviously synthetic, e.g. emails at example.com.`,
    `- RUN-TO-RUN DIVERSITY IS A PRIMARY TEST REQUIREMENT. For unconstrained values, dates, prose, occupations, organizations and preferences, derive a different result from context.variationIndex instead of repeatedly choosing your usual default.`,
    `- context.persona (and context.alreadyUsed) is the synthetic person for THIS run. Copy those values into matching fields (names, email, phone, address, DOB, username, website). Do not invent a different person.`,
    `- Do not fall back to stock demo names such as Julian, John Doe, Jane Doe, Alex Smith, or Elena Schulz unless context.persona literally contains them.`,
    `- Derive related values from that persona (work email from the name, security answer from the city, biography that matches). Vary employer, salary, certifications and technical preferences between runs.`,
    `- For select/radio choices, use context.variationIndex to rotate among plausible options instead of always choosing the first or most common option.`,
    `- For checkbox groups, vary both the selected combination and, when plausible, the number selected. Use option order plus context.variationIndex so adjacent runs do not receive the same set.`,
    `- Keep values internally consistent within this run; variation is between runs, not between fields that describe the same person.`,
    `- Reuse values from context.alreadyUsed when a field asks for the same information again.`,
    `- When "corrections" is present the page rejected your previous answer: read the message and return a value that satisfies it.`,
    `- Fill every required field, plus optional fields a real user would reasonably complete. Prefer a plausible value over leaving an optional field blank (e.g. best contact time).`,
    `- You may add a "_ctx" object of short facts about this form worth remembering for later steps.`,
    ``,
    languageDirective(settings, snapshot),
  ];

  const custom = settings.customRequest.trim();
  if (custom) {
    sections.push(
      ``,
      `USER RULES (highest priority, override anything above that conflicts):`,
      custom.slice(0, CUSTOM_REQUEST_LIMIT),
    );
  }

  return sections.join("\n");
}

/**
 * Output budget scaled to what the chunk actually needs; retried at smaller
 * sizes if the provider rejects the request as too large.
 */
function tokenBudgets(snapshot: FillSnapshot): number[] {
  const fields = snapshot.fields;
  const proseCount = fields.filter(
    (field) => field.kind === "textarea" || field.kind === "contenteditable",
  ).length;
  const booleanCount = fields.filter(
    (field) => field.kind === "checkbox" || field.kind === "aria-switch",
  ).length;

  if (booleanCount === fields.length && fields.length > 0) return [400, 300];
  if (proseCount >= 2) return [1600, 1100, 700];

  const estimate = 120 + fields.length * 70 + proseCount * 350;
  const primary = Math.min(2000, Math.max(400, estimate));
  return [primary, Math.round(primary * 0.7), 400];
}

function isGeminiThinkingModel(model: string): boolean {
  return /(?:^|\/)gemini-(?:2\.5|3(?:[.-]|$))/i.test(model);
}

/**
 * Gemini's max_tokens includes hidden thinking. Even at minimal reasoning it
 * needs headroom beyond the visible JSON, otherwise a 12-field response can be
 * cut after only a handful of values.
 */
function providerTokenBudgets(providerId: LlmProviderId, budgets: number[]): number[] {
  if (providerId !== "google") return budgets;
  const primary = Math.max(4096, budgets[0] + 2048);
  return [Math.min(8192, primary), 3072, 2048];
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

export interface FillOutcome {
  ok: boolean;
  values?: Record<string, string>;
  error?: string;
  httpCallsUsed?: number;
  promptChars?: number;
  completionChars?: number;
}

interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  retryAfterMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Providers often put the real delay in the JSON error body rather than the
 * Retry-After header (for example: "Please retry in 4.88s" or
 * {"retryDelay":"5s"}). Respect it instead of hammering the API after 400 ms.
 */
function retryDelayFromBody(body: string): number | undefined {
  const match =
    /(?:retry(?:\s+after|\s+in)?|try\s+again\s+in|retryDelay["']?\s*[:=])\s*["']?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?/i.exec(
      body,
    );
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const milliseconds = match[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
  // A small cushion avoids retrying on the exact edge of the provider window.
  return Math.min(120_000, Math.ceil(milliseconds) + 500);
}

function retryAfterHeaderMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const delay = date - Date.now();
  return delay > 0 ? delay : undefined;
}

function fallbackRetryDelayMs(attempt: number): number {
  // Attempts are zero-based: approximately 3–3.75s, then 7–7.75s.
  const base = attempt === 0 ? 3000 : 7000;
  return base + Math.random() * 750;
}

function isTransientStatus(status: number, body: string): boolean {
  return status === 429 || status >= 500 || /rate.?limit|temporarily|try again/i.test(body);
}

function isRateLimit(status: number, message: string): boolean {
  return status === 429 || /rate.?limit|too many request|quota/i.test(message);
}

/**
 * Keeps only keys that belong to the current chunk.
 *
 * Some small models occasionally mirror the payload shape (`language`, `page`,
 * `context`, `corrections`) instead of answering with sid -> value pairs. That
 * is valid JSON, so a plain parse treats it as success and wastes the round.
 * Requiring at least one requested sid turns that failure mode into a retry.
 */
function extractRequestedValues(
  values: Record<string, string>,
  requestedSids: Set<string>,
): { matched: Record<string, string>; answeredCount: number } {
  const matched: Record<string, string> = {};
  let answeredCount = 0;

  for (const [key, value] of Object.entries(values)) {
    if (key === "_ctx") {
      matched[key] = value;
      continue;
    }
    if (!requestedSids.has(key)) continue;
    matched[key] = value;
    answeredCount += 1;
  }

  return { matched, answeredCount };
}

/**
 * Runs one chunk against one provider, walking its model candidates and output
 * budgets. Throws with an aggregated message when every attempt fails.
 */
async function runProvider(
  providerId: LlmProviderId,
  settings: ExtensionSettings,
  apiKey: string,
  request: Omit<ChatRequest, "model" | "maxTokens">,
  budgets: number[],
  callBudget: { used: number; promptChars: number; completionChars: number },
  requestedSids: Set<string>,
): Promise<Record<string, string>> {
  const provider = PROVIDERS[providerId];
  const rawBase =
    settings.provider === providerId && settings.baseUrl.trim()
      ? settings.baseUrl
      : provider.defaultBaseUrl;
  if (!isAllowedBaseUrl(provider, rawBase)) {
    throw new Error(
      `${provider.label} base URL is not allowed (must stay on ${new URL(provider.defaultBaseUrl).origin}).`,
    );
  }
  const baseUrl = resolveProviderBaseUrl(provider, rawBase);

  const perform = async (model: string, maxTokens: number, userMessages: string[]): Promise<HttpResult> => {
    if (callBudget.used >= MAX_HTTP_CALLS_PER_FILL) {
      throw new Error(
        `Stopped after ${MAX_HTTP_CALLS_PER_FILL} provider requests for a single group (safety limit).`,
      );
    }
    callBudget.used += 1;

    const prepared = prepareRequest(provider, baseUrl, apiKey, {
      ...request,
      userMessages,
      model,
      maxTokens,
      reasoningEffort:
        providerId === "google" && isGeminiThinkingModel(model) ? "minimal" : undefined,
    });

    callBudget.promptChars += prepared.body.length + request.systemPrompt.length;

    const res = await fetch(prepared.url, {
      method: "POST",
      headers: prepared.headers,
      body: prepared.body,
    });
    const body = await res.text();
    callBudget.completionChars += body.length;

    const retryAfter =
      retryAfterHeaderMs(res.headers.get("retry-after")) ?? retryDelayFromBody(body);
    return {
      ok: res.ok,
      status: res.status,
      body,
      retryAfterMs: retryAfter,
    };
  };

  const runModel = async (model: string): Promise<Record<string, string>> => {
    let lastError = "";
    let strictRetryUsed = false;

    budgetLoop: for (const maxTokens of budgets) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
        const messages = [...request.userMessages];
        if (strictRetryUsed) {
          const sidList = Array.from(requestedSids).slice(0, 20).join(", ");
          messages.push(
            `Your previous reply was unusable. Reply with only a minified JSON object whose keys are the requested sid values only${sidList ? ` (${sidList})` : ""}. Do not repeat language, page, context, corrections or field metadata. No prose, no code fences.`,
          );
        }

        const result = await perform(model, maxTokens, messages);

        if (!result.ok) {
          const message = readProviderError(result.body);
          lastError = `HTTP ${result.status}: ${message}`;

          // Too-large requests are answered by dropping to the next budget tier.
          if (result.status === 400 && /max[_\s-]?tokens|context length|too many tokens/i.test(message)) {
            break;
          }

          if (result.status === 401 || result.status === 403) {
            throw new Error(
              `${provider.label} rejected the API key (${result.status}): ${message}. Check the key at ${provider.docsUrl}.`,
            );
          }

          if (isTransientStatus(result.status, result.body) && attempt < MAX_ATTEMPTS_PER_MODEL - 1) {
            await sleep(result.retryAfterMs ?? fallbackRetryDelayMs(attempt));
            continue;
          }
          break;
        }

        let reply;
        try {
          reply = readReply(provider, result.body);
        } catch {
          lastError = "Provider returned a body that was not JSON.";
          break;
        }

        if (!reply.content) {
          lastError =
            reply.finishReason === "length"
              ? "Model hit its output limit before producing JSON."
              : "Model returned an empty response.";
          if (attempt < MAX_ATTEMPTS_PER_MODEL - 1) {
            await sleep(250 * (attempt + 1));
            continue;
          }
          break;
        }

        if (reply.finishReason === "length") {
          lastError = `Model exhausted ${maxTokens} completion tokens before finishing its JSON.`;
          // One strict retry at the same (largest viable) budget may remove
          // unnecessary prose/context. A smaller budget cannot fix truncation.
          if (!strictRetryUsed) {
            strictRetryUsed = true;
            continue;
          }
          break budgetLoop;
        }

        try {
          const parsed = parseLlmValues(reply.content);
          const { matched, answeredCount } = extractRequestedValues(parsed, requestedSids);

          if (answeredCount === 0) {
            lastError =
              reply.finishReason === "length"
                ? "Model hit its output limit before answering any requested field ids."
                : "Model replied with JSON, but not with values for the requested field ids.";
            if (!strictRetryUsed) {
              strictRetryUsed = true;
              continue;
            }
            break;
          }

          return matched;
        } catch {
          if (!strictRetryUsed) {
            strictRetryUsed = true;
            lastError = "Model reply was not valid JSON; retrying with a stricter instruction.";
            continue;
          }
          lastError = "Model reply was not valid JSON.";
          break;
        }
      }
    }

    throw new Error(`[${model}] ${lastError || "unknown provider failure"}`);
  };

  const candidates = Array.from(
    new Set(
      [
        settings.provider === providerId ? settings.model : "",
        provider.defaultModel,
        ...provider.fallbackModels.map((option) => option.id),
      ].filter(Boolean),
    ),
  );

  const errors: string[] = [];
  for (const model of candidates) {
    try {
      return await runModel(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A bad key or an exhausted call budget will not improve on another model.
      if (/rejected the API key|safety limit/i.test(message)) throw error;
      errors.push(message);
      if (isRateLimit(0, message)) throw new Error(message);
    }
  }

  throw new Error(errors.join(" | ") || `${provider.label} produced no usable response.`);
}

/**
 * Requests values for one chunk.
 *
 * Only the selected provider is contacted, plus any the user explicitly listed
 * as fallbacks. The previous implementation looped over every configured
 * provider on failure, which sent scraped form contents to vendors the user had
 * not chosen.
 */
export async function callLlmForFill(
  snapshot: FillSnapshot,
  settings: ExtensionSettings,
  apiKeys: Partial<Record<LlmProviderId, string>>,
): Promise<FillOutcome> {
  const requestedSids = new Set(snapshot.fields.map((field) => field.syntheticId));
  const request: Omit<ChatRequest, "model" | "maxTokens"> = {
    systemPrompt: systemPrompt(settings, snapshot),
    userMessages: [buildUserPayload(snapshot)],
    // The per-run seed provides explicit variation; a moderate temperature
    // prevents deterministic models from ignoring it while remaining reliable.
    temperature: 0.45,
    jsonMode: true,
  };

  const budgets = tokenBudgets(snapshot);
  const callBudget = { used: 0, promptChars: 0, completionChars: 0 };

  const order = [settings.provider, ...settings.fallbackProviders].filter(
    (id, index, all) => all.indexOf(id) === index,
  );

  const errors: string[] = [];

  for (const providerId of order) {
    const apiKey = (apiKeys[providerId] ?? "").trim();
    if (!apiKey) {
      errors.push(`[${PROVIDERS[providerId].label}] no API key saved.`);
      continue;
    }

    try {
      const budgetsForProvider = providerTokenBudgets(providerId, budgets);
      const values = await runProvider(
        providerId,
        settings,
        apiKey,
        request,
        budgetsForProvider,
        callBudget,
        requestedSids,
      );
      return {
        ok: true,
        values,
        httpCallsUsed: callBudget.used,
        promptChars: callBudget.promptChars,
        completionChars: callBudget.completionChars,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`[${PROVIDERS[providerId].label}] ${message}`);
      if (/safety limit/i.test(message)) break;
    }
  }

  return {
    ok: false,
    error: errors.join("\n") || "No provider was able to answer.",
    httpCallsUsed: callBudget.used,
    promptChars: callBudget.promptChars,
    completionChars: callBudget.completionChars,
  };
}

// ---------------------------------------------------------------------------
// Key test
// ---------------------------------------------------------------------------

export async function testProviderKey(
  providerId: LlmProviderId,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const provider = PROVIDERS[providerId];
  const rawBase = baseUrl.trim() || provider.defaultBaseUrl;
  if (!isAllowedBaseUrl(provider, rawBase)) {
    return {
      ok: false,
      error: `Base URL must stay on ${new URL(provider.defaultBaseUrl).origin}.`,
    };
  }
  const safeBase = resolveProviderBaseUrl(provider, rawBase);

  try {
    const prepared = prepareRequest(provider, safeBase, apiKey, {
      systemPrompt: "Reply with {}",
      userMessages: ["{}"],
      model: model || provider.defaultModel,
      maxTokens: 4,
      temperature: 0,
      jsonMode: false,
    });

    const res = await fetch(prepared.url, {
      method: "POST",
      headers: prepared.headers,
      body: prepared.body,
    });

    if (res.status === 401) {
      const message = readProviderError(await res.text());
      return { ok: false, error: `Invalid API key (401): ${message}` };
    }
    if (res.status === 403) {
      const message = readProviderError(await res.text());
      return {
        ok: false,
        error: `Key accepted but access denied (403): ${message}. This usually means no credits or the model is not enabled.`,
      };
    }

    // 200, 400 (bad params) and 429 (rate limited) all prove the key authenticates.
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function navigationSystemPrompt(settings: ExtensionSettings): string {
  const base = `You choose which control advances a multi-step web form.
Reply with only minified JSON:
{"isMultiStep":boolean,"shouldAdvanceAfterFill":boolean,"nextControlSid":"id-or-empty","isFinalSubmit":boolean,"confidence":number}
Pick the single best forward / next / continue control, judging by its label in any language and its position in the form.
Never pick back, previous, cancel, reset or clear controls.
Never pick "go to", "edit", "change section", breadcrumb, stepper or review-jump controls such as "Aller a Livraison" or "Edit billing".
Prefer the control inside the active form that advances to the next step (Next / Continue / Suivant).
Treat payment, order, apply and final-submit controls as final: only choose one when allowFinalSubmit is true. Labels like "Submit Application", "Submit", "Apply now" or "Place order" are final, not next-step.
Never choose a final submit when allowFinalSubmit is false; return nextControlSid as empty instead.
Set confidence to how certain you are, from 0 to 1.`;

  const custom = settings.customRequest.trim();
  if (!custom) return base;
  return `${base}\n\nUSER RULES (highest priority):\n${custom.slice(0, CUSTOM_REQUEST_LIMIT)}`;
}

function buildNavigationPayload(snapshot: NavigationSnapshot, allowFinalSubmit: boolean): string {
  return JSON.stringify({
    page: snapshot.pageTitle?.slice(0, 100),
    url: snapshot.pageUrl,
    visibleFields: snapshot.visibleFillableFieldCount,
    unresolvedRequired: snapshot.unresolvedRequiredCount,
    multiStepHints: snapshot.multiStepHints,
    allowFinalSubmit,
    controls: snapshot.controls.map((control) => ({
      sid: control.sid,
      tag: control.tag,
      type: control.inputType,
      label: control.labelText,
      aria: control.ariaLabel,
      role: control.role,
      inForm: control.inActiveForm,
      isSubmit: control.isSubmit,
      pos: control.position,
      markers: control.markerScore,
    })),
  });
}

export async function callLlmForNavigation(
  snapshot: NavigationSnapshot,
  allowFinalSubmit: boolean,
  settings: ExtensionSettings,
  apiKeys: Partial<Record<LlmProviderId, string>>,
): Promise<
  | {
      ok: true;
      decision: ReturnType<typeof parseNavigationDecision>;
      httpCallsUsed: number;
      promptChars: number;
      completionChars: number;
    }
  | { ok: false; error: string; httpCallsUsed?: number; promptChars?: number; completionChars?: number }
> {
  const providerId = settings.provider;
  const provider = PROVIDERS[providerId];
  const apiKey = (apiKeys[providerId] ?? "").trim();
  if (!apiKey) return { ok: false, error: "No API key saved for the selected provider." };

  const rawBase = settings.baseUrl.trim() || provider.defaultBaseUrl;
  if (!isAllowedBaseUrl(provider, rawBase)) {
    return {
      ok: false,
      error: `Base URL must stay on ${new URL(provider.defaultBaseUrl).origin}.`,
    };
  }

  const systemPromptText = navigationSystemPrompt(settings);
  const userPayload = buildNavigationPayload(snapshot, allowFinalSubmit);
  const prepared = prepareRequest(
    provider,
    resolveProviderBaseUrl(provider, rawBase),
    apiKey,
    {
      systemPrompt: systemPromptText,
      userMessages: [userPayload],
      model: settings.model || provider.defaultModel,
      maxTokens: 260,
      temperature: 0,
      jsonMode: true,
    },
  );

  const promptChars = prepared.body.length + systemPromptText.length;

  try {
    const res = await fetch(prepared.url, {
      method: "POST",
      headers: prepared.headers,
      body: prepared.body,
    });
    const body = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: readProviderError(body),
        httpCallsUsed: 1,
        promptChars,
        completionChars: body.length,
      };
    }

    const reply = readReply(provider, body);
    if (!reply.content) {
      return {
        ok: false,
        error: "Empty navigation response.",
        httpCallsUsed: 1,
        promptChars,
        completionChars: body.length,
      };
    }
    return {
      ok: true,
      decision: parseNavigationDecision(reply.content),
      httpCallsUsed: 1,
      promptChars,
      completionChars: body.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      httpCallsUsed: 1,
      promptChars,
    };
  }
}
