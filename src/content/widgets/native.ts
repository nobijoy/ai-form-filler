import type { FieldOption } from "../../shared/types";
import { resolveBooleanValue, resolveOptionValue } from "../../shared/optionMatch";
import {
  associatedLabelText,
  cleanText,
  fireInputAndChange,
  nextFrame,
  resolveAriaLabel,
  setNativeChecked,
  setNativeValue,
  simulateClick,
} from "./dom";
import { optionSignatureOf, type ApplyReport, type WidgetAdapter } from "./types";

/**
 * Adapters for native form controls.
 *
 * Every write goes through the prototype value/checked setter followed by real
 * `input` and `change` events, then verifies the result: a controlled React
 * component silently reverts anything it did not observe as a genuine change.
 */

const NON_FILLABLE_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "file",
]);

function inputTypeOf(el: HTMLInputElement): string {
  return (el.type || "text").toLowerCase();
}

function isDisabled(el: Element): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if ((el as HTMLInputElement).readOnly) return true;
  if (el.closest("[inert]")) return true;
  return el.closest("fieldset[disabled]") !== null;
}

function labelOf(el: HTMLElement): string | undefined {
  return associatedLabelText(el) || resolveAriaLabel(el) || undefined;
}

// ---------------------------------------------------------------------------
// Text-like inputs and textareas
// ---------------------------------------------------------------------------

async function applyTextLike(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<ApplyReport> {
  el.focus({ preventScroll: true });
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

  setNativeValue(el, value);
  fireInputAndChange(el);

  el.dispatchEvent(new FocusEvent("blur"));
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await nextFrame();

  if (el.value === "" && value !== "") {
    return { success: false, reason: "the page reverted the value" };
  }
  return { success: true, appliedValue: el.value };
}

export const nativeTextAdapter: WidgetAdapter = {
  name: "native-text",
  selector: "input, textarea",

  match(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (!(el instanceof HTMLInputElement)) return false;
    const type = inputTypeOf(el);
    return !NON_FILLABLE_INPUT_TYPES.has(type) && type !== "checkbox" && type !== "radio";
  },

  describe(el, ctx) {
    const control = el as HTMLInputElement | HTMLTextAreaElement;
    const isTextarea = control instanceof HTMLTextAreaElement;
    const type = isTextarea ? undefined : inputTypeOf(control as HTMLInputElement);
    const labelText = labelOf(control);
    const common = ctx.commonParts(control);

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(control, {
          tag: isTextarea ? "textarea" : "input",
          inputType: type,
          name: control.name,
          id: control.id,
          labelText,
        }),
        tag: isTextarea ? "textarea" : "input",
        kind: isTextarea ? "textarea" : "text",
        inputType: type,
        name: control.name || undefined,
        id: control.id || undefined,
        placeholder: control.placeholder || undefined,
        pattern: !isTextarea ? (control as HTMLInputElement).pattern || undefined : undefined,
        maxLength: control.maxLength > 0 ? control.maxLength : undefined,
        min: !isTextarea ? (control as HTMLInputElement).min || undefined : undefined,
        max: !isTextarea ? (control as HTMLInputElement).max || undefined : undefined,
        step: !isTextarea ? (control as HTMLInputElement).step || undefined : undefined,
        inputMode: control.getAttribute("inputmode") || undefined,
        autoComplete: control.autocomplete || undefined,
        labelText: labelText ?? common.labelText,
        required: control.required || common.required,
        currentValue: control.value,
        disabled: isDisabled(control),
        visible: ctx.isVisible(control),
      },
      elements: [control],
    };
  },

  read(instance) {
    return (instance.elements[0] as HTMLInputElement).value;
  },

  apply(instance, value) {
    return applyTextLike(instance.elements[0] as HTMLInputElement, value);
  },
};

// ---------------------------------------------------------------------------
// Checkable controls
// ---------------------------------------------------------------------------

/**
 * Brings a checkbox or radio to `expected`, clicking rather than writing.
 *
 * React routes `onChange` for checkboxes and radios off the native `click`
 * event rather than `input`/`change`. Setting the `checked` property and firing
 * input/change therefore updates the DOM while leaving React's state untouched:
 * the control verifies as selected immediately, then reverts on the next render
 * the page happens to do, so the page validates it as empty long after the fill
 * reported success. Clicking is both what a user does and what the framework
 * listens for.
 */
