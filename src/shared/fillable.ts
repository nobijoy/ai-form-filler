import type { FieldDescriptor } from "./types";

/** Input types the extension will never write to. */
export const NON_FILLABLE_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "file",
]);

/** Payment-related autocomplete tokens (HTML autocomplete spec + common variants). */
export const PAYMENT_AUTOCOMPLETE = /^(cc-|card)/i;

export function isSensitiveField(field: FieldDescriptor): boolean {
  if (field.inputType === "password") return true;
  if (PAYMENT_AUTOCOMPLETE.test(field.autoComplete || "")) return true;
  return false;
}

export function isFillableField(
  field: FieldDescriptor,
  options?: { excludeSensitive?: boolean },
): boolean {
  if (!field.visible) return false;
  if (field.disabled) return false;
  if (field.inputType && NON_FILLABLE_INPUT_TYPES.has(field.inputType)) return false;
  if (options?.excludeSensitive && isSensitiveField(field)) return false;

  // A control with no label, name or surrounding copy gives the model nothing to
  // reason about, and is usually framework scaffolding rather than a real field.
  const hasIdentity = Boolean(
    field.labelText?.trim() ||
      field.ariaLabel?.trim() ||
      field.name?.trim() ||
      field.placeholder?.trim() ||
      field.autoComplete?.trim() ||
      field.options?.length ||
      field.radioChoices?.length,
  );

  return hasIdentity || Boolean(field.surroundingText?.trim());
}
