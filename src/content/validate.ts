import type { FieldDescriptor } from "../shared/types";
import { resolveBooleanValue, resolveOptionValue, normalizeForMatch } from "../shared/optionMatch";
import { coerceToPattern } from "../shared/patternCoerce";

export interface RejectedValue {
  sid: string;
  reason: string;
}

export interface ValidationResult {
  /** Values safe to write to the DOM, already resolved to concrete option values. */
  valid: Record<string, string>;
  /** Required fields where the model's answer could not be used. */
  rejected: RejectedValue[];
  /** Required fields the model did not answer at all. */
  missingRequired: string[];
}

/**
 * Models sometimes echo the field's own instruction text back as the value.
 * Detected structurally (matches the placeholder or label) plus a small set of
 * imperative openers, rather than a hardcoded list of specific strings.
 */
const INSTRUCTION_PATTERN =
  /^(please\s+)?(enter|type|select|choose|input|fill|provide|specify|saisir|saisissez|veuillez|bitte|eingeben|auswählen)\b/i;
const CJK_INSTRUCTION_PATTERN = /(入力してください|選択してください|을\s*입력|를\s*선택|请输入|请选择)/;
const PUNCTUATION_ONLY = /^[\s\-_—–.,;:*/\\|()[\]{}]+$/;

function looksLikePlaceholder(value: string, field: FieldDescriptor): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PUNCTUATION_ONLY.test(trimmed)) return true;

  const normalized = normalizeForMatch(trimmed);
  if (field.placeholder && normalizeForMatch(field.placeholder) === normalized) return true;
  if (field.labelText && normalizeForMatch(field.labelText) === normalized) return true;
  if (INSTRUCTION_PATTERN.test(trimmed)) return true;
  if (CJK_INSTRUCTION_PATTERN.test(trimmed)) return true;

  return false;
}

function isBooleanField(field: FieldDescriptor): boolean {
  return (
    field.kind === "checkbox" || field.kind === "aria-checkbox" || field.kind === "aria-switch"
  );
}

function isChoiceField(field: FieldDescriptor): boolean {
  return (
    field.kind === "radio" ||
    field.kind === "aria-radio" ||
    field.kind === "select" ||
    field.kind === "aria-combobox"
  );
}

function choicesFor(field: FieldDescriptor): { value: string; label: string }[] {
  return field.options ?? field.radioChoices ?? [];
}

function clampNumeric(value: string, field: FieldDescriptor): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  let result = parsed;
  const min = Number(field.min);
  const max = Number(field.max);
  if (field.min && Number.isFinite(min) && result < min) result = min;
  if (field.max && Number.isFinite(max) && result > max) result = max;
  return String(result);
}

