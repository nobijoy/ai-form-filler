import { z } from "zod";

/** LLM returns JSON object with syntheticId -> value */
export const llmValuesSchema = z.record(z.string(), z.string());

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

export function parseLlmValues(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(extractJsonObject(raw));
  return llmValuesSchema.parse(parsed);
}
