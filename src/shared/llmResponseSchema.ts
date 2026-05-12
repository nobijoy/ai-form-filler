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

/**
 * Parse the LLM response into a flat Record<string, string>.
 * - Pretty-printed JSON is accepted (JSON.parse handles it).
 * - String values are kept as-is.
 * - Number/boolean values are coerced to string.
 * - A top-level `_ctx` object value is serialized back to a JSON string so the
 *   orchestrator can extract and merge it without needing a separate type.
 * - Any other non-string value (arrays, null, nested objects) is silently dropped.
 * Throws only when the content is not parseable JSON or not a JSON object.
 */
export function parseLlmValues(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(extractJsonObject(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON object");
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val === "string") {
      result[key] = val;
    } else if (typeof val === "number" || typeof val === "boolean") {
      result[key] = String(val);
    } else if (key === "_ctx" && typeof val === "object" && val !== null && !Array.isArray(val)) {
      // Serialize _ctx object so the orchestrator can JSON.parse it
      result[key] = JSON.stringify(val);
    }
    // null / arrays / nested non-_ctx objects are silently dropped
  }
  return result;
}

export interface ParsedNavigationDecision {
  isMultiStep: boolean;
  shouldAdvanceAfterFill: boolean;
  nextControlSid?: string;
  isFinalSubmit: boolean;
  confidence: number;
}

export function parseNavigationDecision(raw: string): ParsedNavigationDecision {
  const parsed: unknown = JSON.parse(extractJsonObject(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Navigation response is not a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const confidence =
    typeof record.confidence === "number"
      ? record.confidence
      : typeof record.confidence === "string"
        ? Number(record.confidence)
        : 0;

  return {
    isMultiStep: record.isMultiStep === true,
    shouldAdvanceAfterFill: record.shouldAdvanceAfterFill === true,
    nextControlSid:
      typeof record.nextControlSid === "string" && record.nextControlSid.trim()
        ? record.nextControlSid.trim()
        : undefined,
    isFinalSubmit: record.isFinalSubmit === true,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
}
