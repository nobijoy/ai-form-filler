import { z } from "zod";

/** LLM returns JSON object with syntheticId -> value */
export const llmValuesSchema = z.record(z.string(), z.string());

export function parseLlmValues(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  return llmValuesSchema.parse(parsed);
}
