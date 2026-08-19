import type { FieldDescriptor } from "../shared/types";
import { isFillableField } from "../shared/fillable";
import { FieldIdAllocator, type FieldIdentityParts } from "./fieldId";
import { WIDGET_SELECTOR, adapterFor, adapterForInstance } from "./widgets";
import type { CommonDescriptorParts, DescribeContext, WidgetInstance } from "./widgets/types";
import { associatedLabelText, cleanText, nearbyLabelText, resolveAriaLabel, textFromIds } from "./widgets/dom";
import { controlLooksLikeDateStore, isNativeDateInputType, looksLikeDateField } from "../shared/dateField";

export interface ScanResult {
  fields: FieldDescriptor[];
  /** sid -> the live widget the applier drives. */
  instances: Map<string, WidgetInstance>;
}

const GROUP_CONTAINER_SELECTOR =
  "fieldset, [role='group'], [role='radiogroup'], [data-section], section";

const REQUIRED_LABEL_PATTERN =
  /(\*|obligatoire|requis|required|pflichtfeld|verplicht|必須|필수|obligatorio|必填)/i;

function isHiddenDateStore(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type.toLowerCase() !== "hidden") return false;
  return controlLooksLikeDateStore({
    type: el.type,
    name: el.name,
    id: el.id,
    placeholder: el.placeholder,
    value: el.value,
    className: el.className,
    pattern: el.pattern,
  });
}

function isTypedDateControl(el: HTMLElement): boolean {
  return el instanceof HTMLInputElement && isNativeDateInputType(el.type);
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export function isVisible(el: HTMLElement): boolean {
  if (!(el instanceof HTMLElement)) return false;

  const isFormControl =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement;
  const hiddenDateStore = isHiddenDateStore(el);
  const typedDateControl = isTypedDateControl(el);
  const allowHiddenSelf = hiddenDateStore || typedDateControl;

  let cur: HTMLElement | null = el;
  while (cur) {
    const onControl = cur === el;
    if (cur.hidden && !(allowHiddenSelf && onControl)) return false;
    if (cur.getAttribute("aria-hidden") === "true" && !(allowHiddenSelf && onControl)) {
      return false;
    }
    const style = window.getComputedStyle(cur);
    if (style.display === "none" && !(allowHiddenSelf && onControl)) return false;

    // Styled date pickers (Svelte, Flatpickr, etc.) hide the real <input> with
    // opacity 0 / visibility hidden / sr-only. Treat the control itself as
    // fillable; still skip a whole section that is actually hidden.
    const visuallyHiddenControl = isFormControl && onControl;
    if (!visuallyHiddenControl) {
      if (style.visibility === "hidden") return false;
      if (parseFloat(style.opacity) === 0) return false;
      if (style.contentVisibility === "hidden") return false;
    }
    cur = cur.parentElement;
  }

  // A zero-size input is still fillable: custom controls routinely hide the
  // native input behind a styled label.
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && !isFormControl) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Shared descriptor parts
// ---------------------------------------------------------------------------

function resolveLang(el: Element): string | undefined {
  let cur: Element | null = el;
  while (cur) {
    const lang = cur.getAttribute("lang");
    if (lang) return lang.trim();
    cur = cur.parentElement;
  }
  return undefined;
}

/**
 * Nearest ancestor text that reads as context for this control. Walking the
 * ancestor chain avoids the per-text-node layout reads a pixel-radius sweep
 * needs, and lands on more relevant copy.
 */
function contextTextFor(el: HTMLElement): string | undefined {
  let cur: HTMLElement | null = el.parentElement;
  let depth = 0;
  let best = "";

  while (cur && depth < 4) {
    if (cur.tagName === "FORM" || cur.tagName === "BODY") break;
    const text = cleanText(cur.textContent);
    if (text.length > best.length) best = text;
    if (best.length >= 240) break;
    cur = cur.parentElement;
    depth += 1;
  }

  const trimmed = best.slice(0, 400);
  return trimmed.length > 0 ? trimmed : undefined;
}

function precedingHeadings(): { el: HTMLElement; text: string }[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, legend, [role='heading']"),
  )
    .map((heading) => ({ el: heading, text: cleanText(heading.textContent) }))
    .filter((entry) => entry.text.length > 0);
}

