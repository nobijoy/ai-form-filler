import type { FieldDescriptor } from "./types";
import { isFillableField } from "./fillable";

const PAYMENT_AUTOCOMPLETE = /^(cc-|card)/i;

const HEURISTIC_AUTOCOMPLETE = new Set([
  "email",
  "username",
  "url",
  "nickname",
  "given-name",
  "family-name",
  "name",
  "street-address",
  "address-line1",
  "address-line2",
  "postal-code",
  "country",
  "country-name",
  "tel",
  "tel-national",
]);

export interface Persona {
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  phone?: string;
  url?: string;
  street?: string;
  city?: string;
  zip?: string;
  country?: string;
}

export function parsePersona(json: string): Persona {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Persona;
  } catch {
    return {};
  }
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function classifyField(f: FieldDescriptor): "heuristic" | "ai" {
  if (!isFillableField(f)) return "ai";
  const ac = (f.autoComplete || "").toLowerCase().split(/\s+/)[0];
  if (PAYMENT_AUTOCOMPLETE.test(f.autoComplete || "")) return "ai";
  if (f.inputType === "password") return "ai";
  if (f.tag === "select" || f.radioGroup) return "ai";
  if (f.inputType === "checkbox") return "ai";

  if (f.tag === "input") {
    if (f.inputType === "email") return "heuristic";
    if (f.inputType === "url") return "heuristic";
    if (f.inputType === "tel") return "heuristic";
    if (f.inputType === "number") return "heuristic";
    if (ac && HEURISTIC_AUTOCOMPLETE.has(ac)) return "heuristic";
  }

  if (f.tag === "textarea") {
    const label = `${f.labelText || ""} ${f.placeholder || ""}`.toLowerCase();
    if (
      /comment|message|description|notes|feedback|details/.test(label) &&
      (!f.maxLength || f.maxLength <= 500)
    ) {
      return "heuristic";
    }
  }

  return "ai";
}

export function tryHeuristicValue(
  f: FieldDescriptor,
  persona: Persona,
): string | null {
  if (classifyField(f) !== "heuristic") return null;

  const ac = (f.autoComplete || "").toLowerCase().split(/\s+/)[0];

  if (f.inputType === "email" || ac === "email") {
    return (
      persona.email ||
      `test.user+${randomTag()}@example.com`
    );
  }
  if (f.inputType === "url" || ac === "url") {
    return persona.url || "https://example.com";
  }
  if (f.inputType === "tel" || ac?.startsWith("tel")) {
    return persona.phone || "+15555550100";
  }
  if (f.inputType === "number") {
    return "42";
  }
  if (ac === "given-name")
    return persona.firstName || "Test";
  if (ac === "family-name")
    return persona.lastName || "User";
  if (ac === "name" || ac === "nickname")
    return persona.fullName || "Test User";
  if (ac === "username")
    return persona.email?.split("@")[0] || `user_${randomTag()}`;
  if (ac === "street-address" || ac === "address-line1")
    return persona.street || "123 Test Street";
  if (ac === "address-line2")
    return "";
  if (ac === "postal-code")
    return persona.zip || "94105";
  if (ac === "country" || ac === "country-name")
    return persona.country || "US";

  if (f.tag === "textarea") {
    const max = f.maxLength && f.maxLength > 0 ? Math.min(f.maxLength, 200) : 120;
    return "Test comment for QA.".slice(0, max);
  }

  if (f.tag === "input" && f.inputType === "text") {
    const label = `${f.labelText || ""}`.toLowerCase();
    if (/city|town/.test(label)) return persona.city || "San Francisco";
    if (/zip|postal/.test(label)) return persona.zip || "94105";
  }

  return null;
}
