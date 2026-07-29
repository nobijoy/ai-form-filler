import type { ChunkDescriptor, FieldDescriptor } from "../shared/types";

/**
 * Chunking splits the unresolved fields of a step into prompt-sized groups.
 *
 * Grouping follows the page's own structure (fieldset/legend, role=group,
 * nearest heading) in document order. Document order matters: it is the order a
 * person would fill the form, so a field that reveals later fields is handled
 * before the fields that depend on it.
 */

const MAX_FIELDS_PER_CHUNK = 12;
/** Textareas produce long output, so chunks containing them stay smaller. */
const MAX_FIELDS_PER_CHUNK_WITH_PROSE = 6;

function chunkLimitFor(fields: FieldDescriptor[]): number {
  const proseCount = fields.filter(
    (field) => field.kind === "textarea" || field.kind === "contenteditable",
  ).length;
  return proseCount >= 2 ? MAX_FIELDS_PER_CHUNK_WITH_PROSE : MAX_FIELDS_PER_CHUNK;
}

function groupIdentity(field: FieldDescriptor): string {
  return field.groupKey ?? field.groupLabel ?? field.formPurpose ?? "__ungrouped__";
}

function groupDisplayName(fields: FieldDescriptor[], fallbackIndex: number): string {
  const labelled = fields.find((field) => field.groupLabel?.trim());
  if (labelled?.groupLabel) return labelled.groupLabel.slice(0, 80);
  const purpose = fields.find((field) => field.formPurpose?.trim());
  if (purpose?.formPurpose) return purpose.formPurpose.slice(0, 80);
  return `section ${fallbackIndex + 1}`;
}

/**
 * Keeps a checkbox group whole. Splitting one across chunks would make the
 * model choose selections without seeing the alternatives.
 */
function splitPreservingGroups(fields: FieldDescriptor[], limit: number): FieldDescriptor[][] {
  const batches: FieldDescriptor[][] = [];
  let current: FieldDescriptor[] = [];

  const atomicRuns: FieldDescriptor[][] = [];
  let runKey: string | null = null;

  for (const field of fields) {
    const key = field.checkboxGroupKey ?? null;
    if (key !== null && key === runKey && atomicRuns.length > 0) {
      atomicRuns[atomicRuns.length - 1].push(field);
      continue;
    }
    atomicRuns.push([field]);
    runKey = key;
  }

  for (const run of atomicRuns) {
    if (current.length > 0 && current.length + run.length > limit) {
      batches.push(current);
      current = [];
    }
    current.push(...run);
    if (current.length >= limit) {
      batches.push(current);
      current = [];
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildChunks(fields: FieldDescriptor[]): ChunkDescriptor[] {
  if (fields.length === 0) return [];

  // Preserve first-seen order of each group.
  const order: string[] = [];
  const byGroup = new Map<string, FieldDescriptor[]>();

  for (const field of fields) {
    const key = groupIdentity(field);
    if (!byGroup.has(key)) {
      byGroup.set(key, []);
      order.push(key);
    }
    byGroup.get(key)!.push(field);
  }

  const chunks: ChunkDescriptor[] = [];

  order.forEach((key, index) => {
    const groupFields = byGroup.get(key)!;
    const name = groupDisplayName(groupFields, index);
    const batches = splitPreservingGroups(groupFields, chunkLimitFor(groupFields));

    batches.forEach((batch, batchIndex) => {
      chunks.push({
        sectionName: batches.length > 1 ? `${name} (${batchIndex + 1}/${batches.length})` : name,
        fieldSids: batch.map((field) => field.syntheticId),
      });
    });
  });

  return chunks;
}
