import { parseLlmValues } from "../shared/llmResponseSchema";
import type { ExtensionSettings, FillSnapshot, OpenRouterModelOption } from "../shared/types";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const APP_URL = "https://nobijoy.vercel.app/";
const APP_TITLE = "AI Form Filler Extension";
const FREE_AUTO_ROUTER: OpenRouterModelOption = {
  id: "openrouter/free",
  name: "Auto-Router (Free)",
  contextLength: 0,
  label: "Auto-Router (Free)",
};

const FALLBACK_FREE_MODELS: OpenRouterModelOption[] = [
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
  {
    id: "google/gemma-3-12b-it:free",
    name: "Gemma 3 12B IT (Free)",
    contextLength: 131072,
    label: "Gemma 3 12B IT (Free) - 131k context",
    isFallback: true,
  },
  {
    id: "qwen/qwen-2.5-72b-instruct:free",
    name: "Qwen 2.5 72B Instruct (Free)",
    contextLength: 32768,
    label: "Qwen 2.5 72B Instruct (Free) - 33k context",
    isFallback: true,
  },
];

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

function fallbackModelsWithDefault(): OpenRouterModelOption[] {
  return [FREE_AUTO_ROUTER, ...FALLBACK_FREE_MODELS];
}

export async function getFreeOpenRouterModels(apiKey?: string): Promise<{
  models: OpenRouterModelOption[];
  fromFallback: boolean;
}> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
    return { models: [FREE_AUTO_ROUTER, ...deduped], fromFallback: false };
  } catch {
    return { models: fallbackModelsWithDefault(), fromFallback: true };
  }
}

function buildUserPayload(snapshot: FillSnapshot, personaNote: string): string {
  const compactFields = snapshot.fields.map((f) => ({
    sid: f.syntheticId,
    tag: f.tag,
    type: f.inputType,
    name: f.name,
    id: f.id,
    required: !!f.required,
    value: f.currentValue,
    maxLength: f.maxLength,
    pattern: f.pattern,
    placeholder: f.placeholder?.slice(0, 120),
    label_text: (f.labelText ?? f.ariaLabel ?? "").slice(0, 160),
    form_purpose: (f.formPurpose ?? "").slice(0, 140),
    surrounding_text: (f.surroundingText ?? "").slice(0, 180),
    options:
      f.options?.map((o) => o.value).filter((v) => v !== "").slice(0, 60) ??
      f.radioChoices?.map((o) => o.value).filter((v) => v !== "").slice(0, 60),
  }));

  return JSON.stringify(
    {
      task: "Return ONLY a JSON object: syntheticId -> string value for fields that should be filled now.",
      html_lang: snapshot.documentLocale,
      fillLocale: snapshot.fillLocale,
      roundIndex: snapshot.roundIndex,
      maxRounds: snapshot.maxRounds,
      pageTitle: snapshot.pageTitle,
      pageUrl: snapshot.pageUrl,
      persona: personaNote || undefined,
      heuristicFilled: snapshot.heuristicSummary?.map((h) => h.syntheticId) ?? [],
      fields: compactFields,
    },
    null,
    0,
  );
}

function systemPrompt(_settings: ExtensionSettings): string {
  return `You are a test-data assistant for QA form filling. Match the form language implied by html_lang, fillLocale, and field labels (any human language).
Rules:
- Output ONLY valid minified JSON: an object whose keys are syntheticId strings and values are strings.
- Respect input type, pattern, maxlength, required, and select/radio option values (exact value strings).
- Use the provided label_text, form_purpose, surrounding_text, and html_lang as the main context signals.
- For checkboxes, use "true" or "false".
- Use realistic but obviously fake test data (e.g. emails like test.user+tag@example.com).
- Prefer minimal churn: if current value is already present/satisfied, omit that field.
- Fill all required empty fields.
- For optional fields, fill only high-confidence fields (identity/contact, obvious profile fields, clear driver fields). Do not blanket-fill every optional checkbox.
- For conditional forms, prioritize driver fields (country, product type, yes/no toggles) when multiple empties exist.
- Return values in the detected html_lang / page locale, including script, names, and formatting.
- Never include markdown, never wrap in code fences, never include commentary.`;
}

export async function callLlmForFill(
  snapshot: FillSnapshot,
  settings: ExtensionSettings,
  apiKey: string,
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }> {
  const base = settings.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/completions`;

  const personaNote =
    settings.personaJson.trim().length > 0
      ? `User persona JSON (use for names/emails when consistent): ${settings.personaJson.slice(0, 2000)}`
      : "";

  const bodyBase = {
    temperature: 0.1,
    top_p: 0.2,
    include_reasoning: false,
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

  const attempt = async (extraUserHint?: string): Promise<Record<string, string>> => {
    const baseMessages = [...bodyBase.messages];
    if (extraUserHint) {
      baseMessages.push({ role: "user" as const, content: extraUserHint });
    }
    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": APP_URL,
      "X-Title": APP_TITLE,
    };

    const perform = async (
      model: string,
      maxTokens: number,
      payloadMessages: typeof baseMessages,
    ): Promise<{
      ok: boolean;
      status: number;
      text: string;
      data?: {
        choices?: {
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning?: string | null };
        }[];
      };
    }> => {
      const res = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({ ...bodyBase, model, max_tokens: maxTokens, messages: payloadMessages }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, text };
      const data = JSON.parse(text) as {
        choices?: {
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning?: string | null };
        }[];
      };
      return { ok: true, status: res.status, text, data };
    };

    const isTransient = (status: number, text: string): boolean =>
      status === 429 || status >= 500 || /rate-limit|temporarily rate-limited|retry/i.test(text);

    const tokenBudgets = [8000, 3000, 1200];
    const runForModel = async (model: string): Promise<Record<string, string>> => {
      let lastErr = "";
      for (const maxTokens of tokenBudgets) {
        for (let i = 0; i < 3; i++) {
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
            lastErr = `API ${result.status}: ${result.text.slice(0, 500)}`;
            if (i < 2 && isTransient(result.status, result.text)) {
              await sleep(300 * (i + 1) + Math.floor(Math.random() * 200));
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

    const modelCandidates = Array.from(
      new Set(
        [settings.model, "openrouter/free"].filter((m) => typeof m === "string" && m.trim().length > 0),
      ),
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
    const values = await attempt();
    return { ok: true, values };
  } catch (e1) {
    const msg = e1 instanceof Error ? e1.message : String(e1);
    try {
      const values = await attempt(
        `Your previous output failed validation/parsing. Return ONLY the final minified JSON object immediately, with no reasoning, no preface, no markdown. Error: ${msg.slice(0, 400)}`,
      );
      return { ok: true, values };
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      return { ok: false, error: msg2 };
    }
  }
}