async function setCheckedState(el: HTMLInputElement, expected: boolean): Promise<boolean> {
  if (el.checked !== expected) {
    el.focus({ preventScroll: true });
    simulateClick(el);
    await nextFrame();
  }

  // Fallback for pages that cancel the click: write the property and announce
  // it, which is enough for anything not listening for the click itself.
  if (el.checked !== expected) {
    setNativeChecked(el, expected);
    fireInputAndChange(el);
    await nextFrame();
  }

  // Judge the state that survives the re-render, not the one the write produced.
  await nextFrame();
  return el.checked === expected;
}

/** Selection cap taken only from what the DOM declares, never guessed from copy. */
function declaredMaxSelections(el: HTMLElement): number | undefined {
  const container = el.closest("[data-max], [data-max-selections], [aria-multiselectable]");
  if (!container) return undefined;
  if (container.getAttribute("aria-multiselectable") === "false") return 1;

  const raw = container.getAttribute("data-max") ?? container.getAttribute("data-max-selections");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const nativeCheckboxAdapter: WidgetAdapter = {
  name: "native-checkbox",
  selector: "input[type='checkbox']",

  match(el) {
    return el instanceof HTMLInputElement && inputTypeOf(el) === "checkbox";
  },

  describe(el, ctx) {
    const control = el as HTMLInputElement;
    const labelText = labelOf(control);
    const common = ctx.commonParts(control);

    const container = control.closest("fieldset, [role='group'], [data-checkbox-group]");
    const checkboxGroupKey = container
      ? `c:${common.groupKey ?? "group"}`
      : control.name
        ? `n:${control.name}`
        : `p:${common.groupKey ?? "none"}`;

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(control, {
          tag: "input",
          inputType: "checkbox",
          name: control.name,
          id: control.id,
          labelText,
        }),
        tag: "input",
        kind: "checkbox",
        inputType: "checkbox",
        name: control.name || undefined,
        id: control.id || undefined,
        labelText: labelText ?? common.labelText,
        required: control.required || common.required,
        currentValue: String(control.checked),
        disabled: isDisabled(control),
        visible: ctx.isVisible(control),
        checkboxGroupKey,
        maxSelections: declaredMaxSelections(control),
      },
      elements: [control],
    };
  },

  read(instance) {
    return String((instance.elements[0] as HTMLInputElement).checked);
  },

  async apply(instance, value) {
    const el = instance.elements[0] as HTMLInputElement;
    const expected = resolveBooleanValue(value);
    if (expected === null) return { success: false, reason: `not a boolean: "${value}"` };

    if (!(await setCheckedState(el, expected))) {
      return { success: false, reason: "the checkbox would not stay toggled" };
    }
    return { success: true, appliedValue: String(expected) };
  },
};

// ---------------------------------------------------------------------------
// Radio groups
// ---------------------------------------------------------------------------

function radioGroupMembers(el: HTMLInputElement): HTMLInputElement[] {
  if (!el.name) return [el];
  const scope = el.closest("form") ?? document.body;
  const selector = `input[type="radio"][name="${CSS.escape(el.name)}"]`;
  const inScope = Array.from(scope.querySelectorAll<HTMLInputElement>(selector));
  return inScope.length > 0 ? inScope : [el];
}

