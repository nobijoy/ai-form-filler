import type { ApplyTarget } from "./scan";

function dispatchInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

export function applyValuesToTargets(
  targets: Map<string, ApplyTarget>,
  values: Record<string, string>,
): void {
  for (const [id, value] of Object.entries(values)) {
    const t = targets.get(id);
    if (!t) continue;

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
        el.checked = value === "true" || value === "on" || value === "1";
        dispatchInputEvents(el);
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
