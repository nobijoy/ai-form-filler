/**
 * Matching model output against a control's real option set.
 *
 * Models answer with whatever reads naturally for the label ("Tokyo"), not the
 * machine value ("13"), and they reformat casing and punctuation freely. Exact
 * value comparison therefore rejects correct answers, which is why selects and
 * radios were failing. Matching walks from strictest to loosest and refuses to
 * guess when a loose match is ambiguous.
 */

export interface OptionLike {
  value: string;
  label: string;
}

/** NFKC folds full-width Japanese forms onto their ASCII equivalents. */
function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[*:：()（）[\]{}.,、。/\\_-]/g, "")
    .trim();
}

function uniqueMatch<T>(items: T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

/**
 * Resolves model output to a concrete option value, or null when no option can
 * be identified confidently.
 */
export function resolveOptionValue(options: OptionLike[], candidate: string): string | null {
  if (options.length === 0) return null;
  const raw = candidate.trim();
  if (!raw) return null;

  const byValue = options.find((o) => o.value === raw);
  if (byValue) return byValue.value;

  const byLabel = options.find((o) => o.label.trim() === raw);
  if (byLabel) return byLabel.value;

  const target = normalize(raw);
  if (!target) return null;

  const normValue = options.filter((o) => normalize(o.value) === target);
  const valueHit = uniqueMatch(normValue);
  if (valueHit) return valueHit.value;

  const normLabel = options.filter((o) => normalize(o.label) === target);
  const labelHit = uniqueMatch(normLabel);
  if (labelHit) return labelHit.value;

  // Loose containment, only when exactly one option is compatible. Guarded by a
  // length floor so a one-character answer cannot match half the list.
  if (target.length >= 2) {
    const contained = options.filter((o) => {
      const label = normalize(o.label);
      if (!label) return false;
      return label === target || label.includes(target) || target.includes(label);
    });
    const containedHit = uniqueMatch(contained);
    if (containedHit) return containedHit.value;
  }

  return null;
}

const TRUTHY = new Set(["true", "yes", "on", "1", "checked", "y", "はい", "有", "あり", "선택"]);
const FALSY = new Set(["false", "no", "off", "0", "unchecked", "n", "いいえ", "無", "なし"]);

/**
 * Coerces model output for a boolean control. Returns null for values that are
 * neither truthy nor falsy so the caller can reject rather than guess.
 */
export function resolveBooleanValue(candidate: string): boolean | null {
  const normalized = normalize(candidate);
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return null;
}

export { normalize as normalizeForMatch };
