import { isFillableField } from "../shared/fillable";
import type { ExtensionSettings, FieldDescriptor } from "../shared/types";

export function isFieldEmpty(field: FieldDescriptor): boolean {
  if (field.inputType === "checkbox") return field.currentValue !== "true";
  if (field.inputType === "radio") return !field.currentValue?.trim();
  return !String(field.currentValue ?? "").trim();
}

export function isFieldAppliedOnDom(field: FieldDescriptor, appliedValue: string): boolean {
  if (field.inputType === "checkbox") {
    return appliedValue === "true" && field.currentValue === "true";
  }
  if (field.inputType === "radio") {
    return field.currentValue === appliedValue;
  }
  return String(field.currentValue ?? "").trim() === String(appliedValue).trim();
}

export function getUnresolvedCandidates(
  fields: FieldDescriptor[],
  settings: ExtensionSettings,
  appliedValues: Record<string, string>,
): FieldDescriptor[] {
  return fields.filter((field) => {
    if (!isFillableField(field)) return false;

    const appliedValue = appliedValues[field.syntheticId];
    if (appliedValue !== undefined) {
      return !isFieldAppliedOnDom(field, appliedValue);
    }

    if (!settings.fillEmptyOnly) return true;
    return isFieldEmpty(field);
  });
}

export function visibleFillableFields(fields: FieldDescriptor[]): FieldDescriptor[] {
  return fields.filter((field) => isFillableField(field));
}
