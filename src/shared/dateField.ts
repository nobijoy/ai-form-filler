import type { FieldDescriptor } from "./types";

export const DATE_INPUT_TYPES = new Set(["date", "month", "week", "datetime-local"]);

/** name/id/class tokens. Identifiers, not translated UI copy. */
const DATE_NAME =
  /(start|end|from|to|begin|apply|valid|expir|period|birth|bday).{0,12}date|(^|[_\s-])date([_\s-]|$)|datepicker|date-picker|flatpickr|datetime/i;

const END_DATE_NAME = /enddate|end_date|end-date|\bend\b|until|todate|to_date|to-date|expir|validto|valid_to|valid-to/i;

/**
 * Empty-state format masks (yyyy/mm/dd, MM-DD-YYYY, …). Language-independent:
 * the widget type, not the caption next to it.
 */
const DATE_FORMAT_MASK =
  /^(y{2}|y{4})[-/.年]m{1,2}[-/.月]?d{1,2}日?$|^m{1,2}[-/.]d{1,2}[-/.](y{2}|y{4})$|^d{1,2}[-/.]m{1,2}[-/.](y{2}|y{4})$/i;

const DATE_VALUE =
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

export function isNativeDateInputType(type: string | undefined | null): boolean {
  return DATE_INPUT_TYPES.has((type || "").toLowerCase());
}

export function isDateFormatMask(value: string | undefined | null): boolean {
  if (!value) return false;
  return DATE_FORMAT_MASK.test(value.trim().replace(/\s+/g, ""));
}

export function looksLikeDateValue(value: string | undefined | null): boolean {
  if (!value) return false;
  return DATE_VALUE.test(value.trim());
}

export function looksLikeDatePattern(pattern: string | undefined | null): boolean {
  if (!pattern) return false;
  return /\\d\{4\}/.test(pattern) && /\\d\{1,2\}/.test(pattern);
}

/** Coerce a model/heuristic answer to YYYY-MM-DD, or null if unusable. */
export function coerceIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const ymd = trimmed.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  }

  const dmy = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function formatDateForControl(
  iso: string,
  hint: { placeholder?: string; pattern?: string; inputType?: string },
): string {
  if (isNativeDateInputType(hint.inputType)) return iso;
  const formatHint = `${hint.placeholder || ""}${hint.pattern || ""}`;
  if (/[/.年]/.test(formatHint) || isDateFormatMask(hint.placeholder)) {
    const sep = formatHint.includes(".") ? "." : "/";
    return iso.replace(/-/g, sep);
  }
  return iso;
}

export function controlLooksLikeDateStore(attrs: {
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  value?: string;
  className?: string;
  pattern?: string;
}): boolean {
  if (isNativeDateInputType(attrs.type) || attrs.type === "time") return true;
  if (isDateFormatMask(attrs.placeholder) || isDateFormatMask(attrs.value)) return true;
  if (looksLikeDateValue(attrs.value)) return true;
  if (looksLikeDatePattern(attrs.pattern)) return true;
  const ident = `${attrs.name || ""} ${attrs.id || ""} ${attrs.className || ""}`;
  return DATE_NAME.test(ident);
}

function identityBlob(field: FieldDescriptor): string {
  return [field.placeholder, field.pattern, field.currentValue, field.name, field.id]
    .filter(Boolean)
    .join(" ");
}

export function isNativeDateInput(field: FieldDescriptor): boolean {
  return isNativeDateInputType(field.inputType);
}

export function looksLikeDateField(field: FieldDescriptor): boolean {
  if (isNativeDateInput(field) || field.kind === "date") return true;
  if (field.inputType === "time") return false;
  return (
    isDateFormatMask(field.placeholder) ||
    isDateFormatMask(field.currentValue) ||
    looksLikeDatePattern(field.pattern) ||
    DATE_NAME.test(identityBlob(field))
  );
}

export function looksLikeEndDateField(field: FieldDescriptor): boolean {
  if (field.dateWindow === "end") return true;
  if (field.dateWindow === "start") return false;
  return END_DATE_NAME.test([field.name, field.id].filter(Boolean).join(" "));
}

export function looksLikeDateIdentity(blob: string): boolean {
  return DATE_NAME.test(blob) || isDateFormatMask(blob) || looksLikeDateValue(blob);
}

/** Prompt/type token the model should see instead of a generic "text". */
export function dateTypeForPrompt(field: FieldDescriptor): string | undefined {
  const type = (field.inputType || "").toLowerCase();
  if (DATE_INPUT_TYPES.has(type) || type === "time") return type;
  if (looksLikeDateField(field)) return "date";
  return undefined;
}
