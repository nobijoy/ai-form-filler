import { normalizeApiKey } from "./storage";
import { parseLlmValues } from "../shared/llmResponseSchema";
import { PROVIDERS } from "../shared/providers";
import type { ExtensionSettings, FillSnapshot, LlmProviderId, OpenRouterModelOption } from "../shared/types";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const APP_URL = "https://nobijoy.vercel.app/";
const APP_TITLE = "AI Form Filler Extension";
const MAX_HTTP_CALLS_PER_LLM_FILL = 12;

interface OpenRouterModelRecord {
  id?: string;
  name?: string;
  context_length?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[];
}

function formatContextLabel(contextLength: number): string {
  if (!Number.isFinite(contextLength) || contextLength <= 0) return "unknown context";
  if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}k context`;
  return `${contextLength} context`;
}

function isFreePricing(m: OpenRouterModelRecord): boolean {
  const p = m.pricing?.prompt;
  const c = m.pricing?.completion;
  const free = (v: unknown) => v === "0" || v === 0;
  return free(p) && free(c);
}

function mapToModelOption(model: OpenRouterModelRecord): OpenRouterModelOption | null {
  if (!model.id) return null;
  const contextLength = Number.isFinite(model.context_length ?? NaN)
    ? Number(model.context_length)
    : 0;
  const name = (model.name?.trim() || model.id).trim();
  return {
    id: model.id,
    name,
    contextLength,
    label: `${name} - ${formatContextLabel(contextLength)}`,
  };
}

function fallbackModelsWithDefault(provider: LlmProviderId): OpenRouterModelOption[] {
  return PROVIDERS[provider].fallbackModels;
}

export async function getProviderModels(
  provider: LlmProviderId,
  apiKey?: string,
): Promise<{
  models: OpenRouterModelOption[];
  fromFallback: boolean;
}> {
  if (provider !== "openrouter") {
    return { models: fallbackModelsWithDefault(provider), fromFallback: false };
  }
  try {
    const headers: Record<string, string> = {};
    const k = apiKey ? normalizeApiKey(apiKey) : "";
    if (k) headers.Authorization = `Bearer ${k}`;
    const res = await fetch(OPENROUTER_MODELS_URL, { method: "GET", headers });
    if (!res.ok) throw new Error(`Model list request failed: ${res.status}`);
    const payload = (await res.json()) as OpenRouterModelsResponse;
    if (!payload.data || !Array.isArray(payload.data)) throw new Error("Invalid models payload");

    const freeModels = payload.data
      .filter((m) => isFreePricing(m))
      .map(mapToModelOption)
      .filter((m): m is OpenRouterModelOption => !!m)
      .sort((a, b) => b.contextLength - a.contextLength);

    const unique = new Map<string, OpenRouterModelOption>();
    for (const m of freeModels) unique.set(m.id, m);
    const deduped = Array.from(unique.values());
    return { models: [PROVIDERS.openrouter.fallbackModels[0], ...deduped], fromFallback: false };
  } catch {
    return { models: fallbackModelsWithDefault(provider), fromFallback: true };
  }
}

/** max 1 — mutually exclusive (kept in sync with fillOrchestrator.ts CBG_EXCLUSIVE_TITLE) */
const EXCLUSIVE_BY_TITLE =
  /性別|国籍|外国籍|雇用形態|就業形態|勤務スタイル|不採用条件/i;
/** max 1 — detected from label content when group is small */
const EXCLUSIVE_GROUP_PATTERN =
  /gender|性別|male|female|男性|女性|問わず|불문|yes.{0,5}no|はい.{0,5}いいえ|あり.{0,5}なし|有.{0,5}無/i;
/** max 2 — age bands, welfare items, appeal points */
const TWO_MAX_BY_TITLE = /年代|年齢層|福利厚生|アピールポイント/i;
/** max 3 — small-selection groups */
const SMALL_MAX_BY_TITLE =
  /給与.*補足|選考フロー|職場環境|フロー|PRポイント|アピール|勤務形態|就業形態|働き方|応募条件|採用条件/i;
/** max 4 — insurance options */
const INSURANCE_TITLE = /保険|insurance/i;
/** max 3 — holiday / leave types */
const HOLIDAY_TITLE = /休日|holiday|休暇/i;

function inferCbgMax(labels: string[], groupTitle = ""): number {
  const combined = [groupTitle, ...labels].join(" ");

  if (EXCLUSIVE_BY_TITLE.test(groupTitle)) return 1;
  if (labels.length <= 4 && EXCLUSIVE_GROUP_PATTERN.test(combined)) return 1;

  if (TWO_MAX_BY_TITLE.test(groupTitle)) return Math.min(labels.length, 2);
  if (INSURANCE_TITLE.test(groupTitle)) return Math.min(labels.length, 4);
  if (HOLIDAY_TITLE.test(groupTitle)) return Math.min(labels.length, 3);
  if (SMALL_MAX_BY_TITLE.test(groupTitle)) return Math.min(labels.length, 3);

  return labels.length;
}

function inferCbgTitle(labels: string[]): string {
  if (labels.length === 0) return "";
  let prefix = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i] === l[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const trimmed = prefix.trim().replace(/[：:・\-_/\\]+$/, "").trim();
  return trimmed.length >= 2 ? trimmed : "";
}

function groupCheckboxFields(
  fields: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let buf: Array<Record<string, unknown>> = [];
  let currentGrp: unknown = Symbol(); // unique sentinel so first item always starts fresh

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      const { grp: _g, ...rest } = buf[0] as Record<string, unknown>;
      out.push(rest);
    } else {
      const groupTitle = String(buf[0].grp ?? "");
      const labels = buf.map((f) => String(f.l ?? ""));
      const title = groupTitle || inferCbgTitle(labels);
      const max = inferCbgMax(labels, groupTitle);
      out.push({
        type: "cbg",
        title,
        mode: buf.some((f) => !!f.req) ? "required" : "optional",
        max,
        items: buf.map((f) => [f.sid, f.l]),
      });
    }
    buf = [];
  };

  for (const f of fields) {
    if (f.type === "checkbox") {
      const fGrp = f.grp;
      // Flush buffer when the logical group changes (different formPurpose)
      if (buf.length > 0 && fGrp !== currentGrp) {
        flush();
      }
      currentGrp = fGrp;
      buf.push(f);
    } else {
      flush();
      currentGrp = Symbol(); // reset sentinel for next checkbox run
      out.push(f);
    }
  }
  flush();
  return out;
}

function buildUserPayload(snapshot: FillSnapshot, personaNote: string): string {
  // Exclude hidden inputs — they hold server tokens and must never reach the LLM
  const eligibleFields = snapshot.fields.filter((f) => f.inputType !== "hidden");

  const rawCompact = eligibleFields.map((f) => {
    const base = { sid: f.syntheticId, req: !!f.required || undefined };

    if (f.inputType === "checkbox") {
      return {
        ...base,
        type: "checkbox",
        l: (f.labelText ?? "").slice(0, 80),
        // grp drives group-boundary detection and per-group max inference
        grp: f.formPurpose?.slice(0, 60).trim() || undefined,
      };
    }

    if (f.inputType === "radio") {
      return {
        ...base,
        type: "radio",
        l: (f.labelText ?? "").slice(0, 80),
        o: f.radioChoices?.map((o) => o.value).filter((v) => v !== "").slice(0, 20),
      };
    }

    return {
      ...base,
      type: f.inputType,
      l: (f.labelText ?? f.ariaLabel ?? "").slice(0, 120),
      ph: f.placeholder?.slice(0, 60) || undefined,
      o: f.options?.map((o) => o.value).filter((v) => v !== "").slice(0, 40),
      maxLen: f.maxLength || undefined,
      pat: f.pattern || undefined,
    };
  });

  // Group consecutive checkboxes into cbg entries
  const groupedFields = groupCheckboxFields(rawCompact as Array<Record<string, unknown>>);

  const payload: Record<string, unknown> = {
    locale: snapshot.fillLocale || snapshot.documentLocale,
    form: snapshot.pageTitle?.slice(0, 80) || undefined,
    section: snapshot.chunkSection || undefined,
    ctx: snapshot.chunkCtx && Object.keys(snapshot.chunkCtx).length > 0
      ? snapshot.chunkCtx
      : undefined,
    persona: personaNote || undefined,
    fields: groupedFields,
  };

  // Strip null/undefined/empty-string values from serialized output
  return JSON.stringify(
    payload,
    (_, v) => (v === undefined || v === null || v === "" ? undefined : v),
    0,
  );
}

function systemPrompt(_settings: ExtensionSettings): string {
  return `You fill QA test forms with realistic fake data.
