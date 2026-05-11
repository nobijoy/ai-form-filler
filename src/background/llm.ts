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

function groupCheckboxFields(
  fields: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let buf: Array<Record<string, unknown>> = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push(buf[0]);
    } else {
      out.push({
        type: "cb_group",
        req: buf.some((f) => !!f.req),
        items: buf.map(({ sid, l, val }) => ({ sid, l, val })),
      });
    }
    buf = [];
  };

  for (const f of fields) {
    if (f.type === "checkbox") {
      buf.push(f);
    } else {
      flush();
      out.push(f);
    }
  }
  flush();
  return out;
}

function buildUserPayload(snapshot: FillSnapshot, personaNote: string): string {
  // Strategy 0: exclude hidden inputs — they hold server tokens and must never reach the LLM
  const eligibleFields = snapshot.fields.filter((f) => f.inputType !== "hidden");

  // Strategies 2 + 3: abbreviated keys and type-aware pruning
  const rawCompact = eligibleFields.map((f) => {
    const base = { sid: f.syntheticId, tag: f.tag, req: !!f.required, val: f.currentValue };

    if (f.inputType === "checkbox") {
      return { ...base, type: "checkbox", l: (f.labelText ?? "").slice(0, 80) };
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
      fp: f.formPurpose?.slice(0, 80),
      st: f.surroundingText?.slice(0, 100),
      ph: f.placeholder?.slice(0, 80),
      o: f.options?.map((o) => o.value).filter((v) => v !== "").slice(0, 40),
      maxLen: f.maxLength,
      pat: f.pattern,
    };
  });

  // Strategy 1: hoist form_purpose when all textual fields share the same value
  const textualFields = rawCompact.filter((f) => f.type !== "checkbox" && f.type !== "radio");
  const firstFp = textualFields.length > 0 ? (textualFields[0] as { fp?: string }).fp : undefined;
  const sharedFp =
    firstFp && textualFields.every((f) => (f as { fp?: string }).fp === firstFp)
      ? firstFp
      : undefined;

  const dedupedCompact = sharedFp
    ? rawCompact.map((f) => {
        if (f.type !== "checkbox" && f.type !== "radio") {
          const { fp: _fp, ...rest } = f as Record<string, unknown>;
          return rest;
        }
        return f;
      })
    : rawCompact;

  // Strategy 2b: group consecutive checkboxes into cb_group entries
  const groupedFields = groupCheckboxFields(dedupedCompact as Array<Record<string, unknown>>);

  const payload = {
    task: "Return ONLY a JSON object: syntheticId -> string value for fields that should be filled now.",
    html_lang: snapshot.documentLocale,
    fillLocale: snapshot.fillLocale,
    roundIndex: snapshot.roundIndex,
    maxRounds: snapshot.maxRounds,
    pageTitle: snapshot.pageTitle,
    pageUrl: snapshot.pageUrl,
    page_ctx: sharedFp,
    persona: personaNote || undefined,
    heuristicFilled: snapshot.heuristicSummary?.map((h) => h.syntheticId) ?? [],
    fields: groupedFields,
  };

  // Strategy 4: strip null/undefined/empty-string values from serialized output
  return JSON.stringify(
    payload,
    (_, v) => (v === undefined || v === null || v === "" ? undefined : v),
    0,
  );
}

function systemPrompt(_settings: ExtensionSettings): string {
  return `You are a test-data assistant for QA form filling. Match the form language implied by html_lang, fillLocale, and field labels (any human language).
Field key legend: sid=field id, l=label, st=surrounding text, fp=form purpose, o=options, ph=placeholder, req=required, val=current value, page_ctx=shared form section for all fields.
Rules:
- Output ONLY valid minified JSON: an object whose keys are syntheticId strings and values are strings.
- Respect input type, pattern, maxLen, req, and select/radio option values (exact value strings).
- Use the provided l, fp or page_ctx, st, and html_lang as the main context signals.
- For checkboxes, use "true" or "false". cb_group contains grouped checkboxes — return sid->"true"/"false" for each item inside it.
- Use realistic but obviously fake test data (e.g. emails like test.user+tag@example.com).
- Prefer minimal churn: if current value is already present/satisfied, omit that field.
- Fill all required empty fields.
- For optional fields, fill only high-confidence fields (identity/contact, obvious profile fields, clear driver fields). Do not blanket-fill every optional checkbox.
- For conditional forms, prioritize driver fields (country, product type, yes/no toggles) when multiple empties exist.
- Return values in the detected html_lang / page locale, including script, names, and formatting.
- Never include markdown, never wrap in code fences, never include commentary.`;
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

    const tokenBudgets = [2000, 1500, 1000];
    const runForModel = async (model: string): Promise<Record<string, string>> => {
      let lastErr = "";
      let consecutiveRateLimits = 0;
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
            "Return ONLY valid minified JSON object: syntheticId -> string.",
            "Follow field constraints, use exact select/radio option values, and use html_lang/fillLocale.",
            "Do not include commentary.",
            buildUserPayload(snapshot, personaNote),
            extraUserHint || "",
          ]
            .filter(Boolean)
            .join("\n\n");
            result = await perform(model, maxTokens, [
              { role: "user" as const, content: compactUserPrompt },
            ]);
        }

          const maxTokensRejected =
            !result.ok &&
            result.status === 400 &&
            /(max[_\s-]?tokens|context length|too many tokens|token limit)/i.test(result.text);
          if (maxTokensRejected) {
            lastErr = `API ${result.status}: ${result.text.slice(0, 500)}`;
            break;
          }

          if (!result.ok) {
            const providerErr = extractProviderError(result.text);
            const providerMsg = providerErr?.raw || providerErr?.message || result.text;
            const authHint =
              result.status === 401 ||
              /missing authentication|invalid api key|unauthorized/i.test(providerMsg)
                ? ` Ensure the ${PROVIDERS[provider].label} API key is set in the extension popup (${PROVIDERS[provider].docsUrl}).`
                : "";
            lastErr = `API ${result.status}: ${providerMsg.slice(0, 500)}${authHint}`;
            if (result.status === 429 || providerErr?.code === 429) {
              consecutiveRateLimits += 1;
              if (consecutiveRateLimits >= 2) {
                throw new Error(`[model=${model}] upstream rate-limited repeatedly; switching model`);
              }
            } else {
              consecutiveRateLimits = 0;
            }
            if (i < 2 && isTransient(result.status, result.text)) {
              const backoff = result.retryAfterMs ?? 300 * (i + 1) + Math.floor(Math.random() * 200);
              console.warn("[AI Form Filler] transient provider error, backing off", {
                model,
                status: result.status,
                backoffMs: backoff,
              });
              await sleep(backoff);
              continue;
            }
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
          return parseLlmValues(content);
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
