import type { FieldOption } from "../../shared/types";
import { resolveBooleanValue, resolveOptionValue } from "../../shared/optionMatch";
import {
  associatedLabelText,
  cleanText,
  delay,
  nextFrame,
  pressKey,
  resolveAriaLabel,
  simulateClick,
} from "./dom";
import { optionSignatureOf, type ApplyReport, type DescribeContext, type WidgetAdapter, type WidgetInstance } from "./types";
import { datePickerAdapter } from "./date";

/**
 * Adapters for controls built from ARIA roles rather than native elements.
 *
 * These have no `value` property, so state is read from `aria-checked` /
 * `aria-selected` and changed by driving the same pointer and key events a user
 * would produce. Native inputs are handled by `native.ts`.
 */

const NATIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION"]);

function isCustomControl(el: HTMLElement): boolean {
  return !NATIVE_TAGS.has(el.tagName);
}

function labelFor(el: HTMLElement): string | undefined {
  return resolveAriaLabel(el) || associatedLabelText(el) || cleanText(el.textContent) || undefined;
}

function isRequired(el: HTMLElement): boolean {
  if (el.getAttribute("aria-required") === "true") return true;
  const group = el.closest("[aria-required='true']");
  return group !== null;
}

// ---------------------------------------------------------------------------
// role=checkbox / role=switch
// ---------------------------------------------------------------------------

function readAriaChecked(el: HTMLElement): string {
  return String(el.getAttribute("aria-checked") === "true");
}

async function toggleAriaChecked(el: HTMLElement, value: string): Promise<ApplyReport> {
  const expected = resolveBooleanValue(value);
  if (expected === null) return { success: false, reason: `not a boolean: "${value}"` };

  if (readAriaChecked(el) !== String(expected)) {
    el.focus({ preventScroll: true });
    simulateClick(el);
    await nextFrame();

    // Some implementations only respond to Space.
    if (readAriaChecked(el) !== String(expected)) {
      pressKey(el, " ");
      await nextFrame();
    }
  }

  if (readAriaChecked(el) !== String(expected)) {
    return { success: false, reason: "aria-checked did not change" };
  }
  return { success: true, appliedValue: String(expected) };
}

export const ariaToggleAdapter: WidgetAdapter = {
  name: "aria-toggle",
  selector: "[role='checkbox'], [role='switch']",

  match(el) {
    return isCustomControl(el) && el.hasAttribute("aria-checked");
  },

  describe(el, ctx) {
    const role = el.getAttribute("role") === "switch" ? "aria-switch" : "aria-checkbox";
    const labelText = labelFor(el);
    const common = ctx.commonParts(el);
    const groupContainer = el.closest("[role='group'], fieldset");

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(el, { tag: "custom", inputType: role, labelText }),
        tag: "custom",
        kind: role,
        role: el.getAttribute("role") ?? undefined,
        labelText: labelText ?? common.labelText,
        required: isRequired(el) || common.required,
        currentValue: readAriaChecked(el),
        disabled: el.getAttribute("aria-disabled") === "true",
        visible: ctx.isVisible(el),
        checkboxGroupKey: groupContainer ? common.groupKey : undefined,
      },
      elements: [el],
    };
  },

  read(instance) {
    return readAriaChecked(instance.elements[0]);
  },

  apply(instance, value) {
    return toggleAriaChecked(instance.elements[0], value);
  },
};

// ---------------------------------------------------------------------------
// role=radiogroup / role=radio
// ---------------------------------------------------------------------------

function radiosIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[role='radio']"));
}

