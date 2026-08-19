/**
 * Low-level DOM primitives shared by every widget adapter.
 */

export function cleanText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function textFromIds(ids: string): string {
  return ids
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => cleanText(document.getElementById(id)?.textContent))
    .filter(Boolean)
    .join(" ");
}

export function resolveAriaLabel(el: Element): string | undefined {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = textFromIds(labelledBy);
    if (text) return text;
  }
  const aria = el.getAttribute("aria-label");
  return aria ? cleanText(aria) : undefined;
}

export function associatedLabelText(el: Element): string {
  const id = el.getAttribute("id");
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return cleanText(label.textContent);
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement;
    for (const nested of Array.from(clone.querySelectorAll("input,textarea,select,[role]"))) {
      nested.remove();
    }
    return cleanText(clone.textContent);
  }
  return "";
}

const CAPTION_TAG = /^(LABEL|SPAN|P|DT|DIV|H[1-6]|LEGEND|TH|TD)$/i;

function shortCaption(node: Element | null): string {
  if (!node) return "";
  if (node.querySelector("input, textarea, select")) return "";
  const text = cleanText(node.textContent);
  return text && text.length > 0 && text.length <= 60 ? text : "";
}

/**
 * Visible caption sitting next to a control that is not wired with <label for>.
 * Svelte date pickers nest the <input> inside extra wrappers, so the caption
 * (適用開始日 / 適用終了日) usually lives on an ancestor row, not a sibling.
 */
export function nearbyLabelText(el: HTMLElement): string {
  const row = el.closest("tr");
  if (row) {
    const header = row.querySelector("th, [role='rowheader']");
    const headerText = cleanText(header?.textContent);
    if (headerText && headerText.length <= 60) return headerText;
  }

  let cursor: HTMLElement | null = el;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    let sibling = cursor.previousElementSibling;
    for (let hop = 0; hop < 3 && sibling; hop += 1) {
      if (sibling.matches("input, textarea, select, button")) {
        sibling = sibling.previousElementSibling;
        continue;
      }
      const text = shortCaption(sibling) || (CAPTION_TAG.test(sibling.tagName) ? cleanText(sibling.textContent) : "");
      if (text && text.length > 0 && text.length <= 60 && !sibling.querySelector("input, textarea, select")) {
        return text;
      }
      sibling = sibling.previousElementSibling;
    }

    const host: HTMLElement | null = cursor.parentElement;
    if (!host || host.tagName === "FORM" || host.tagName === "BODY" || host.tagName === "MAIN") break;
    for (const child of Array.from(host.children) as HTMLElement[]) {
      if (child === cursor || child.contains(cursor)) continue;
      if (!CAPTION_TAG.test(child.tagName)) continue;
      const text = shortCaption(child);
      if (text) return text;
    }
    cursor = host;
  }
  return "";
}

/**
 * Writes through the prototype setter so React's value tracker sees a real
 * change rather than a no-op it can discard.
 */
export function setNativeValue(el: HTMLElement, value: string): void {
  const descriptor =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value") ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set) descriptor.set.call(el, value);
  else (el as HTMLInputElement).value = value;
}

export function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const descriptor =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "checked") ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
  if (descriptor?.set) descriptor.set.call(el, checked);
  else el.checked = checked;
}

export function fireInputAndChange(el: HTMLElement): void {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

/** Full pointer sequence; ARIA widgets often listen for mousedown, not click. */
export function simulateClick(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

export function pressKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
