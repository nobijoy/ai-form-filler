import {
  coerceIsoDate,
  formatDateForControl,
  isDateFormatMask,
  isNativeDateInputType,
  looksLikeDateValue,
} from "../../shared/dateField";
import {
  associatedLabelText,
  cleanText,
  fireInputAndChange,
  nearbyLabelText,
  nextFrame,
  resolveAriaLabel,
  setNativeValue,
} from "./dom";
import type { ApplyReport, DescribeContext, WidgetAdapter, WidgetInstance } from "./types";

/**
 * Custom date widgets (Svelte/shadcn combobox triggers, segmented DateFields)
 * that are not a plain visible <input type="date">.
 *
 * Detection is by control type and date format (yyyy/mm/dd), never by the
 * caption language beside the widget.
 */

const DATE_INPUT_SELECTOR =
  "input[type='date'], input[type='datetime-local'], input[type='month'], input[type='week']";

function displayedText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return (el.value || el.placeholder || "").trim();
  return cleanText(el.textContent);
}

function isDateFormatDisplay(el: HTMLElement): boolean {
  const text = displayedText(el);
  return isDateFormatMask(text) || looksLikeDateValue(text);
}

function backingDateInput(el: HTMLElement): HTMLInputElement | null {
  const scopes: Array<HTMLElement | null> = [el, el.parentElement, el.parentElement?.parentElement ?? null];
  for (const scope of scopes) {
    if (!scope) continue;
    const typed = scope.querySelector<HTMLInputElement>(DATE_INPUT_SELECTOR);
    if (typed) return typed;
  }
  return null;
}

function backingWritableInput(el: HTMLElement): HTMLInputElement | null {
  const typed = backingDateInput(el);
  if (typed) return typed;
  if (el instanceof HTMLInputElement) return el;

  const scopes: Array<HTMLElement | null> = [el, el.parentElement];
  for (const scope of scopes) {
    if (!scope) continue;
    const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
    const candidate = inputs.find((input) => {
      const type = (input.type || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "file"].includes(type)) return false;
      return (
        isNativeDateInputType(type) ||
        type === "hidden" ||
        type === "text" ||
        isDateFormatMask(input.placeholder) ||
        looksLikeDateValue(input.value)
      );
    });
    if (candidate) return candidate;
  }
  return null;
}

function segmentGroup(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>("[data-date-field], [data-bits-date-field-root], [role='group']");
}

function isYearSegment(el: HTMLElement): boolean {
  if (el.getAttribute("data-segment") !== "year") return false;
  const group = segmentGroup(el) ?? el.parentElement;
  const first = group?.querySelector<HTMLElement>("[data-segment='year']");
  return first === el;
}

function isDateCombobox(el: HTMLElement): boolean {
  const role = el.getAttribute("role");
  const popup = el.getAttribute("aria-haspopup");
  if (role !== "combobox" && !(el.tagName === "BUTTON" && popup === "dialog")) return false;
  return isDateFormatDisplay(el) || backingDateInput(el) !== null;
}

function currentDateValue(el: HTMLElement): string {
  const input = backingWritableInput(el);
  if (input) {
    const raw = input.value.trim();
    if (!raw || isDateFormatMask(raw)) return "";
    return raw;
  }
  const text = displayedText(el);
  if (!text || isDateFormatMask(text)) return "";
  return text;
}

function labelOf(el: HTMLElement): string | undefined {
  return associatedLabelText(el) || resolveAriaLabel(el) || nearbyLabelText(el) || undefined;
}

async function writeInput(input: HTMLInputElement, value: string): Promise<ApplyReport> {
  const iso = coerceIsoDate(value);
  if (!iso) return { success: false, reason: `"${value}" is not a usable date` };
  const formatted = formatDateForControl(iso, {
    placeholder: input.placeholder,
    pattern: input.pattern,
    inputType: input.type,
  });
  setNativeValue(input, formatted);
  fireInputAndChange(input);
  await nextFrame();
  if (!input.value) return { success: false, reason: "the page reverted the date" };
  return { success: true, appliedValue: input.value };
}

export const datePickerAdapter: WidgetAdapter = {
  name: "date-picker",
  selector:
    "[role='combobox'], button[aria-haspopup='dialog'], [data-segment='year'], [data-date-field]",

  match(el) {
    if (isYearSegment(el) || el.hasAttribute("data-date-field")) return true;
    return isDateCombobox(el);
  },

  describe(el, ctx: DescribeContext) {
    const host = isYearSegment(el) ? (segmentGroup(el) ?? el) : el;
    const input = backingWritableInput(host);
    const labelText = labelOf(host) || (input ? labelOf(input) : undefined);
    const common = ctx.commonParts(host);
    const placeholder =
      (input?.placeholder || undefined) ||
      (isDateFormatMask(displayedText(host)) ? displayedText(host) : undefined);
    const inputType = input && isNativeDateInputType(input.type) ? input.type.toLowerCase() : "date";

    const owned: HTMLElement[] = [host];
    if (input && input !== host) owned.push(input);
    const group = segmentGroup(host);
    if (group) {
      for (const segment of Array.from(group.querySelectorAll<HTMLElement>("[data-segment]"))) {
        if (!owned.includes(segment)) owned.push(segment);
      }
    }

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(host, {
          tag: host instanceof HTMLInputElement ? "input" : "custom",
          inputType,
          name: input?.name || host.getAttribute("name") || undefined,
          id: host.id || input?.id,
          labelText,
        }),
        tag: host instanceof HTMLInputElement ? "input" : "custom",
        kind: "date",
        inputType,
        role: host.getAttribute("role") ?? undefined,
        name: input?.name || undefined,
        id: host.id || input?.id || undefined,
        placeholder,
        min: input?.min || undefined,
        max: input?.max || undefined,
        pattern: input?.pattern || undefined,
        labelText: labelText ?? common.labelText,
        required: (input?.required ?? false) || common.required,
        currentValue: currentDateValue(host),
        disabled: host.getAttribute("aria-disabled") === "true" || Boolean(input?.disabled),
        visible: ctx.isVisible(host) || (input ? ctx.isVisible(input) : false),
      },
      elements: owned,
    };
  },

  read(instance) {
    return currentDateValue(instance.elements[0]);
  },

  async apply(instance: WidgetInstance, value: string): Promise<ApplyReport> {
    const host = instance.elements[0];
    const input =
      instance.elements.find(
        (el): el is HTMLInputElement => el instanceof HTMLInputElement,
      ) ?? backingWritableInput(host);
    if (input) return writeInput(input, value);

    const iso = coerceIsoDate(value);
    if (!iso) return { success: false, reason: `"${value}" is not a usable date` };

    const group = segmentGroup(host) ?? host;
    const year = group.querySelector<HTMLElement>("[data-segment='year']");
    if (year) {
      const [y, m, d] = iso.split("-");
      const parts: Array<[string, string]> = [
        ["year", y],
        ["month", m],
        ["day", d],
      ];
      for (const [seg, digits] of parts) {
        const segment = group.querySelector<HTMLElement>(`[data-segment="${seg}"]`);
        if (!segment) continue;
        segment.focus({ preventScroll: true });
        segment.textContent = digits;
        segment.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      group.dispatchEvent(new Event("change", { bubbles: true }));
      await nextFrame();
      return { success: true, appliedValue: iso };
    }

    return { success: false, reason: "no date input to write to" };
  },
};