/** Coerces common model date formats to the `YYYY-MM-DD` a date input requires. */
function coerceDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slash = trimmed.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (slash) {
    return `${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Selection cap for a checkbox group.
 *
 * Only ever derived from what the DOM declares. Inferring a cap from label
 * wording silently discards selections the model made on purpose, which is how
 * the previous implementation lost valid answers.
 */
function maxSelectionsFor(groupFields: FieldDescriptor[]): number {
  const declared = groupFields
    .map((field) => field.maxSelections)
    .filter((value): value is number => typeof value === "number" && value > 0);

  if (declared.length > 0) return Math.min(...declared, groupFields.length);
  return groupFields.length;
}

export function validateAiResponse(
  rawValues: Record<string, string>,
  chunkFields: FieldDescriptor[],
  appliedValues: Record<string, string> = {},
): ValidationResult {
  const fieldMap = new Map(chunkFields.map((field) => [field.syntheticId, field]));
  const valid: Record<string, string> = {};
  const rejected: RejectedValue[] = [];
  const answered = new Set(Object.keys(rawValues).filter((key) => !key.startsWith("_")));

  const reject = (sid: string, field: FieldDescriptor, reason: string): void => {
    if (field.required) rejected.push({ sid, reason });
  };

  // --- Boolean controls, grouped so a declared cap can be enforced -----------

  const trueBySelectionGroup = new Map<string, string[]>();

  for (const [sid, rawValue] of Object.entries(rawValues)) {
    if (sid.startsWith("_")) continue;
    const field = fieldMap.get(sid);
    if (!field || !isBooleanField(field)) continue;

    const resolved = resolveBooleanValue(String(rawValue));
    if (resolved === null) {
      reject(sid, field, `expected true/false, got "${rawValue}"`);
      continue;
    }

    if (!resolved) {
      valid[sid] = "false";
      continue;
    }

    const groupKey = field.checkboxGroupKey;
    if (!groupKey) {
      valid[sid] = "true";
      continue;
    }
    const bucket = trueBySelectionGroup.get(groupKey) ?? [];
    bucket.push(sid);
    trueBySelectionGroup.set(groupKey, bucket);
  }

  for (const [groupKey, sids] of trueBySelectionGroup) {
    const groupFields = chunkFields.filter((field) => field.checkboxGroupKey === groupKey);
    const max = maxSelectionsFor(groupFields);
    for (const sid of sids.slice(0, max)) valid[sid] = "true";
  }

  // --- Everything else ------------------------------------------------------

  for (const [sid, rawValue] of Object.entries(rawValues)) {
    if (sid.startsWith("_")) continue;
    const field = fieldMap.get(sid);
    if (!field || isBooleanField(field)) continue;
    if (typeof rawValue !== "string") continue;

    // Dependent text is meaningless unless its controlling checkbox is selected.
    if (field.controllingCheckboxSid) {
      const controller = field.controllingCheckboxSid;
      const controllerValue =
        valid[controller] ?? rawValues[controller] ?? appliedValues[controller];
      if (resolveBooleanValue(String(controllerValue ?? "")) !== true) continue;
    }

    if (isChoiceField(field)) {
      const choices = choicesFor(field);

      // A popup combobox only renders its options once opened, so at scan time
      // the list can legitimately be unknown. Pass the answer through and let
      // the adapter resolve it against the options it discovers on open.
      if (choices.length === 0) {
        valid[sid] = rawValue;
        continue;
      }

      const resolvedOption = resolveOptionValue(choices, rawValue);
      if (resolvedOption === null) {
        reject(sid, field, `"${rawValue}" is not one of the available options`);
        continue;
      }
      if (!resolvedOption && field.required) {
        reject(sid, field, "resolved to the empty placeholder option");
        continue;
      }
      valid[sid] = resolvedOption;
      continue;
    }

    if (looksLikePlaceholder(rawValue, field)) {
      reject(sid, field, "value repeats the field's own placeholder or label");
      continue;
    }

    let value = rawValue;

    if (field.inputType === "number" || field.inputType === "range") {
      value = clampNumeric(value, field);
    }

    if (field.inputType === "date") {
      const coerced = coerceDate(value);
      if (coerced === null) {
        reject(sid, field, `"${value}" is not a usable date`);
        continue;
      }
      value = coerced;
    }

    if (field.pattern) {
      // Reshape the digits locally where possible rather than spending a round
      // trip on what is usually just a formatting difference.
      const coerced = coerceToPattern(value, field.pattern);
      if (coerced === null) {
        reject(
          sid,
          field,
          `"${value}" does not match the required format. The field's pattern is ${field.pattern}` +
            (field.describedByText ? `, described as: ${field.describedByText}` : ""),
        );
        continue;
      }
      value = coerced;
    }

    if (field.maxLength && field.maxLength > 0) {
      value = value.slice(0, field.maxLength);
    }

    valid[sid] = value;
  }

  // --- Required fields the model skipped entirely ---------------------------

  const missingRequired: string[] = [];
  for (const field of chunkFields) {
    if (!field.required) continue;
    // An unchecked optional-looking checkbox is a legitimate state.
    if (isBooleanField(field)) continue;
    if (answered.has(field.syntheticId)) continue;
    if (valid[field.syntheticId] !== undefined) continue;
    missingRequired.push(field.syntheticId);
  }

  return { valid, rejected, missingRequired };
}
