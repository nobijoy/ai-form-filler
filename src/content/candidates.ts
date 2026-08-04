import { isFillableField } from "../shared/fillable";
import type { ExtensionSettings, FieldDescriptor } from "../shared/types";

function isBooleanKind(field: FieldDescriptor): boolean {
  return (
    field.kind === "checkbox" ||
    field.kind === "aria-checkbox" ||
    field.kind === "aria-switch" ||
    field.inputType === "checkbox"
  );
}

function isChoiceKind(field: FieldDescriptor): boolean {
  return field.kind === "radio" || field.kind === "aria-radio" || field.inputType === "radio";
}

export function isFieldEmpty(field: FieldDescriptor): boolean {
  if (isBooleanKind(field)) return field.currentValue !== "true";
  if (isChoiceKind(field)) return !field.currentValue?.trim();
  return !String(field.currentValue ?? "").trim();
}

/**
 * Whether the DOM currently reflects a value we applied.
 *
 * Frameworks routinely reformat what they store (trimming, masking a phone
 * number, normalizing a date), so an exact string match alone would send us
 * into an endless retry loop on a field that is in fact filled.
 */
export function isFieldAppliedOnDom(field: FieldDescriptor, appliedValue: string): boolean {
  if (isBooleanKind(field)) {
    return field.currentValue === appliedValue;
  }
  if (isChoiceKind(field)) {
    return field.currentValue === appliedValue;
  }

  const current = String(field.currentValue ?? "").trim();
  const applied = String(appliedValue).trim();
  if (current === applied) return true;
  if (!current) return false;

  // A framework-reformatted value still counts as filled.
  const strip = (value: string): string => value.replace(/[\s\-()./]/g, "").toLowerCase();
  if (strip(current) === strip(applied)) return true;

  // Truncated by maxlength.
  if (field.maxLength && applied.length > field.maxLength) {
    return current === applied.slice(0, field.maxLength);
  }

  return false;
}

export function getUnresolvedCandidates(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
): FieldDescriptor[] {
  const excludeSensitive = settings.excludeSensitiveFields === true;
  return fields.filter((field) => {
    if (!isFillableField(field, { excludeSensitive })) return false;

    const appliedValue = appliedValues[field.syntheticId];
    if (appliedValue !== undefined) {
      // Re-queue only when the value did not stick, or the page rejected it.
      if (field.ariaInvalid) return true;
      return !isFieldAppliedOnDom(field, appliedValue);
    }

    if (!settings.fillEmptyOnly) return true;
    return isFieldEmpty(field);
  });
}

export function visibleFillableFields(
  fields: FieldDescriptor[],
  settings?: ExtensionSettings,
): FieldDescriptor[] {
  const excludeSensitive = settings ? settings.excludeSensitiveFields === true : false;
  return fields.filter((field) => isFillableField(field, { excludeSensitive }));
}
