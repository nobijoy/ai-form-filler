/**
 * Interactive UI that goes beyond field writes: picking a search-result row,
 * and looping "Add product" dialogs when the user's custom request asks for it.
 */

import { resolveOptionValue, normalizeForMatch } from "../shared/optionMatch";
import type { ExtensionSettings, FieldDescriptor } from "../shared/types";
import { applyValuesToInstances } from "./apply";
import { getUnresolvedCandidates } from "./candidates";
import { buildChunks } from "./chunking";
import { waitForDomQuiet, waitForNewFields, settle } from "./settle";
import { scanFormFields } from "./scan";
import { validateAiResponse } from "./validate";
import { cleanText, simulateClick } from "./widgets/dom";
import type { RunState } from "./runState";

const SEARCH_LABEL =
  /search|lookup|find|query|customer|client|会員|检索|検索|검색|buscar|chercher|suchen/i;

const ADD_PRODUCT =
  /add\s*(a\s+)?product|new\s+product|create\s+product|ajouter.*produit|produkt\s+hinzufügen|商品を追加|製品を追加/i;

const DIALOG_CONFIRM =
  /^(add|save|create|confirm|ok|submit|done|insert|ajouter|enregistrer|speichern|作成|追加|保存)$/i;

const DIALOG_DISMISS = /cancel|close|dismiss|annuler|abbrechen|キャンセル|閉じる/i;

export function isSearchLikeField(field: FieldDescriptor): boolean {
  if (field.kind === "aria-combobox") return true;
  if (field.inputType === "search") return true;
  if ((field.autoComplete || "").toLowerCase() === "off" && SEARCH_LABEL.test(fieldIdentity(field))) {
    return true;
  }
  return SEARCH_LABEL.test(fieldIdentity(field));
}

function fieldIdentity(field: FieldDescriptor): string {
  return [field.labelText, field.ariaLabel, field.name, field.id, field.placeholder, field.formPurpose]
    .filter(Boolean)
    .join(" ");
}

function rowLabel(el: HTMLElement): string {
  return cleanText(el.getAttribute("aria-label") || el.textContent).slice(0, 200);
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function collectResultRows(anchor: HTMLElement | null): HTMLElement[] {
  const roots: Element[] = [];

  if (anchor) {
    const owned =
      anchor.getAttribute("aria-controls") ||
      anchor.getAttribute("aria-owns") ||
      anchor.getAttribute("aria-activedescendant");
    if (owned) {
      for (const id of owned.split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (node) roots.push(node);
      }
    }
    const listbox =
      anchor.parentElement?.querySelector("[role='listbox'], [role='grid'], [role='tree']") ??
      null;
    if (listbox) roots.push(listbox);
  }

  // Prefer containers near the search field, then fall back to the page.
  roots.push(
    ...Array.from(
      document.querySelectorAll(
        "[role='listbox'], [role='grid'], table tbody, [data-search-results], .search-results, .autocomplete-results, .suggestions",
      ),
    ),
  );

  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const root of roots) {
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        "[role='option'], [role='row'], tr, li, [data-customer-id], [data-id]",
      ),
    );
    for (const el of candidates) {
      if (seen.has(el) || !isVisible(el)) continue;
      // Skip header rows and empty scaffolding.
      if (el.tagName === "TR" && el.parentElement?.tagName === "THEAD") continue;
      const label = rowLabel(el);
      if (label.length < 2) continue;
      seen.add(el);
      rows.push(el);
    }
  }

  return rows;
}

function matchRow(rows: HTMLElement[], needles: string[]): HTMLElement | null {
  const options = rows.map((row, index) => ({
    value: String(index),
    label: rowLabel(row),
  }));

  for (const needle of needles) {
    const trimmed = needle.trim();
    if (!trimmed) continue;
    const resolved = resolveOptionValue(options, trimmed);
    if (resolved !== null) {
      const index = Number(resolved);
      if (Number.isFinite(index) && rows[index]) return rows[index];
    }

    // Fallback: unique containment after normalize.
    const norm = normalizeForMatch(trimmed);
    if (norm.length < 2) continue;
    const hits = rows.filter((row) => normalizeForMatch(rowLabel(row)).includes(norm));
    if (hits.length === 1) return hits[0];
  }

  // If the typed query filtered the list to a single row, take it.
  if (rows.length === 1) return rows[0];
  return null;
}

