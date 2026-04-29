import type { FieldDescriptor, FieldOption } from "../shared/types";

const elementIds = new WeakMap<Element, string>();
let idCounter = 0;

function syntheticIdFor(el: Element): string {
  let id = elementIds.get(el);
  if (!id) {
    id = `f_${++idCounter}`;
    elementIds.set(el, id);
  }
  return id;
}

export type ApplyTarget =
  | { type: "single"; el: HTMLElement }
  | { type: "radio"; inputs: HTMLInputElement[] };

export interface ScanResult {
  fields: FieldDescriptor[];
  targets: Map<string, ApplyTarget>;
}

function resolveLang(el: Element): string | undefined {
  let cur: Element | null = el;
  while (cur) {
    const lang = cur.getAttribute("lang");
    if (lang) return lang.trim();
    cur = cur.parentElement;
  }
  return undefined;
}

function textFromIds(ids: string): string {
  const parts = ids.split(/\s+/).filter(Boolean);
  const texts: string[] = [];
  for (const id of parts) {
    const node = document.getElementById(id);
    if (node) texts.push(node.textContent?.trim() || "");
  }
  return texts.filter(Boolean).join(" ");
}

function associatedLabelText(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (input.id) {
    const lab = input.ownerDocument.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lab) return lab.textContent?.trim() || "";
  }
  const parent = input.closest("label");
  if (parent) {
    const clone = parent.cloneNode(true) as HTMLElement;
    const nested = clone.querySelector("input,textarea,select");
    nested?.remove();
    return clone.textContent?.trim() || "";
  }
  return "";
}

function isVisible(el: HTMLElement): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
    return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && el.tagName !== "INPUT") {
    return false;
  }
  return true;
}

function gatherOptions(sel: HTMLSelectElement): FieldOption[] {
  return Array.from(sel.options).map((o) => ({
    value: o.value,
    label: (o.textContent || o.value).trim(),
  }));
}

function gatherRadios(groupName: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(groupName)}"]`),
  );
}

const scannedRadioGroups = new Set<string>();

export function scanFormFields(): ScanResult {
  const fields: FieldDescriptor[] = [];
  const targets = new Map<string, ApplyTarget>();
  scannedRadioGroups.clear();

  const selectors = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    "textarea",
    "select",
  ].join(",");

  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selectors));

  for (const el of nodes) {
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      const t = (input.type || "text").toLowerCase();
      if (t === "radio") {
        const name = input.name;
        if (!name || scannedRadioGroups.has(name)) continue;
        scannedRadioGroups.add(name);
        const radios = gatherRadios(name);
        const choices: FieldOption[] = radios.map((r) => ({
          value: r.value,
          label: associatedLabelText(r) || r.value || "option",
        }));
        const first = radios[0];
        if (!first) continue;
        const sid = syntheticIdFor(first);
        targets.set(sid, { type: "radio", inputs: radios });
        const checked = radios.find((r) => r.checked);
        fields.push({
          syntheticId: sid,
          tag: "input",
          inputType: "radio",
          name: name,
          id: first.id || undefined,
          required: first.required,
          ariaLabel: first.getAttribute("aria-label") || undefined,
          labelText: associatedLabelText(first) || undefined,
          radioGroup: name,
          radioChoices: choices,
          currentValue: checked?.value ?? "",
          disabled: radios.every((r) => r.disabled),
          visible: radios.some((r) => isVisible(r)),
          fieldLocale: resolveLang(first),
        });
        continue;
      }

      if (
        t === "hidden" ||
        t === "submit" ||
        t === "button" ||
        t === "reset" ||
        t === "image" ||
        t === "file"
      ) {
        continue;
      }

      const ariaLabelledby = input.getAttribute("aria-labelledby");
      let ariaLabel = input.getAttribute("aria-label") || undefined;
      if (ariaLabelledby) {
        const fromIds = textFromIds(ariaLabelledby);
        if (fromIds) ariaLabel = fromIds;
      }

      const sid = syntheticIdFor(input);
      targets.set(sid, { type: "single", el: input });
      const valueForDescriptor =
        t === "checkbox" ? (input.checked ? "true" : "false") : input.value;
      fields.push({
        syntheticId: sid,
        tag: "input",
        inputType: t,
        name: input.name || undefined,
        id: input.id || undefined,
        placeholder: input.placeholder || undefined,
        required: input.required,
        pattern: input.pattern || undefined,
        maxLength: input.maxLength > 0 ? input.maxLength : undefined,
        autoComplete: input.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(input) || undefined,
        currentValue: valueForDescriptor,
        disabled: input.disabled,
        visible: isVisible(input),
        fieldLocale: resolveLang(input),
      });
      continue;
    }

    if (el.tagName === "TEXTAREA") {
      const ta = el as HTMLTextAreaElement;
      const ariaLabelledby = ta.getAttribute("aria-labelledby");
      let ariaLabel = ta.getAttribute("aria-label") || undefined;
      if (ariaLabelledby) {
        const fromIds = textFromIds(ariaLabelledby);
        if (fromIds) ariaLabel = fromIds;
      }
      const sid = syntheticIdFor(ta);
      targets.set(sid, { type: "single", el: ta });
      fields.push({
        syntheticId: sid,
        tag: "textarea",
        name: ta.name || undefined,
        id: ta.id || undefined,
        placeholder: ta.placeholder || undefined,
        required: ta.required,
        maxLength: ta.maxLength > 0 ? ta.maxLength : undefined,
        autoComplete: ta.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(ta) || undefined,
        currentValue: ta.value,
        disabled: ta.disabled,
        visible: isVisible(ta),
        fieldLocale: resolveLang(ta),
      });
      continue;
    }

    if (el.tagName === "SELECT") {
      const sel = el as HTMLSelectElement;
      const ariaLabelledby = sel.getAttribute("aria-labelledby");
      let ariaLabel = sel.getAttribute("aria-label") || undefined;
      if (ariaLabelledby) {
        const fromIds = textFromIds(ariaLabelledby);
        if (fromIds) ariaLabel = fromIds;
      }
      const sid = syntheticIdFor(sel);
      targets.set(sid, { type: "single", el: sel });
      fields.push({
        syntheticId: sid,
        tag: "select",
        name: sel.name || undefined,
        id: sel.id || undefined,
        required: sel.required,
        autoComplete: sel.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(sel) || undefined,
        options: gatherOptions(sel),
        currentValue: sel.value,
        disabled: sel.disabled,
        visible: isVisible(sel),
        fieldLocale: resolveLang(sel),
      });
    }
  }

  return { fields, targets };
}

export function resolveDocumentLocale(): string {
  const htmlLang = document.documentElement.lang?.trim();
  if (htmlLang) return htmlLang;
  return navigator.language || "unknown";
}

export function resolveFillLocale(
  policy: "auto" | "override",
  override: string,
  docLocale: string,
): string {
  if (policy === "override" && override.trim()) return override.trim();
  return docLocale;
}
