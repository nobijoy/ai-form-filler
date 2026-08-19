import type { FieldKind } from "../../shared/types";
import { ARIA_ADAPTERS } from "./aria";
import { datePickerAdapter } from "./date";
import { NATIVE_ADAPTERS } from "./native";
import type { WidgetAdapter, WidgetInstance } from "./types";

/**
 * Adapter registry.
 *
 * Date-picker adapters come first so a combobox that is actually a calendar
 * is not driven as a listbox. ARIA adapters then claim remaining custom
 * widgets before native inputs.
 */
export const ADAPTERS: WidgetAdapter[] = [datePickerAdapter, ...ARIA_ADAPTERS, ...NATIVE_ADAPTERS];

/** Union selector used for the single document query the scanner performs. */
export const WIDGET_SELECTOR = ADAPTERS.map((adapter) => adapter.selector).join(", ");

export function adapterFor(el: HTMLElement): WidgetAdapter | null {
  for (const adapter of ADAPTERS) {
    if (!el.matches(adapter.selector)) continue;
    if (!adapter.match(el)) continue;
    return adapter;
  }
  return null;
}

const BY_KIND: Partial<Record<FieldKind, string>> = {
  text: "native-text",
  textarea: "native-text",
  select: "native-select",
  radio: "native-radio",
  checkbox: "native-checkbox",
  "aria-checkbox": "aria-toggle",
  "aria-switch": "aria-toggle",
  "aria-radio": "aria-radiogroup",
  "aria-combobox": "aria-combobox",
  contenteditable: "contenteditable",
  date: "date-picker",
};

export function adapterForInstance(instance: WidgetInstance): WidgetAdapter | null {
  const kind = instance.descriptor.kind;
  const name = kind ? BY_KIND[kind] : undefined;
  if (name) {
    const adapter = ADAPTERS.find((entry) => entry.name === name);
    if (adapter) return adapter;
  }
  // Fall back to matching the live element, e.g. for descriptors without a kind.
  const el = instance.elements[0];
  return el ? adapterFor(el) : null;
}

export type { ApplyReport, DescribeContext, WidgetAdapter, WidgetInstance } from "./types";
export { ARIA_ADAPTERS } from "./aria";
export { NATIVE_ADAPTERS, NON_FILLABLE_INPUT_TYPES, isControlDisabled } from "./native";