export const ariaRadioGroupAdapter: WidgetAdapter = {
  name: "aria-radiogroup",
  selector: "[role='radiogroup']",

  match(el) {
    return isCustomControl(el) && radiosIn(el).length > 0;
  },

  describe(el, ctx) {
    const radios = radiosIn(el);
    if (radios.length === 0) return null;

    const choices: FieldOption[] = radios.map((radio, index) => ({
      value: radio.getAttribute("data-value") ?? labelFor(radio) ?? `option-${index + 1}`,
      label: labelFor(radio) ?? `option ${index + 1}`,
    }));

    const labelText = resolveAriaLabel(el) || undefined;
    const common = ctx.commonParts(el);
    const selectedIndex = radios.findIndex(
      (radio) => radio.getAttribute("aria-checked") === "true",
    );

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(el, {
          tag: "custom",
          inputType: "aria-radio",
          labelText,
          optionSignature: optionSignatureOf(choices),
        }),
        tag: "custom",
        kind: "aria-radio",
        role: "radiogroup",
        labelText: labelText ?? common.labelText,
        required: isRequired(el) || common.required,
        radioChoices: choices,
        currentValue: selectedIndex >= 0 ? choices[selectedIndex].value : "",
        disabled: el.getAttribute("aria-disabled") === "true",
        visible: ctx.isVisible(el),
      },
      elements: [el, ...radios],
    };
  },

  read(instance) {
    const radios = instance.elements.slice(1);
    const index = radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
    if (index < 0) return "";
    return instance.descriptor.radioChoices?.[index]?.value ?? "";
  },

  async apply(instance, value) {
    const radios = instance.elements.slice(1);
    const choices = instance.descriptor.radioChoices ?? [];
    const resolved = resolveOptionValue(choices, value);
    if (resolved === null) return { success: false, reason: `no option matches "${value}"` };

    const index = choices.findIndex((choice) => choice.value === resolved);
    const target = radios[index];
    if (!target) return { success: false, reason: "resolved option has no element" };

    target.focus({ preventScroll: true });
    simulateClick(target);
    await nextFrame();

    if (target.getAttribute("aria-checked") !== "true") {
      pressKey(target, " ");
      await nextFrame();
    }

    if (target.getAttribute("aria-checked") !== "true") {
      return { success: false, reason: "aria-checked did not change" };
    }
    return { success: true, appliedValue: resolved };
  },
};

// ---------------------------------------------------------------------------
// role=combobox / role=listbox
// ---------------------------------------------------------------------------

/** The listbox this combobox demonstrably owns, by reference or containment. */
function ownedListbox(combobox: HTMLElement): HTMLElement | null {
  const controls = combobox.getAttribute("aria-controls") ?? combobox.getAttribute("aria-owns");
  if (controls) {
    const byId = document.getElementById(controls);
    if (byId) return byId;
  }
  return combobox.parentElement?.querySelector<HTMLElement>("[role='listbox']") ?? null;
}

/**
 * As `ownedListbox`, plus any open listbox in the document.
 *
 * Only safe immediately after opening this combobox, when an open popup is
 * almost certainly the one just opened — libraries that portal their popup to
 * `document.body` leave no ownership link to follow. Reading state through this
 * would instead risk crediting one combobox with another's selection.
 */
function listboxFor(combobox: HTMLElement): HTMLElement | null {
  return ownedListbox(combobox) ?? document.querySelector<HTMLElement>("[role='listbox']");
}

function optionsIn(listbox: HTMLElement | null): HTMLElement[] {
  if (!listbox) return [];
  return Array.from(listbox.querySelectorAll<HTMLElement>("[role='option']"));
}

function optionValue(option: HTMLElement, index: number): string {
  return (
    option.getAttribute("data-value") ??
    option.getAttribute("value") ??
    cleanText(option.textContent) ??
    `option-${index + 1}`
  );
}

function choicesFrom(options: HTMLElement[]): FieldOption[] {
  return options.map((option, index) => ({
    value: optionValue(option, index),
    label: cleanText(option.textContent) || optionValue(option, index),
  }));
}

/**
 * Options seen while a popup was open, remembered per element.
 *
 * A closed combobox renders no listbox at all, so a scan can read neither its
 * options nor which one is selected. Carrying over what a previous open revealed
 * answers both on later scans.
 */