function nearestPrecedingHeading(
  el: Element,
  headings: { el: HTMLElement; text: string }[],
): string | undefined {
  let best: string | undefined;
  for (const heading of headings) {
    const position = heading.el.compareDocumentPosition(el);
    if ((position & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue;
    best = heading.text;
  }
  return best;
}

function groupLabelFor(container: Element): string {
  const legendText = cleanText(container.querySelector("legend")?.textContent);
  if (legendText) return legendText.slice(0, 120);

  const aria = resolveAriaLabel(container);
  if (aria) return aria.slice(0, 120);

  const headingText = cleanText(
    container.querySelector("h1, h2, h3, h4, [role='heading']")?.textContent,
  );
  if (headingText) return headingText.slice(0, 120);

  return container.getAttribute("data-section")?.slice(0, 120) ?? "";
}

const REQUIRED_MARKER_SELECTOR =
  "[aria-hidden='true'].required, .required-mark, .is-required, .asterisk";

/**
 * Required-ness the markup implies without using the `required` attribute:
 * an aria flag, a marker class, or an asterisk in the visible label.
 */
function isRequiredByMarkup(el: Element, labelText: string): boolean {
  if (el.getAttribute("aria-required") === "true") return true;
  if (el.getAttribute("data-required") === "true") return true;
  if (el.classList.contains("required") || el.classList.contains("is-required")) return true;
  if (labelText && REQUIRED_LABEL_PATTERN.test(labelText)) return true;

  const host = el.closest("label, .field, .form-group, .form-item");
  return host?.querySelector(REQUIRED_MARKER_SELECTOR) != null;
}

/**
 * Text the field explicitly points at as its own description.
 *
 * Read unconditionally, because `aria-describedby` is the standard place a form
 * states a required format ("Format: 090-1234-5678"). Reading it only while the
 * field was already invalid meant the model never saw the format until after it
 * had guessed wrong.
 */
function resolveDescription(el: Element): string | undefined {
  const ids = el.getAttribute("aria-describedby");
  if (!ids) return undefined;
  const text = textFromIds(ids).slice(0, 200);
  return text || undefined;
}

function resolveValidationState(el: Element): { ariaInvalid: boolean; message?: string } {
  const ariaInvalid = el.getAttribute("aria-invalid") === "true";
  const messages: string[] = [];

  const errorMessageId = el.getAttribute("aria-errormessage");
  if (errorMessageId) {
    const text = textFromIds(errorMessageId);
    if (text) messages.push(text);
  }

  // While invalid, the described-by target is usually the error itself.
  if (ariaInvalid) {
    const described = resolveDescription(el);
    if (described) messages.push(described);
  }

  const container = el.closest(".field, .form-group, .form-item, label, li, td");
  const alertText = cleanText(
    container?.querySelector("[role='alert'], .error, .error-message, .invalid-feedback")
      ?.textContent,
  );
  if (alertText) messages.push(alertText);

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.validationMessage) messages.push(el.validationMessage);
  }

  const message = Array.from(new Set(messages)).join(" ").slice(0, 200);
  return { ariaInvalid, message: message || undefined };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function buildDescribeContext(): DescribeContext {
  const allocator = new FieldIdAllocator();
  const headings = precedingHeadings();
  const groupIds = new WeakMap<Element, string>();
  let groupCounter = 0;

  const groupIdFor = (container: Element): string => {
    let id = groupIds.get(container);
    if (!id) {
      id = `g${++groupCounter}`;
      groupIds.set(container, id);
    }
    return id;
  };

  const formPurposeFor = (el: HTMLElement): string | undefined => {
    const form = el.closest("form");
    if (form) {
      const formAria = resolveAriaLabel(form);
      if (formAria) return formAria;
      const headingText = cleanText(form.querySelector("h1, h2, legend")?.textContent);
      if (headingText) return headingText;
    }
    return nearestPrecedingHeading(el, headings) ?? cleanText(document.title) ?? undefined;
  };

  const commonParts = (el: HTMLElement): CommonDescriptorParts => {
    const ariaLabel = resolveAriaLabel(el);
    const labelText =
      associatedLabelText(el) || ariaLabel || nearbyLabelText(el) || undefined;
    const container = el.closest(GROUP_CONTAINER_SELECTOR);
    const heading = nearestPrecedingHeading(el, headings);
    const validation = resolveValidationState(el);

    const groupLabel = container ? groupLabelFor(container) || heading : heading;
    const groupKey = container
      ? groupIdFor(container)
      : heading
        ? `h:${heading.slice(0, 60)}`
        : undefined;

    return {
      labelText,
      ariaLabel,
      formPurpose: formPurposeFor(el),
      surroundingText: contextTextFor(el),
      describedByText: resolveDescription(el),
      fieldLocale: resolveLang(el),
      groupKey,
      groupLabel: groupLabel || undefined,
      ariaInvalid: validation.ariaInvalid,
      validationMessage: validation.message,
      required: isRequiredByMarkup(el, labelText ?? ""),
    };
  };

  return {
    allocateSid: (el: Element, parts: FieldIdentityParts) => allocator.allocate(el, parts),
    isVisible,
    commonParts,
  };
}

export function scanFormFields(): ScanResult {
  const ctx = buildDescribeContext();
  const fields: FieldDescriptor[] = [];
  const instances = new Map<string, WidgetInstance>();
  const consumed = new WeakSet<Element>();

  for (const el of Array.from(document.querySelectorAll<HTMLElement>(WIDGET_SELECTOR))) {
    if (consumed.has(el)) continue;
    // File inputs require a user-selected local file and must never be described
    // to the model, written, or counted as unresolved.
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === "file") continue;

    const adapter = adapterFor(el);
    if (!adapter) continue;

    const instance = adapter.describe(el, ctx);
    if (!instance) continue;

    // A group adapter owns several elements; none of them may be scanned again.
    for (const owned of instance.elements) consumed.add(owned);

    if (!isFillableField(instance.descriptor)) continue;

    instances.set(instance.descriptor.syntheticId, instance);
    fields.push(instance.descriptor);
  }

  tagDateWindows(fields);
  attachCheckboxDependentLinks(fields, instances);

  return { fields, instances };
}

