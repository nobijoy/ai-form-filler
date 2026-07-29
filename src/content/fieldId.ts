/**
 * Synthetic field identity.
 *
 * Identity derived from the DOM node alone (a WeakMap keyed on the element) is
 * unusable across wizard steps: React reconciliation reuses the same input
 * nodes between steps, so step N's recorded values mask step N+1's empty
 * fields. Instead a sid is derived from the field's *content* (labels, name,
 * type, options, structural position) and namespaced by a step epoch, so a
 * recycled node can never collide with a previous step's applied values.
 */

/** Framework-generated identifiers change on every mount and must not feed the hash. */
const VOLATILE_TOKEN_PATTERNS: RegExp[] = [
  /^:{1,2}r[0-9a-z]+:{1,2}$/i,
  /^mui-\d+$/i,
  /^radix-[-:\w]+$/i,
  /^headlessui-[-:\w]+$/i,
  /^react-select-\d+/i,
  /^downshift-\d+/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /\d{7,}/,
];

const MAX_ANCESTOR_DEPTH = 6;

let epoch = 0;

export function currentEpoch(): number {
  return epoch;
}

/** Starts a new step namespace. Every sid minted afterwards is distinct from earlier steps. */
export function beginEpoch(): number {
  epoch += 1;
  return epoch;
}

export function resetEpoch(): void {
  epoch = 0;
}

function isVolatileToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return VOLATILE_TOKEN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function stableToken(value: string | null | undefined): string {
  if (!value) return "";
  return isVolatileToken(value) ? "" : value.trim();
}

/** FNV-1a, base36. Short and collision-resistant enough for a single document. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function nthOfType(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  let index = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName === el.tagName) {
      index += 1;
      if (sibling === el) return index;
    }
  }
  return index;
}

/**
 * Positional fingerprint. Included so that repeated, otherwise-identical
 * controls (address rows, "add another" lists) stay distinguishable.
 */
function structuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;

  while (cur && depth < MAX_ANCESTOR_DEPTH) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;
    const stableId = stableToken(cur.getAttribute("id"));
    parts.push(stableId ? `${tag}#${stableId}` : `${tag}:${nthOfType(cur)}`);
    if (tag === "form") break;
    cur = cur.parentElement;
    depth += 1;
  }

  return parts.join("/");
}

export interface FieldIdentityParts {
  name?: string;
  id?: string;
  inputType?: string;
  tag?: string;
  labelText?: string;
  /** Stable signature of the option/choice set, e.g. joined option values. */
  optionSignature?: string;
  /** Radio group name, when the field represents a whole group. */
  groupName?: string;
}

function normalizeLabel(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function identityKey(el: Element, parts: FieldIdentityParts): string {
  return [
    parts.tag ?? el.tagName.toLowerCase(),
    parts.inputType ?? "",
    stableToken(parts.name),
    stableToken(parts.id),
    stableToken(parts.groupName),
    normalizeLabel(parts.labelText),
    parts.optionSignature?.slice(0, 200) ?? "",
    structuralPath(el),
  ].join("|");
}

/**
 * Mints sids for a single scan pass. Constructed per scan so that duplicate
 * identity keys get a deterministic occurrence suffix based on document order.
 */
export class FieldIdAllocator {
  private readonly seen = new Map<string, number>();

  constructor(private readonly epochValue: number = currentEpoch()) {}

  allocate(el: Element, parts: FieldIdentityParts): string {
    const key = identityKey(el, parts);
    const occurrence = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, occurrence);
    const suffix = occurrence > 1 ? `_${occurrence}` : "";
    return `s${this.epochValue}_${hashString(key)}${suffix}`;
  }
}

/** True when the sid was minted in the given step epoch. */
export function sidBelongsToEpoch(sid: string, epochValue: number): boolean {
  return sid.startsWith(`s${epochValue}_`);
}