const knownOptions = new WeakMap<HTMLElement, FieldOption[]>();

/** Opening the popup is what renders the options, so it must happen before reading them. */
async function openCombobox(combobox: HTMLElement): Promise<HTMLElement[]> {
  const existing = optionsIn(ownedListbox(combobox));
  if (existing.length > 0) {
    knownOptions.set(combobox, choicesFrom(existing));
    return existing;
  }

  combobox.focus({ preventScroll: true });
  simulateClick(combobox);
  await delay(120);

  let options = optionsIn(listboxFor(combobox));
  if (options.length === 0) {
    pressKey(combobox, "ArrowDown");
    await delay(120);
    options = optionsIn(listboxFor(combobox));
  }

  if (options.length > 0) knownOptions.set(combobox, choicesFrom(options));
  return options;
}

/**
 * The current selection, or "" when nothing is positively selected.
 *
 * A button-style combobox shows placeholder copy ("Select a country") while
 * empty, and once the popup closes that copy is indistinguishable from a real
 * choice. Reporting it as the current value made required comboboxes look
 * already satisfied, so they were filtered out as resolved and never offered to
 * the model — the page then refused to advance over a field the run never saw.
 * Only evidence of an actual choice counts here.
 */
function comboboxSelection(combobox: HTMLElement): string {
  if (combobox instanceof HTMLInputElement) return combobox.value;

  const activeId = combobox.getAttribute("aria-activedescendant");
  const active = activeId ? document.getElementById(activeId) : null;
  if (active) return cleanText(active.textContent);

  const selected = optionsIn(ownedListbox(combobox)).find(
    (option) => option.getAttribute("aria-selected") === "true",
  );
  if (selected) return cleanText(selected.textContent);

  // Falls back to the display text only when it matches an option we have
  // actually seen, which is what makes a filled combobox read back correctly.
  const text = cleanText(combobox.textContent);
  const known = knownOptions.get(combobox) ?? [];
  const match = known.find((option) => option.label === text || option.value === text);
  return match ? match.value : "";
}

