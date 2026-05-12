import type { FieldDescriptor } from "./types";

export const NON_FILLABLE_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "file",
]);

export function isFillableField(f: FieldDescriptor): boolean {
  if (!f.visible) return false;
  if (f.disabled) return false;
  if (f.inputType && NON_FILLABLE_INPUT_TYPES.has(f.inputType)) return false;
  return true;
}