Return only minified valid JSON: field id -> string value.
Use the locale, section, ctx, and field labels to understand what values are appropriate.
Respect required, type, pattern, maxLen, and exact select/radio option values.
For cbg checkbox groups: return only selected ids as "true"; omit unchecked ids entirely; respect each group's max; select only one for mutually exclusive groups (gender, yes/no, あり/なし, 男性/女性/問わず).
Never return non-boolean values for checkbox fields.
Fill required empty fields and obvious optional identity/contact/profile fields.
Do not fill every optional checkbox.
You may include a small _ctx object with key facts discovered in this chunk (e.g. jobCategory, employmentType, location, workStyle, salaryType, companySummary, candidateProfile).
Use realistic but obviously fake test data (e.g. emails like test.user+tag@example.com).
Return values matching the locale and field labels.
No markdown. No commentary.`;
}

function extractProviderError(raw: string): { code?: number; message?: string; raw?: string } | null {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; message?: string; metadata?: { raw?: string } } | string;
      code?: string;
    };
    if (!parsed.error && !parsed.code) return null;
    // xAI flat format: { error: "string message", code: "description" }
    if (typeof parsed.error === "string") {
      return { message: parsed.error };
    }
    const error = parsed.error;
    if (!error || typeof error !== "object") return null;
    return {
      code: typeof error.code === "number" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
      raw: typeof error.metadata?.raw === "string" ? error.metadata.raw : undefined,
    };
  } catch {
    return null;
  }
}

export async function testProviderKey(
  provider: LlmProviderId,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${normalizeApiKey(apiKey)}`,
    };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = APP_URL;
      headers["X-Title"] = APP_TITLE;
    }
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user" as const, content: "Hi" }],
        max_tokens: 1,
      }),
    });
    if (res.status === 401) {
      let msg = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } | string };
        msg = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
      } catch { /* ignore */ }
      return { ok: false, error: `Invalid API key (401)${msg ? ": " + msg : ""}` };
    }
    if (res.status === 403) {
      let msg = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } | string; code?: string };
        msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.code ?? "");
      } catch { /* ignore */ }
      // 403 = key is valid but no credits/permission — flag as billing issue, not bad key
      return {
        ok: false,
        error: `No credits or access (403)${msg ? ": " + msg : ""}. Purchase credits to use this provider.`,
      };
    }
    // Any other response (200, 400 bad params, 429 rate-limit) means the key itself is valid.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function computeTokenBudgets(snapshot: FillSnapshot): number[] {
  const section = snapshot.chunkSection;
  const fields = snapshot.fields;

  if (section === "retry") return [400, 300];

  const checkboxCount = fields.filter((f) => f.inputType === "checkbox").length;
  const textareaCount = fields.filter((f) => f.tag === "textarea").length;

  // Pure checkbox chunk — responses are just a few "true" values
  if (checkboxCount === fields.length) return [300, 250];

  // Textarea-heavy chunks need more tokens for generated text
  if (textareaCount >= 2) return [900, 700, 500];

  if (section === "basic_info") return [600, 450, 300];

  // Default: mixed text/select chunks
  return [700, 500, 350];
}