function needlesForSearch(
  appliedValue: string,
  settings: ExtensionSettings,
  identity: Record<string, string>,
): string[] {
  const fromCustom: string[] = [];
  const custom = settings.customRequest;
  const quoted = /['"]([^'"]{2,80})['"]/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(custom))) fromCustom.push(match[1]);

  const nameHint =
    /(?:customer|client|user|name)\s+(?:name\s+)?['"]?([A-Za-z][\w .'-]{1,60})['"]?/i.exec(custom);
  if (nameHint) fromCustom.push(nameHint[1]);

  return Array.from(
    new Set(
      [appliedValue, ...fromCustom, identity.fullName, identity.firstName, identity.email].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );
}

/**
 * After a search-like field is written, wait for a results list/table and click
 * the best matching row.
 */
export async function pickSearchResults(params: {
  settings: ExtensionSettings;
  applied: { field: FieldDescriptor; value: string; el?: HTMLElement }[];
  identity: Record<string, string>;
  onStatus?: (message: string) => void;
}): Promise<number> {
  let picked = 0;

  for (const entry of params.applied) {
    if (!isSearchLikeField(entry.field)) continue;

    const needles = needlesForSearch(entry.value, params.settings, params.identity);
    params.onStatus?.(
      `Looking for a search result matching "${needles[0] ?? entry.value}"…`,
    );

    // Give typeahead time to fetch; keep focus on the field when possible.
    if (entry.el instanceof HTMLElement) {
      entry.el.focus({ preventScroll: true });
      entry.el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    }

    const rows = await waitForNewFields(
      () => {
        const found = collectResultRows(entry.el ?? null);
        return found.length > 0 ? found : null;
      },
      {
        timeoutMs: 6000,
        intervalMs: Math.max(150, params.settings.settleMs),
        quietMs: 100,
      },
    );

    if (!rows || rows.length === 0) {
      params.onStatus?.("No search results appeared after filling the search field.");
      continue;
    }

    const target = matchRow(rows, needles);
    if (!target) {
      params.onStatus?.(
        `Found ${rows.length} result(s), but none uniquely matched "${needles.join('" / "')}".`,
      );
      continue;
    }

    target.scrollIntoView({ block: "nearest" });
    simulateClick(target);
    picked += 1;
    params.onStatus?.(`Selected search result: "${rowLabel(target).slice(0, 80)}".`);
    await waitForDomQuiet({
      quietMs: Math.max(150, params.settings.settleMs),
      timeoutMs: 3000,
    });
  }

  return picked;
}

/** How many product dialogs to open, derived from the free-text custom request. */
export function parseProductAddCount(customRequest: string): number {
  const text = customRequest.trim();
  if (!text) return 0;

  const numbered = /add\s+(\d+)\s+products?/i.exec(text);
  if (numbered) {
    const count = Number(numbered[1]);
    return Number.isFinite(count) ? Math.min(10, Math.max(0, Math.round(count))) : 0;
  }

  if (/add\s+(a\s+|one\s+)?product/i.test(text) || (/products?/i.test(text) && /add/i.test(text))) {
    return 1;
  }

  return 0;
}

function findAddProductControl(): HTMLElement | null {
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, a[role='button'], [role='button'], input[type='button'], a",
    ),
  ).filter(isVisible);

  for (const el of controls) {
    const label = cleanText(
      `${el.getAttribute("aria-label") || ""} ${el.textContent || ""} ${el.getAttribute("title") || ""}`,
    );
    if (ADD_PRODUCT.test(label)) return el;
  }
  return null;
}

function openDialogs(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[role='dialog'], dialog[open], .modal.show, .modal[aria-modal='true'], [aria-modal='true']",
    ),
  ).filter(isVisible);
}