export const ariaComboboxAdapter: WidgetAdapter = {
  name: "aria-combobox",
  selector: "[role='combobox'], [role='listbox']",

  match(el) {
    if (datePickerAdapter.match(el)) return false;
    if (el.getAttribute("role") === "listbox") {
      // A standalone listbox is its own control; one owned by a combobox is not.
      return (
        isCustomControl(el) &&
        !document.querySelector(`[role='combobox'][aria-controls='${CSS.escape(el.id || "\u0000")}']`)
      );
    }
    return el.getAttribute("role") === "combobox";
  },

  describe(el, ctx) {
    const isListbox = el.getAttribute("role") === "listbox";
    const optionEls = optionsIn(isListbox ? el : ownedListbox(el));

    // The popup is usually closed at scan time, so fall back to whatever a
    // previous open revealed rather than reporting a choice field with no
    // choices.
    const live = choicesFrom(optionEls);
    if (live.length > 0) knownOptions.set(el, live);
    const choices: FieldOption[] = live.length > 0 ? live : (knownOptions.get(el) ?? []);

    const labelText = resolveAriaLabel(el) || associatedLabelText(el) || undefined;
    const common = ctx.commonParts(el);

    return {
      descriptor: {
        ...common,
        // Deliberately no option signature: the list is invisible until the
        // popup opens, so including it would change the field's identity the
        // moment it is filled and make it look like a new, empty field.
        syntheticId: ctx.allocateSid(el, {
          tag: "custom",
          inputType: "aria-combobox",
          id: el.id,
          labelText,
        }),
        tag: "custom",
        kind: "aria-combobox",
        role: el.getAttribute("role") ?? undefined,
        id: el.id || undefined,
        labelText: labelText ?? common.labelText,
        placeholder:
          el instanceof HTMLInputElement && el.placeholder ? el.placeholder : undefined,
        required: isRequired(el) || common.required,
        options: choices.length > 0 ? choices : undefined,
        currentValue: comboboxSelection(el),
        disabled: el.getAttribute("aria-disabled") === "true",
        visible: ctx.isVisible(el),
      },
      elements: [el],
    };
  },

  read(instance) {
    return comboboxSelection(instance.elements[0]);
  },

  async apply(instance, value) {
    const combobox = instance.elements[0];
    const options = await openCombobox(combobox);

    if (options.length === 0) {
      // Editable comboboxes accept typed text even with no rendered list.
      if (combobox instanceof HTMLInputElement) {
        combobox.focus({ preventScroll: true });
        combobox.value = value;
        combobox.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await delay(150);
        const filtered = optionsIn(listboxFor(combobox));
        if (filtered.length > 0) {
          simulateClick(filtered[0]);
          await nextFrame();
          return { success: true, appliedValue: cleanText(filtered[0].textContent) };
        }
        pressKey(combobox, "Enter");
        await nextFrame();
        return { success: true, appliedValue: combobox.value };
      }
      return { success: false, reason: "combobox exposed no options" };
    }

    const choices = choicesFrom(options);
    const resolved = resolveOptionValue(choices, value);
    if (resolved === null) {
      pressKey(combobox, "Escape");
      return { success: false, reason: `no option matches "${value}"` };
    }

    const target = options[choices.findIndex((choice) => choice.value === resolved)];
    if (!target) return { success: false, reason: "resolved option has no element" };

    target.scrollIntoView({ block: "nearest" });
    simulateClick(target);
    await delay(120);

    return { success: true, appliedValue: resolved };
  },
};

// ---------------------------------------------------------------------------
// contenteditable
// ---------------------------------------------------------------------------

export const contentEditableAdapter: WidgetAdapter = {
  name: "contenteditable",
  selector: "[contenteditable='true'], [contenteditable='']",

  match(el) {
    // Rich-text editors often nest editable regions; only take the outermost.
    if (!el.isContentEditable) return false;
    const parent = el.parentElement?.closest("[contenteditable='true'], [contenteditable='']");
    return parent === null || parent === undefined;
  },

  describe(el, ctx) {
    const labelText = resolveAriaLabel(el) || associatedLabelText(el) || undefined;
    const common = ctx.commonParts(el);

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(el, {
          tag: "custom",
          inputType: "contenteditable",
          id: el.id,
          labelText,
        }),
        tag: "custom",
        kind: "contenteditable",
        role: el.getAttribute("role") ?? undefined,
        id: el.id || undefined,
        labelText: labelText ?? common.labelText,
        placeholder: el.getAttribute("data-placeholder") ?? undefined,
        required: isRequired(el) || common.required,
        currentValue: cleanText(el.textContent),
        disabled: el.getAttribute("aria-disabled") === "true",
        visible: ctx.isVisible(el),
      },
      elements: [el],
    };
  },

  read(instance) {
    return cleanText(instance.elements[0].textContent);
  },

  async apply(instance, value) {
    const el = instance.elements[0];
    el.focus({ preventScroll: true });

    // execCommand keeps editors that track selection state in sync; a plain
    // textContent write is the fallback when it is unavailable.
    const inserted = document.execCommand?.("insertText", false, value) ?? false;
    if (!inserted) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    await nextFrame();

    const current = cleanText(el.textContent);
    if (!current && value.trim()) return { success: false, reason: "editor discarded the text" };
    return { success: true, appliedValue: current };
  },
};

export const ARIA_ADAPTERS: WidgetAdapter[] = [
  ariaToggleAdapter,
  ariaRadioGroupAdapter,
  ariaComboboxAdapter,
  contentEditableAdapter,
];

export type { DescribeContext, WidgetInstance };
