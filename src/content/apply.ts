import type { FieldDescriptor } from "../shared/types";
import type { ApplyTarget } from "./scan";
import { isApplyTargetFillable } from "./scan";

export interface ApplyFieldResult {
  sid: string;
  success: boolean;
  applyFailed?: boolean;
  usedClick?: boolean;
  checkedBefore?: boolean;
  checkedAfter?: boolean;
  checkedAfterRaf?: boolean;
}

export interface ApplyValuesResult {
  applied: Record<string, string>;
  failed: string[];
  results: ApplyFieldResult[];
}

function dispatchInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

function isCheckboxTarget(target: ApplyTarget): boolean {
  return (
    target.type === "single" &&
    target.el instanceof HTMLInputElement &&
    (target.el.type || "text").toLowerCase() === "checkbox"
  );
}

function partitionValues(
  values: Record<string, string>,
  targets: Map<string, ApplyTarget>,
): { checkboxes: Record<string, string>; others: Record<string, string> } {
  const checkboxes: Record<string, string> = {};
  const others: Record<string, string> = {};

  for (const [sid, value] of Object.entries(values)) {
    const target = targets.get(sid);
    if (target && isCheckboxTarget(target)) checkboxes[sid] = value;
    else others[sid] = value;
  }

  return { checkboxes, others };
}

async function applyCheckboxValue(
  el: HTMLInputElement,
  value: string,
  sid: string,
): Promise<ApplyFieldResult> {
  const expected = value === "true";
  const checkedBefore = el.checked;
  let usedClick = false;

  console.debug("[AI Form Filler] checkbox: attempting apply", {
    sid,
    returnedValue: value,
    expected,
    checkedBefore,
    elementId: el.id || "(none)",
    elementName: el.name || "(none)",
  });

  if (el.checked !== expected) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
    if (setter) setter.call(el, expected);
    else el.checked = expected;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    if (el.checked !== expected) {
      usedClick = true;
      el.click();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  const checkedAfterRaf = await new Promise<boolean>((resolve) => {
    requestAnimationFrame(() => resolve(el.checked));
  });
  const success = checkedAfterRaf === expected;

  console.debug("[AI Form Filler] checkbox: after requestAnimationFrame", {
    sid,
    checkedBefore,
    checkedAfterRaf,
    expected,
    usedClick,
    success,
  });

  if (!success) {
    console.debug("[AI Form Filler] checkbox: applyFailed", { sid, expected, checkedAfterRaf });
  }

  return {
    sid,
    success,
    applyFailed: !success,
    usedClick,
    checkedBefore,
    checkedAfter: el.checked,
    checkedAfterRaf,
  };
}

async function applyValuesBatch(
  targets: Map<string, ApplyTarget>,
  values: Record<string, string>,
): Promise<ApplyValuesResult> {
  const applied: Record<string, string> = {};
  const failed: string[] = [];
  const results: ApplyFieldResult[] = [];

  for (const [sid, value] of Object.entries(values)) {
    const t = targets.get(sid);

    if (!t) {
      console.debug("[AI Form Filler] apply: no DOM target for sid", { sid, value });
      failed.push(sid);
      results.push({ sid, success: false, applyFailed: true });
      continue;
    }

    if (!isApplyTargetFillable(t)) {
      console.debug("[AI Form Filler] apply: skipping non-fillable target", { sid, value });
      failed.push(sid);
      results.push({ sid, success: false, applyFailed: true });
      continue;
    }

    if (t.type === "radio") {
      const match = t.inputs.find(
        (i) => i.value === value && isApplyTargetFillable({ type: "single", el: i }),
      );
      if (match && !match.disabled) {
        match.checked = true;
        dispatchInputEvents(match);
        match.dispatchEvent(new Event("click", { bubbles: true }));
        applied[sid] = value;
        results.push({ sid, success: true });
      } else {
        failed.push(sid);
        results.push({ sid, success: false, applyFailed: true });
      }
      continue;
    }

    const el = t.el;

    if (el instanceof HTMLInputElement) {
      const type = (el.type || "text").toLowerCase();

      if (type === "checkbox") {
        const checkboxResult = await applyCheckboxValue(el, value, sid);
        results.push(checkboxResult);
        if (checkboxResult.success) applied[sid] = value;
        else failed.push(sid);
        continue;
      }

      el.value = value;
      dispatchInputEvents(el);
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      applied[sid] = value;
      results.push({ sid, success: true });
      continue;
    }

    if (el instanceof HTMLTextAreaElement) {
      el.value = value;
      dispatchInputEvents(el);
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      applied[sid] = value;
      results.push({ sid, success: true });
      continue;
    }

    if (el instanceof HTMLSelectElement) {
      el.value = value;
      dispatchInputEvents(el);
      applied[sid] = value;
      results.push({ sid, success: true });
    }
  }

  return { applied, failed, results };
}

function mergeApplyResults(base: ApplyValuesResult, next: ApplyValuesResult): ApplyValuesResult {
  return {
    applied: { ...base.applied, ...next.applied },
    failed: [...new Set([...base.failed, ...next.failed])],
    results: [...base.results, ...next.results],
  };
}

function filterDependentTextValues(
  values: Record<string, string>,
  fieldMap: Map<string, FieldDescriptor>,
  selectedCheckboxes: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [sid, value] of Object.entries(values)) {
    const field = fieldMap.get(sid);
    const controllerSid = field?.controllingCheckboxSid;
    if (controllerSid && selectedCheckboxes[controllerSid] !== "true") {
      console.debug("[AI Form Filler] apply: skipping dependent text without selected checkbox", {
        sid,
        controllerSid,
      });
      continue;
    }
    filtered[sid] = value;
  }

  return filtered;
}

export async function applyValuesToTargets(
  targets: Map<string, ApplyTarget>,
  values: Record<string, string>,
  options?: { settleMs?: number; fields?: FieldDescriptor[] },
): Promise<ApplyValuesResult> {
  const fieldMap = options?.fields
    ? new Map(options.fields.map((field) => [field.syntheticId, field]))
    : undefined;
  const { checkboxes, others } = partitionValues(values, targets);
  const selectedCheckboxes = { ...checkboxes };
  const filteredOthers = fieldMap ? filterDependentTextValues(others, fieldMap, selectedCheckboxes) : others;

  let result: ApplyValuesResult = { applied: {}, failed: [], results: [] };

  if (Object.keys(checkboxes).length > 0) {
    result = mergeApplyResults(result, await applyValuesBatch(targets, checkboxes));
  }

  if (Object.keys(filteredOthers).length > 0) {
    if (Object.keys(checkboxes).length > 0 && options?.settleMs && options.settleMs > 0) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve, options.settleMs);
        });
      });
    }
    result = mergeApplyResults(result, await applyValuesBatch(targets, filteredOthers));
  }

  return result;
}

export async function reconcileAppliedValues(
  targets: Map<string, ApplyTarget>,
  appliedValues: Record<string, string>,
  options?: { settleMs?: number; fields?: FieldDescriptor[] },
): Promise<ApplyValuesResult> {
  if (Object.keys(appliedValues).length === 0) {
    return { applied: {}, failed: [], results: [] };
  }

  console.debug("[AI Form Filler] reconcile appliedValues", {
    count: Object.keys(appliedValues).length,
    sids: Object.keys(appliedValues),
  });

  return applyValuesToTargets(targets, appliedValues, options);
}