function findDialogConfirm(dialog: HTMLElement): HTMLElement | null {
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>("button, [role='button'], input[type='submit'], input[type='button']"),
  ).filter(isVisible);

  const ranked = controls
    .map((el) => {
      const label = cleanText(
        `${el.getAttribute("aria-label") || ""} ${el.textContent || ""} ${(el as HTMLInputElement).value || ""}`,
      );
      let score = 0;
      if (DIALOG_CONFIRM.test(label)) score += 5;
      if (ADD_PRODUCT.test(label)) score += 3;
      if (DIALOG_DISMISS.test(label)) score -= 10;
      if ((el as HTMLButtonElement).type === "submit") score += 2;
      return { el, score, label };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.el ?? null;
}

type LlmFillFn = (fields: FieldDescriptor[]) => Promise<Record<string, string>>;

/**
 * Opens "Add product" dialogs and fills them the requested number of times.
 * Relies on the same apply/validate path as a normal step.
 */
export async function runProductDialogLoop(params: {
  settings: ExtensionSettings;
  state: RunState;
  count: number;
  requestLlmFill: LlmFillFn;
  onStatus?: (message: string) => void;
}): Promise<number> {
  let created = 0;

  for (let index = 0; index < params.count; index++) {
    const addBtn = findAddProductControl();
    if (!addBtn) {
      params.onStatus?.(
        index === 0
          ? 'No "Add product" control found on this step.'
          : `Created ${created} product(s); no further Add product control.`,
      );
      break;
    }

    params.onStatus?.(`Opening Add product dialog (${index + 1}/${params.count})…`);
    const before = openDialogs();
    simulateClick(addBtn);

    const dialog = await waitForNewFields(
      () => {
        const now = openDialogs();
        const fresh = now.find((node) => !before.includes(node)) ?? now[now.length - 1];
        return fresh && isVisible(fresh) ? fresh : null;
      },
      { timeoutMs: 5000, intervalMs: 150, quietMs: 80 },
    );

    if (!dialog) {
      params.onStatus?.("Add product dialog did not appear.");
      break;
    }

    await waitForDomQuiet({ quietMs: Math.max(120, params.settings.settleMs), timeoutMs: 2500 });

    const scan = scanFormFields();
    const dialogFields = scan.fields.filter((field) => {
      const instance = scan.instances.get(field.syntheticId);
      const el = instance?.elements[0];
      return !!el && dialog.contains(el);
    });

    const candidates = getUnresolvedCandidates(
      dialogFields,
      params.settings,
      params.state.appliedValues,
    );

    if (candidates.length > 0) {
      // Prefer AI for dialog variety; still honour heuristics-only.
      let values: Record<string, string> = {};
      if (params.settings.fillMode !== "heuristics_only") {
        // Chunk if the dialog is large, but usually one shot is enough.
        const chunk = buildChunks(candidates)[0];
        const target = chunk
          ? candidates.filter((field) => chunk.fieldSids.includes(field.syntheticId))
          : candidates;
        values = await params.requestLlmFill(target);
      }

      const { valid } = validateAiResponse(values, candidates, params.state.appliedValues);
      if (Object.keys(valid).length > 0) {
        const result = await applyValuesToInstances(scan.instances, valid, {
          settleMs: params.settings.settleMs,
        });
        const bySid = new Map(candidates.map((field) => [field.syntheticId, field]));
        for (const [sid, value] of Object.entries(result.applied)) {
          params.state.recordApplied(bySid.get(sid), sid, value);
        }
        params.onStatus?.(
          `Filled ${Object.keys(result.applied).length} field(s) in product dialog ${index + 1}.`,
        );
      }
    }

    const confirm = findDialogConfirm(dialog);
    if (!confirm) {
      params.onStatus?.("Could not find a confirm/save button in the product dialog.");
      break;
    }

    simulateClick(confirm);
    created += 1;
    await settle(Math.max(200, params.settings.settleMs));
    await waitForDomQuiet({ quietMs: 150, timeoutMs: 4000 });
  }

  return created;
}
