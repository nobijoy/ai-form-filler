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

export function isFillableField(field: FieldDescriptor): boolean {
  if (!field.visible) return false;
  if (field.disabled) return false;
  if (field.inputType && NON_FILLABLE_INPUT_TYPES.has(field.inputType)) return false;

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
