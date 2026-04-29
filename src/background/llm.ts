import { parseLlmValues } from "../shared/llmResponseSchema";
import type { ExtensionSettings, FillSnapshot } from "../shared/types";

function buildUserPayload(snapshot: FillSnapshot, personaNote: string): string {
  return JSON.stringify(
    {
      task: "Return ONLY a JSON object mapping syntheticId to string value for each field that needs a value.",
      fillLocale: snapshot.fillLocale,
      roundIndex: snapshot.roundIndex,
      maxRounds: snapshot.maxRounds,
      pageTitle: snapshot.pageTitle,
      pageUrl: snapshot.pageUrl,
      persona: personaNote || undefined,
      heuristicFilled: snapshot.heuristicSummary ?? [],
      fields: snapshot.fields.map((f) => ({
        syntheticId: f.syntheticId,
        tag: f.tag,
        inputType: f.inputType,
        name: f.name,
        id: f.id,
        placeholder: f.placeholder,
        required: f.required,
        pattern: f.pattern,
        maxLength: f.maxLength,
        autoComplete: f.autoComplete,
        ariaLabel: f.ariaLabel,
        labelText: f.labelText,
        options: f.options,
        radioChoices: f.radioChoices,
        currentValue: f.currentValue,
        disabled: f.disabled,
        visible: f.visible,
        fieldLocale: f.fieldLocale,
      })),
    },
    null,
    0,
  );
}

function systemPrompt(settings: ExtensionSettings): string {
  const override =
    settings.fillLanguage === "override"
      ? `Use fill locale override: ${settings.fillLocaleOverride}.`
      : "Match the form language implied by fillLocale and field labels (any human language).";

  return `You are a test-data assistant for QA form filling. ${override}
Rules:
- Output ONLY valid minified JSON: an object whose keys are syntheticId strings and values are strings.
- Respect input type, pattern, maxlength, required, and select/radio option VALUES (use exact option value strings).
- For checkboxes, use "true" or "false".
- Use realistic but obviously fake test data (e.g. emails like test.user+tag@example.com).
- Prefer minimal churn: if currentValue is non-empty and the field is already satisfied, you may omit that key or repeat the same value.
- For conditional forms, prioritize driver fields (country, product type) when multiple empties exist.
- Obey fillLocale for script and formatting when not using override mode.
- Never include markdown, never wrap in code fences.`;
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

  const body = {
    model: settings.model,
    temperature: 0.2,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: systemPrompt(settings) },
      {
        role: "user" as const,
        content: buildUserPayload(snapshot, personaNote),
      },
    ],
  };

  const attempt = async (extraUserHint?: string): Promise<Record<string, string>> => {
    const messages = [...body.messages];
    if (extraUserHint) {
      messages.push({ role: "user" as const, content: extraUserHint });
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...body, messages }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`API ${res.status}: ${t.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty model response");
    return parseLlmValues(content);
  };

  try {
    const values = await attempt();
    return { ok: true, values };
  } catch (e1) {
    const msg = e1 instanceof Error ? e1.message : String(e1);
    try {
      const values = await attempt(
        `Your previous output failed validation or parsing. Return ONLY a JSON object string->string. Error: ${msg.slice(0, 400)}`,
      );
      return { ok: true, values };
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      return { ok: false, error: msg2 };
    }
  }
}