export async function callLlmForFill(
  snapshot: FillSnapshot,
  settings: ExtensionSettings,
  apiKeys: Partial<Record<LlmProviderId, string>>,
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }> {
  const personaNote =
    settings.personaJson.trim().length > 0
      ? `User persona JSON (use for names/emails when consistent): ${settings.personaJson.slice(0, 2000)}`
      : "";

  const bodyBase = {
    temperature: 0.1,
    top_p: 0.2,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: systemPrompt(settings) },
      {
        role: "user" as const,
        content: buildUserPayload(snapshot, personaNote),
      },
    ],
  };

  const sleep = async (ms: number): Promise<void> =>
    await new Promise((resolve) => setTimeout(resolve, ms));
  let httpCallsUsed = 0;

  const providerOrder = Array.from(
    new Set<LlmProviderId>([
      settings.provider,
      "openrouter",
      "groq",
      "google",
      "cerebras",
    ]),
  );

  const runProvider = async (
    provider: LlmProviderId,
    extraUserHint?: string,
  ): Promise<Record<string, string>> => {
    const key = normalizeApiKey(apiKeys[provider] ?? "");
    if (!key) {
      throw new Error(`No ${PROVIDERS[provider].label} API key configured.`);
    }
    console.debug("[AI Form Filler] provider auth resolved", {
      provider,
      keyLength: key.length,
      keyPrefix: key.slice(0, 4),
    });
    const base =
      settings.provider === provider
        ? settings.baseUrl.replace(/\/$/, "")
        : PROVIDERS[provider].defaultBaseUrl;
    const url = `${base}/chat/completions`;
    const baseMessages = [...bodyBase.messages];
    if (extraUserHint) {
      baseMessages.push({ role: "user" as const, content: extraUserHint });
    }
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
    if (provider === "openrouter") {
      baseHeaders["HTTP-Referer"] = APP_URL;
      baseHeaders["X-Title"] = APP_TITLE;
    }

    const perform = async (
      model: string,
      maxTokens: number,
      payloadMessages: typeof baseMessages,
    ): Promise<{
      ok: boolean;
      status: number;
      text: string;
      retryAfterMs?: number;
      data?: {
        choices?: {
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning?: string | null };
        }[];
      };
    }> => {
      if (httpCallsUsed >= MAX_HTTP_CALLS_PER_LLM_FILL) {
        throw new Error(
          `Stopped after ${MAX_HTTP_CALLS_PER_LLM_FILL} provider requests in a single fill attempt (safety limit).`,
        );
      }
      httpCallsUsed += 1;
      console.debug("[AI Form Filler] outbound provider request", {
        used: httpCallsUsed,
        budget: MAX_HTTP_CALLS_PER_LLM_FILL,
        model,
        maxTokens,
      });
      const providerBody: Record<string, unknown> = {
        ...bodyBase,
        model,
        max_tokens: maxTokens,
        messages: payloadMessages,
      };
      // include_reasoning is OpenRouter-specific; other providers reject it with 400
      if (provider === "openrouter") providerBody.include_reasoning = false;
      const res = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(providerBody),
      });
      const text = await res.text();
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSec = Number(retryAfterHeader);
      const retryAfterMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.floor(retryAfterSec * 1000) : undefined;
      if (!res.ok) return { ok: false, status: res.status, text, retryAfterMs };
      const data = JSON.parse(text) as {
        choices?: {
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning?: string | null };
        }[];
      };
      return { ok: true, status: res.status, text, data, retryAfterMs };
    };

    const isTransient = (status: number, text: string): boolean =>
      status === 429 || status >= 500 || /rate-limit|temporarily rate-limited|retry/i.test(text);

    const tokenBudgets = computeTokenBudgets(snapshot);
    const runForModel = async (model: string): Promise<Record<string, string>> => {
      let lastErr = "";
      let jsonParseRetried = false;
      for (const maxTokens of tokenBudgets) {
        for (let i = 0; i < 3; i++) {
          console.debug("[AI Form Filler] LLM attempt", { model, maxTokens, tryIndex: i + 1 });
          let result = await perform(model, maxTokens, baseMessages);

          const needsNoSystemFallback =
            !result.ok &&
            result.status === 400 &&
            /Developer instruction is not enabled/i.test(result.text);

          if (needsNoSystemFallback) {
            const compactUserPrompt = [
              "You are a QA form test-data assistant.",
              "Return ONLY valid minified JSON object: field id -> string.",
              "Follow field constraints, use exact select/radio/cbg option values.",
              "No markdown. No commentary.",
              buildUserPayload(snapshot, personaNote),
              extraUserHint || "",
            ]
              .filter(Boolean)
              .join("\n\n");
            result = await perform(model, maxTokens, [
              { role: "user" as const, content: compactUserPrompt },
            ]);
          }

          // 400 context/token limit: reduce max_tokens by moving to next tier
          const maxTokensRejected =
            !result.ok &&
            result.status === 400 &&
            /(max[_\s-]?tokens|context length|too many tokens|token limit)/i.test(result.text);
          if (maxTokensRejected) {
            lastErr = `API ${result.status}: ${result.text.slice(0, 500)}`;
            break; // try next tokenBudget tier
          }

          if (!result.ok) {
            const providerErr = extractProviderError(result.text);
            const providerMsg = providerErr?.raw || providerErr?.message || result.text;
            const isRateLimit =
              result.status === 429 ||
              providerErr?.code === 429 ||
              /rate.?limit|too many request/i.test(providerMsg);
            const authHint =
              result.status === 401 ||
              /missing authentication|invalid api key|unauthorized/i.test(providerMsg)
                ? ` Ensure the ${PROVIDERS[provider].label} API key is set in the extension popup (${PROVIDERS[provider].docsUrl}).`
                : "";
            lastErr = `API ${result.status}: ${providerMsg.slice(0, 500)}${authHint}`;

            if (isRateLimit) {
              // Rate limits are transient — back off generously but do NOT count toward model failure
              const backoff =
                result.retryAfterMs ?? 600 * (i + 1) + Math.floor(Math.random() * 400);
              console.warn("[AI Form Filler] rate limit — backing off", {
                model,
                status: result.status,
                backoffMs: backoff,
              });
              await sleep(backoff);
              // Keep retrying within the same model/tier; if all attempts exhausted the
              // error message will contain "429" which the orchestrator detects as rate-limit
              if (i < 2) continue;
              break;
            }

            if (i < 2 && isTransient(result.status, result.text)) {
              const backoff =
                result.retryAfterMs ?? 300 * (i + 1) + Math.floor(Math.random() * 200);
              console.warn("[AI Form Filler] transient provider error, backing off", {
                model,
                status: result.status,
                backoffMs: backoff,
              });
              await sleep(backoff);
              continue;
            }
            // Non-transient error: stop trying this model
            break;
          }

          const data = result.data;
          if (!data) {
            lastErr = "Empty API response";
            if (i < 2) {
              await sleep(250 * (i + 1));
              continue;
            }
            break;
          }
          const first = data.choices?.[0];
          const content = first?.message?.content;
          if (!content && first?.finish_reason === "length") {
            lastErr = "Model exhausted output budget before JSON content.";
            if (i < 2) {
              await sleep(250 * (i + 1));
              continue;
            }
            break;
          }
          if (!content) {
            lastErr = "Empty model response";
            console.warn("[AI Form Filler] empty content from provider", {
              model,
              finishReason: first?.finish_reason ?? null,
              textSnippet: result.text.slice(0, 180),
            });
            if (i < 2) {
              await sleep(250 * (i + 1));
              continue;
            }
            break;
          }

          // Attempt JSON parse; on first failure retry once with a strict JSON-only message
          try {
            return parseLlmValues(content);
          } catch {
            if (!jsonParseRetried && i < 2) {
              jsonParseRetried = true;
              lastErr = "Invalid JSON in model response — retrying with strict prompt";
              console.warn("[AI Form Filler] JSON parse failure, retrying strictly", {
                model,
                snippet: content.slice(0, 120),
              });
              // Replace last user message with strict JSON demand for the next attempt
              const strictMessages = [
                ...baseMessages,
                {
                  role: "user" as const,
                  content:
                    "Your last response was not valid JSON. Return ONLY a minified JSON object with no markdown, no commentary, no code fences.",
                },
              ];
              const retryResult = await perform(model, maxTokens, strictMessages);
              if (retryResult.ok) {
                const retryContent = retryResult.data?.choices?.[0]?.message?.content;
                if (retryContent) {
                  try {
                    return parseLlmValues(retryContent);
                  } catch {
                    lastErr = "JSON parse failed even after strict retry";
                  }
                }
              }
              break;
            }
            lastErr = "Invalid JSON in model response";
            break;
          }
        }
      }
      throw new Error(`[model=${model}] ${lastErr || "unknown provider failure"}`);
    };

    const fallbackIds = PROVIDERS[provider].fallbackModels.map((m) => m.id);
    const modelCandidates = Array.from(
      new Set([settings.model, PROVIDERS[provider].defaultModel, ...fallbackIds].filter(Boolean)),
    );
    const errs: string[] = [];
    for (const m of modelCandidates) {
      try {
        return await runForModel(m);
      } catch (e) {
        errs.push(e instanceof Error ? e.message : String(e));
      }
    }
    throw new Error(errs.join(" | "));
  };

  try {
    const allErrs: string[] = [];
    for (const provider of providerOrder) {
      try {
        const values = await runProvider(provider);
        return { ok: true, values };
      } catch (e1) {
        const msg = e1 instanceof Error ? e1.message : String(e1);
        try {
          const values = await runProvider(
            provider,
            `Your previous output failed validation/parsing. Return ONLY the final minified JSON object immediately, with no reasoning, no preface, no markdown. Error: ${msg.slice(0, 400)}`,
          );
          return { ok: true, values };
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          allErrs.push(`[${provider}] ${msg2}`);
        }
      }
    }
    return { ok: false, error: allErrs.join(" | ") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
