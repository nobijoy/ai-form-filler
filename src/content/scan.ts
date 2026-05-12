import type { FieldDescriptor, FieldOption } from "../shared/types";
import { isFillableField, NON_FILLABLE_INPUT_TYPES } from "../shared/fillable";

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

function isFieldRequired(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): boolean {
  if (el.required) return true;
  if (el.getAttribute("aria-required") === "true") return true;
  if (el.getAttribute("data-required") === "true") return true;
  if (el.classList.contains("required") || el.classList.contains("is-required")) return true;
  const label = associatedLabelText(el);
  if (label && /(?:\*|obligatoire|requis|required|pflichtfeld|verplicht)/i.test(label)) {
    return true;
  }
  return false;
}

function rectDistance(a: DOMRect, b: DOMRect): number {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return Math.hypot(dx, dy);
}

function nearestFormPurpose(el: HTMLElement): string | undefined {
  const form = el.closest("form");
  if (form) {
    const formAria = form.getAttribute("aria-label")?.trim();
    if (formAria) return formAria;
    const labelledBy = form.getAttribute("aria-labelledby");
    if (labelledBy) {
      const fromIds = textFromIds(labelledBy);
      if (fromIds) return fromIds;
    }
    const formHeading = form.querySelector<HTMLElement>("h1, h2, legend");
    if (formHeading?.textContent?.trim()) return formHeading.textContent.trim();
  }

  const targetRect = el.getBoundingClientRect();
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1, h2"));
  let best: { text: string; d: number } | null = null;
  for (const heading of headings) {
    const text = heading.textContent?.trim();
    if (!text) continue;
    const d = rectDistance(targetRect, heading.getBoundingClientRect());
    if (!best || d < best.d) best = { text, d };
  }
  return best?.text;
}

function surroundingTextWithin50px(el: HTMLElement): string | undefined {
  const targetRect = el.getBoundingClientRect();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const collected: string[] = [];

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const value = textNode.nodeValue?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const parentEl = textNode.parentElement;
    if (!parentEl) continue;
    if (parentEl === el || parentEl.contains(el) || el.contains(parentEl)) continue;
    if (!isVisible(parentEl)) continue;
    const d = rectDistance(targetRect, parentEl.getBoundingClientRect());
    if (d <= 50) collected.push(value);
    if (collected.length >= 8) break;
  }

  if (collected.length === 0) return undefined;
  return Array.from(new Set(collected)).join(" ").slice(0, 500);
}

function isVisible(el: HTMLElement): boolean {
  if (!(el instanceof HTMLElement)) return false;

  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.hidden) return false;
    if (cur.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(cur);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    cur = cur.parentElement;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && el.tagName !== "INPUT") {
    return false;
  }
  return true;
}

function isControlDisabled(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): boolean {
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  if ("readOnly" in el && (el as HTMLInputElement | HTMLTextAreaElement).readOnly) return true;
  if (el.closest("[inert]")) return true;
  return false;
}

function isNonFillableInputType(type: string): boolean {
  return NON_FILLABLE_INPUT_TYPES.has(type);
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
        const choices: FieldOption[] = radios
          .filter((r) => isVisible(r) && !isControlDisabled(r))
          .map((r) => ({
            value: r.value,
            label: associatedLabelText(r) || r.value || "option",
          }));
        const first = radios.find((r) => isVisible(r) && !isControlDisabled(r)) ?? radios[0];
        if (!first) continue;
        const sid = syntheticIdFor(first);
        const checked = radios.find((r) => r.checked);
        const descriptor: FieldDescriptor = {
          syntheticId: sid,
          tag: "input",
          inputType: "radio",
          name: name,
          id: first.id || undefined,
          required: isFieldRequired(first),
          ariaLabel: first.getAttribute("aria-label") || undefined,
          labelText: associatedLabelText(first) || first.getAttribute("aria-label") || undefined,
          formPurpose: nearestFormPurpose(first),
          surroundingText: surroundingTextWithin50px(first),
          radioGroup: name,
          radioChoices: choices,
          currentValue: checked?.value ?? "",
          disabled: radios.every((r) => isControlDisabled(r)),
          visible: radios.some((r) => isVisible(r)),
          fieldLocale: resolveLang(first),
        };
        if (!isFillableField(descriptor)) continue;
        targets.set(sid, { type: "radio", inputs: radios });
        fields.push(descriptor);
        continue;
      }

      if (isNonFillableInputType(t)) {
        continue;
      }

      const ariaLabelledby = input.getAttribute("aria-labelledby");
      let ariaLabel = input.getAttribute("aria-label") || undefined;
      if (ariaLabelledby) {
        const fromIds = textFromIds(ariaLabelledby);
        if (fromIds) ariaLabel = fromIds;
      }

      const sid = syntheticIdFor(input);
      const valueForDescriptor =
        t === "checkbox" ? (input.checked ? "true" : "false") : input.value;
      const descriptor: FieldDescriptor = {
        syntheticId: sid,
        tag: "input",
        inputType: t,
        name: input.name || undefined,
        id: input.id || undefined,
        placeholder: input.placeholder || undefined,
        required: isFieldRequired(input),
        pattern: input.pattern || undefined,
        maxLength: input.maxLength > 0 ? input.maxLength : undefined,
        autoComplete: input.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(input) || ariaLabel || undefined,
        formPurpose: nearestFormPurpose(input),
        surroundingText: surroundingTextWithin50px(input),
        currentValue: valueForDescriptor,
        disabled: isControlDisabled(input),
        visible: isVisible(input),
        fieldLocale: resolveLang(input),
      };
      if (!isFillableField(descriptor)) continue;
      targets.set(sid, { type: "single", el: input });
      fields.push(descriptor);
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
      const descriptor: FieldDescriptor = {
        syntheticId: sid,
        tag: "textarea",
        name: ta.name || undefined,
        id: ta.id || undefined,
        placeholder: ta.placeholder || undefined,
        required: isFieldRequired(ta),
        maxLength: ta.maxLength > 0 ? ta.maxLength : undefined,
        autoComplete: ta.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(ta) || ariaLabel || undefined,
        formPurpose: nearestFormPurpose(ta),
        surroundingText: surroundingTextWithin50px(ta),
        currentValue: ta.value,
        disabled: isControlDisabled(ta),
        visible: isVisible(ta),
        fieldLocale: resolveLang(ta),
      };
      if (!isFillableField(descriptor)) continue;
      targets.set(sid, { type: "single", el: ta });
      fields.push(descriptor);
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
      const descriptor: FieldDescriptor = {
        syntheticId: sid,
        tag: "select",
        name: sel.name || undefined,
        id: sel.id || undefined,
        required: isFieldRequired(sel),
        autoComplete: sel.autocomplete || undefined,
        ariaLabel,
        labelText: associatedLabelText(sel) || ariaLabel || undefined,
        formPurpose: nearestFormPurpose(sel),
        surroundingText: surroundingTextWithin50px(sel),
        options: gatherOptions(sel),
        currentValue: sel.value,
        disabled: isControlDisabled(sel),
        visible: isVisible(sel),
        fieldLocale: resolveLang(sel),
      };
      if (!isFillableField(descriptor)) continue;
      targets.set(sid, { type: "single", el: sel });
      fields.push(descriptor);
    }
  }

  attachCheckboxDependentLinks(fields, targets);

  return { fields, targets };
}

