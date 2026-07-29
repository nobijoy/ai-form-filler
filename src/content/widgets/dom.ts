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
