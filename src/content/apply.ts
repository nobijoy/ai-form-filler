import type { FieldDescriptor } from "../shared/types";
import { isInstanceFillable, readInstanceValue } from "./scan";
import { adapterForInstance, type WidgetInstance } from "./widgets";
import { nextFrame } from "./widgets/dom";

export interface ApplyFieldResult {
  sid: string;
  success: boolean;
  appliedValue?: string;
  reason?: string;
}

export interface ApplyValuesResult {
  applied: Record<string, string>;
  failed: string[];
  results: ApplyFieldResult[];
}

export interface ApplyOptions {
  settleMs?: number;
}

function isToggleKind(descriptor: FieldDescriptor): boolean {
  return (
    descriptor.kind === "checkbox" ||
    descriptor.kind === "aria-checkbox" ||
    descriptor.kind === "aria-switch"
  );
}

async function applyOne(
  sid: string,
  value: string,
  instance: WidgetInstance,
): Promise<ApplyFieldResult> {
  if (!isInstanceFillable(instance)) {
    return { sid, success: false, reason: "the control is hidden or disabled" };
  }

  const adapter = adapterForInstance(instance);
  if (!adapter) {
    return { sid, success: false, reason: "no adapter handles this control" };
  }

  try {
    const report = await adapter.apply(instance, value);
    return {
      sid,
      success: report.success,
      appliedValue: report.appliedValue,
      reason: report.reason,
    };
  } catch (error) {
    return {
      sid,
      success: false,
      reason: error instanceof Error ? error.message : "the control threw while being set",
    };
  }
}

/**
 * Writes a batch of values.
 *
 * Toggles go first: checking a box is what reveals the dependent field it
 * controls, so the two must not be written in the same pass.
 */
export async function applyValuesToInstances(
  instances: Map<string, WidgetInstance>,
  values: Record<string, string>,
  options: ApplyOptions = {},
): Promise<ApplyValuesResult> {
  const applied: Record<string, string> = {};
  const failed: string[] = [];
  const results: ApplyFieldResult[] = [];

  const toggles: string[] = [];
  const rest: string[] = [];

  for (const sid of Object.keys(values)) {
    const instance = instances.get(sid);
    if (!instance) {
      failed.push(sid);
      results.push({ sid, success: false, reason: "the field is no longer in the page" });
      continue;
    }
    if (isToggleKind(instance.descriptor)) toggles.push(sid);
    else rest.push(sid);
  }

  const runBatch = async (sids: string[]): Promise<void> => {
    for (const sid of sids) {
      const instance = instances.get(sid);
      if (!instance) continue;

      // A dependent field is meaningless until its controller is selected.
      const controller = instance.descriptor.controllingCheckboxSid;
      if (controller) {
        const controllerValue = applied[controller] ?? values[controller];
        if (controllerValue !== "true") continue;
      }

      const result = await applyOne(sid, values[sid], instance);
      results.push(result);
      if (result.success) applied[sid] = result.appliedValue ?? values[sid];
      else failed.push(sid);
    }
  };

  await runBatch(toggles);

  if (toggles.length > 0 && rest.length > 0) {
    await nextFrame();
    if (options.settleMs && options.settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.settleMs));
    }
  }

  await runBatch(rest);

  return { applied, failed, results };
}

/**
 * Re-asserts values a re-render discarded.
 *
 * Must only ever be called with the current step's values: replaying an earlier
 * step's map would write stale data into DOM nodes the framework has reused.
 */
export async function reconcileAppliedValues(
  instances: Map<string, WidgetInstance>,
  appliedValues: Record<string, string>,
  options: ApplyOptions = {},
): Promise<ApplyValuesResult> {
  const drifted: Record<string, string> = {};

  for (const [sid, value] of Object.entries(appliedValues)) {
    const instance = instances.get(sid);
    if (!instance) continue;
    if (!isInstanceFillable(instance)) continue;
    if (readInstanceValue(instance) === value) continue;
    drifted[sid] = value;
  }

  if (Object.keys(drifted).length === 0) {
    return { applied: {}, failed: [], results: [] };
  }

  return applyValuesToInstances(instances, drifted, options);
}