export const nativeRadioGroupAdapter: WidgetAdapter = {
  name: "native-radio",
  selector: "input[type='radio']",

  match(el) {
    return el instanceof HTMLInputElement && inputTypeOf(el) === "radio";
  },

  describe(el, ctx) {
    const anchor = el as HTMLInputElement;
    const members = radioGroupMembers(anchor);
    const usable = members.filter((radio) => ctx.isVisible(radio) && !isDisabled(radio));
    const representative = usable[0] ?? anchor;

    const choices: FieldOption[] = (usable.length > 0 ? usable : members).map((radio, index) => ({
      value: radio.value,
      label: labelOf(radio) || radio.value || `option ${index + 1}`,
    }));

    const groupContainer = representative.closest("fieldset, [role='radiogroup'], [role='group']");
    const legend = groupContainer?.querySelector("legend");
    const labelText =
      cleanText(legend?.textContent) ||
      (groupContainer ? resolveAriaLabel(groupContainer) : undefined) ||
      labelOf(representative);

    const common = ctx.commonParts(representative);

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(representative, {
          tag: "input",
          inputType: "radio",
          name: anchor.name,
          groupName: anchor.name,
          labelText,
          optionSignature: optionSignatureOf(choices),
        }),
        tag: "input",
        kind: "radio",
        inputType: "radio",
        name: anchor.name || undefined,
        labelText: labelText ?? common.labelText,
        required: members.some((radio) => radio.required) || common.required,
        radioGroup: anchor.name || undefined,
        radioChoices: choices,
        currentValue: members.find((radio) => radio.checked)?.value ?? "",
        disabled: members.every(isDisabled),
        visible: members.some((radio) => ctx.isVisible(radio)),
      },
      elements: members,
    };
  },

  read(instance) {
    const members = instance.elements as HTMLInputElement[];
    return members.find((radio) => radio.checked)?.value ?? "";
  },

  async apply(instance, value) {
    const members = instance.elements as HTMLInputElement[];
    const usable = members.filter((radio) => !isDisabled(radio));
    if (usable.length === 0) return { success: false, reason: "no selectable radio in the group" };

    const choices = usable.map((radio, index) => ({
      value: radio.value,
      label: labelOf(radio) || radio.value || `option ${index + 1}`,
    }));

    const resolved = resolveOptionValue(choices, value);
    if (resolved === null) return { success: false, reason: `no option matches "${value}"` };

    const target = usable.find((radio) => radio.value === resolved);
    if (!target) return { success: false, reason: "resolved option has no element" };

    if (!(await setCheckedState(target, true))) {
      return { success: false, reason: "the radio would not stay selected" };
    }
    return { success: true, appliedValue: resolved };
  },
};

// ---------------------------------------------------------------------------
// Selects
// ---------------------------------------------------------------------------

export const nativeSelectAdapter: WidgetAdapter = {
  name: "native-select",
  selector: "select",

  match(el) {
    return el instanceof HTMLSelectElement;
  },

  describe(el, ctx) {
    const control = el as HTMLSelectElement;
    const options: FieldOption[] = Array.from(control.options).map((option) => ({
      value: option.value,
      label: cleanText(option.textContent) || option.value,
    }));

    const labelText = labelOf(control);
    const common = ctx.commonParts(control);

    return {
      descriptor: {
        ...common,
        syntheticId: ctx.allocateSid(control, {
          tag: "select",
          name: control.name,
          id: control.id,
          labelText,
          optionSignature: optionSignatureOf(options),
        }),
        tag: "select",
        kind: "select",
        inputType: control.multiple ? "select-multiple" : "select-one",
        name: control.name || undefined,
        id: control.id || undefined,
        autoComplete: control.autocomplete || undefined,
        labelText: labelText ?? common.labelText,
        required: control.required || common.required,
        options,
        currentValue: control.value,
        disabled: isDisabled(control),
        visible: ctx.isVisible(control),
      },
      elements: [control],
    };
  },

  read(instance) {
    return (instance.elements[0] as HTMLSelectElement).value;
  },

  async apply(instance, value) {
    const el = instance.elements[0] as HTMLSelectElement;
    const options = Array.from(el.options).map((option) => ({
      value: option.value,
      label: cleanText(option.textContent) || option.value,
    }));

    const resolved = resolveOptionValue(options, value);
    if (resolved === null) return { success: false, reason: `no option matches "${value}"` };

    setNativeValue(el, resolved);
    fireInputAndChange(el);
    await nextFrame();

    if (el.value !== resolved) return { success: false, reason: "the page reverted the selection" };
    return { success: true, appliedValue: resolved };
  },
};

export const NATIVE_ADAPTERS: WidgetAdapter[] = [
  nativeRadioGroupAdapter,
  nativeCheckboxAdapter,
  nativeSelectAdapter,
  nativeTextAdapter,
];

export { NON_FILLABLE_INPUT_TYPES, isDisabled as isControlDisabled };
