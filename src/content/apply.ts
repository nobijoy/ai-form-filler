import type { ApplyTarget } from "./scan";

function dispatchInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

/**
 * Apply a checked/unchecked state to a checkbox element.
 *
 * Direct assignment (`el.checked = x`) is intercepted by React / Vue / Svelte
 * because those frameworks install their own property descriptor on the instance
 * or rely on virtual-DOM reconciliation.  Using the native prototype setter
 * bypasses framework interception and lets the subsequent synthetic events
 * propagate through the framework's root-level event delegation layer so the
 * controlled component's onChange fires and updates its internal state.
 *
 * Events are only dispatched when the checked state actually changes to avoid
 * spurious re-renders.
 *
 * Returns true when the checkbox state was changed; false when it was already
 * correct and no events were dispatched.
 */
function applyCheckboxValue(el: HTMLInputElement, shouldCheck: boolean, sid: string): boolean {
  const prev = el.checked;

  if (prev === shouldCheck) {
    console.debug("[AI Form Filler] checkbox: already correct, skipping", {
      sid,
      checked: prev,
    });
    return false;
  }

  // Retrieve the native setter from the prototype rather than the element
  // instance so framework-installed descriptors are bypassed.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "checked",
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, shouldCheck);
  } else {
    el.checked = shouldCheck;
  }

  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

  console.debug("[AI Form Filler] checkbox: applied", {
    sid,
    prev,
    now: el.checked,
    shouldCheck,
    usedNativeSetter: !!nativeSetter,
    eventsDispatched: ["input", "change"],
  });

  return true;
}

export function applyValuesToTargets(
  targets: Map<string, ApplyTarget>,
  values: Record<string, string>,
): void {
  for (const [sid, value] of Object.entries(values)) {
    const t = targets.get(sid);

    if (!t) {
      console.debug("[AI Form Filler] apply: no DOM target for sid", { sid, value });
      continue;
    }

    if (t.type === "radio") {
      const match = t.inputs.find((i) => i.value === value);
      if (match && !match.disabled) {
        match.checked = true;
        dispatchInputEvents(match);
        match.dispatchEvent(new Event("click", { bubbles: true }));
      }
      continue;
    }

    const el = t.el;

    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();

      if (type === "checkbox") {
        const shouldCheck = value === "true";
        console.debug("[AI Form Filler] checkbox: attempting apply", {
          sid,
          returnedValue: value,
          shouldCheck,
          currentChecked: el.checked,
          elementId: el.id || "(none)",
          elementName: el.name || "(none)",
        });
        applyCheckboxValue(el, shouldCheck, sid);
        continue;
      }

      el.value = value;
      dispatchInputEvents(el);
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      continue;
    }

    if (el instanceof HTMLTextAreaElement) {
      el.value = value;
      dispatchInputEvents(el);
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      continue;
    }

    if (el instanceof HTMLSelectElement) {
      el.value = value;
      dispatchInputEvents(el);
      continue;
    }
  }
}
