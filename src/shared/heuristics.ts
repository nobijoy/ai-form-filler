import type { FieldDescriptor } from "./types";
import { isFillableField } from "./fillable";

/**
 * Network-free value generation for fields whose meaning is unambiguous from
 * their type or autocomplete token. Anything requiring judgement (selects,
 * radios, checkboxes, prose, payment data) is left to the model.
 *
 * Values are seeded from the run's identity map so that a field filled here
 * stays consistent with the same slot on a later step.
 */

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

/** Values already chosen this run, keyed by semantic slot. */
export type IdentityMap = Record<string, string>;

function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

function primaryAutoCompleteToken(field: FieldDescriptor): string {
  return (field.autoComplete || "").toLowerCase().split(/\s+/)[0] ?? "";
}

export function classifyField(field: FieldDescriptor): "heuristic" | "ai" {
  if (!isFillableField(field)) return "ai";
  if (PAYMENT_AUTOCOMPLETE.test(field.autoComplete || "")) return "ai";
  if (field.inputType === "password") return "ai";

  // Anything with a choice set, or any boolean, needs to understand the form.
  if (field.kind && field.kind !== "text" && field.kind !== "textarea") return "ai";
  if (field.tag === "select" || field.radioGroup) return "ai";

  const token = primaryAutoCompleteToken(field);

  if (field.kind === "text" || field.tag === "input") {
    if (field.inputType === "email") return "heuristic";
    if (field.inputType === "url") return "heuristic";
    if (field.inputType === "tel") return "heuristic";
    if (token && HEURISTIC_AUTOCOMPLETE.has(token)) return "heuristic";
  }

  return "ai";
}

/**
 * Whether a generic value satisfies the constraints the field declares.
 *
 * A locale-specific format ("0XX-XXXX-XXXX") is exactly the case a generic
 * value gets wrong, and handing it over anyway costs a full validation round
 * trip. Deferring to the model is cheaper than being rejected by the page.
 */
function satisfiesConstraints(value: string, field: FieldDescriptor): boolean {
  if (field.maxLength && value.length > field.maxLength) return false;
  if (!field.pattern) return true;
  try {
    return new RegExp(`^(?:${field.pattern})$`).test(value);
  } catch {
    return true;
  }
}

/**
 * A generated value, or null when the field needs the model.
 *
 * `identity` is read *and* respected: reusing the earlier email is what makes a
 * later "confirm your email" field match.
 */
export function tryHeuristicValue(
  field: FieldDescriptor,
  identity: IdentityMap = {},
): string | null {
  const value = generateHeuristicValue(field, identity);
  if (value === null) return null;
  return satisfiesConstraints(value, field) ? value : null;
}

function generateHeuristicValue(field: FieldDescriptor, identity: IdentityMap): string | null {
  if (classifyField(field) !== "heuristic") return null;

  const token = primaryAutoCompleteToken(field);

  if (field.inputType === "email" || token === "email") {
    return identity.email || `test.user+${randomTag()}@example.com`;
  }
  if (field.inputType === "url" || token === "url") {
    return identity.url || "https://example.com";
  }
  if (field.inputType === "tel" || token.startsWith("tel")) {
    return identity.phone || "+15555550100";
  }

  switch (token) {
    case "given-name":
      return identity.firstName || "Test";
    case "family-name":
      return identity.lastName || "User";
    case "name":
    case "nickname":
      return identity.fullName || "Test User";
    case "username":
      return identity.username || identity.email?.split("@")[0] || `user_${randomTag()}`;
    case "street-address":
    case "address-line1":
      return identity.street || "123 Test Street";
    case "address-line2":
      return null;
    case "postal-code":
      return identity.postalCode || "94105";
    case "country":
    case "country-name":
      return identity.country || "US";
    default:
      break;
  }

  return null;
}