const DEPENDENT_TEXT_HINTS =
  /その他|補足|詳細|理由|備考|試用期間|other|additional|detail|supplement|remarks|notes|specify/i;
const LINK_CONTAINER_SELECTORS = ["label", '[role="group"]', "fieldset", "li", "tr", "div", "section"];

function elementForSid(targets: Map<string, ApplyTarget>, sid: string): HTMLElement | null {
  const target = targets.get(sid);
  return target?.type === "single" ? target.el : null;
}

function attachCheckboxDependentLinks(
  fields: FieldDescriptor[],
  targets: Map<string, ApplyTarget>,
): void {
  const checkboxFields = fields.filter((field) => field.inputType === "checkbox");
  const textFields = fields.filter(
    (field) =>
      field.tag === "textarea" ||
      (field.tag === "input" &&
        field.inputType !== "checkbox" &&
        field.inputType !== "radio" &&
        (!field.inputType || field.inputType === "text")),
  );

  for (const textField of textFields) {
    const textEl = elementForSid(targets, textField.syntheticId);
    if (!textEl) continue;

    const hintBlob = [
      textField.labelText,
      textField.placeholder,
      textField.ariaLabel,
      textField.surroundingText,
      textField.formPurpose,
    ]
      .filter(Boolean)
      .join(" ");

    let best: { sid: string; score: number } | null = null;
    const textRect = textEl.getBoundingClientRect();

    for (const checkboxField of checkboxFields) {
      const checkboxEl = elementForSid(targets, checkboxField.syntheticId);
      if (!(checkboxEl instanceof HTMLInputElement)) continue;

      let score = 0;

      for (const selector of LINK_CONTAINER_SELECTORS) {
        const textContainer: Element | null = textEl.closest(selector);
        const checkboxContainer: Element | null = checkboxEl.closest(selector);
        if (textContainer && textContainer === checkboxContainer) {
          score += 40;
          break;
        }
        if (textContainer?.contains(checkboxEl) || checkboxContainer?.contains(textEl)) {
          score += 30;
          break;
        }
      }

      if (checkboxEl.id) {
        const label = checkboxEl.ownerDocument.querySelector(
          `label[for="${CSS.escape(checkboxEl.id)}"]`,
        );
        if (label && (label.contains(textEl) || textEl.closest("label") === label)) {
          score += 50;
        }
      }

      const checkboxBlob = [checkboxField.labelText, checkboxField.ariaLabel]
        .filter(Boolean)
        .join(" ");
      if (DEPENDENT_TEXT_HINTS.test(hintBlob) || DEPENDENT_TEXT_HINTS.test(checkboxBlob)) {
        score += 20;
      }

      const distance = rectDistance(textRect, checkboxEl.getBoundingClientRect());
      if (distance <= 50) score += Math.max(0, 50 - distance);

      if (!best || score > best.score) best = { sid: checkboxField.syntheticId, score };
    }

    if (best && best.score >= 30) {
      textField.controllingCheckboxSid = best.sid;
      console.debug("[AI Form Filler] linked dependent text field", {
        textSid: textField.syntheticId,
        controllingCheckboxSid: best.sid,
        score: best.score,
      });
    }
  }
}

export function isApplyTargetFillable(target: ApplyTarget): boolean {
  if (target.type === "radio") {
    return target.inputs.some((input) => isVisible(input) && !isControlDisabled(input));
  }

  const el = target.el;
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    !(el instanceof HTMLSelectElement)
  ) {
    return false;
  }

  if (el instanceof HTMLInputElement && isNonFillableInputType((el.type || "text").toLowerCase())) {
    return false;
  }

  return isVisible(el) && !isControlDisabled(el);
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