function tagDateWindows(fields: FieldDescriptor[]): void {
  const dates = fields.filter((field) => looksLikeDateField(field));
  const byGroup = new Map<string, FieldDescriptor[]>();
  for (const field of dates) {
    const key = field.groupKey ?? "__ungrouped__";
    const list = byGroup.get(key);
    if (list) list.push(field);
    else byGroup.set(key, [field]);
  }
  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    group.forEach((field, index) => {
      field.dateWindow = index === 0 ? "start" : "end";
    });
  }
}

// ---------------------------------------------------------------------------
// Dependent text fields ("Other: ___" beside a checkbox)
// ---------------------------------------------------------------------------

const DEPENDENT_TEXT_HINTS =
  /その他|補足|詳細|理由|備考|other|additional|detail|supplement|remarks|notes|specify|please describe/i;
const LINK_CONTAINER_SELECTORS = ["label", "[role='group']", "fieldset", "li", "tr"];

function attachCheckboxDependentLinks(
  fields: FieldDescriptor[],
  instances: Map<string, WidgetInstance>,
): void {
  const checkboxFields = fields.filter(
    (field) => field.kind === "checkbox" || field.kind === "aria-checkbox",
  );
  if (checkboxFields.length === 0) return;

  const textFields = fields.filter(
    (field) =>
      field.kind === "textarea" ||
      field.kind === "contenteditable" ||
      (field.kind === "text" && (field.inputType === "text" || field.inputType === undefined)),
  );

  for (const textField of textFields) {
    const textEl = instances.get(textField.syntheticId)?.elements[0];
    if (!textEl) continue;

    const hintBlob = [textField.labelText, textField.placeholder, textField.ariaLabel]
      .filter(Boolean)
      .join(" ");

    let best: { sid: string; score: number } | null = null;

    for (const checkboxField of checkboxFields) {
      const checkboxEl = instances.get(checkboxField.syntheticId)?.elements[0];
      if (!checkboxEl) continue;

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
        const label: Element | null = document.querySelector(
          `label[for="${CSS.escape(checkboxEl.id)}"]`,
        );
        if (label && (label.contains(textEl) || textEl.closest("label") === label)) score += 50;
      }

      const checkboxBlob = [checkboxField.labelText, checkboxField.ariaLabel]
        .filter(Boolean)
        .join(" ");
      if (DEPENDENT_TEXT_HINTS.test(hintBlob) || DEPENDENT_TEXT_HINTS.test(checkboxBlob)) {
        score += 20;
      }

      if (!best || score > best.score) best = { sid: checkboxField.syntheticId, score };
    }

    if (best && best.score >= 50) textField.controllingCheckboxSid = best.sid;
  }
}

// ---------------------------------------------------------------------------
// Instance helpers
// ---------------------------------------------------------------------------

export function isInstanceFillable(instance: WidgetInstance): boolean {
  const usable = instance.elements.filter((el) => isVisible(el));
  if (usable.length === 0) return false;
  return !instance.descriptor.disabled;
}

/** Current DOM value in the same encoding the descriptor reports. */
export function readInstanceValue(instance: WidgetInstance): string {
  const adapter = adapterForInstance(instance);
  return adapter ? adapter.read(instance) : instance.descriptor.currentValue;
}

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

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
