/**
 * Local repair of values that fail a field's `pattern`.
 *
 * The overwhelming majority of real-world `pattern` attributes describe digits
 * separated by literals: phone numbers, postal codes, card numbers, dates. A
 * model asked for such a field usually produces the right digits in the wrong
 * shape ("+81 90 1234 5678" for `0\d{2}-\d{4}-\d{4}`). Reshaping that locally is
 * deterministic and free, where re-prompting is neither.
 *
 * Anything more expressive than literals plus `\d` groups is left alone, and
 * every result is verified against the real regex before being returned, so this
 * can never widen what the page accepts.
 */

type Token = { kind: "literal"; char: string } | { kind: "digits"; count: number };

/**
 * How many leading digits may be discarded as an international dialling prefix.
 * Only ever applied when the value actually carries a `+`, since dropping digits
 * from a plain number silently truncates it into a different value.
 */
const MAX_LEADING_DIGITS_TO_DROP = 4;

/**
 * Parses a pattern into literal characters and fixed-length digit runs.
 * Returns null for anything using other regex features, since reshaping those
 * would be guesswork.
 */
function tokenizePattern(pattern: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "\\") {
      const next = pattern[i + 1];
      if (next !== "d") return null;
      i += 2;

      // Optional {n} or {n,n} quantifier; a bare \d is one digit.
      const quantifier = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(i));
      if (quantifier) {
        const min = Number(quantifier[1]);
        const max = quantifier[2] === undefined ? min : Number(quantifier[2]);
        if (min !== max || min < 1 || min > 32) return null;
        tokens.push({ kind: "digits", count: min });
        i += quantifier[0].length;
      } else {
        if ("?*+{".includes(pattern[i] ?? "")) return null;
        tokens.push({ kind: "digits", count: 1 });
      }
      continue;
    }

    // Any other regex metacharacter puts this pattern out of scope.
    if ("[](){}|?*+.^$".includes(char)) return null;

    tokens.push({ kind: "literal", char });
    i += 1;
  }

  return tokens.length > 0 ? tokens : null;
}

/**
 * Lays the given digits into the token sequence.
 *
 * A literal that is itself a digit consumes an input digit only when they match,
 * which is what lets `0\d{2}-...` accept both "090…" (leading zero supplied) and
 * "90…" (leading zero implied).
 */
function layOutDigits(tokens: Token[], digits: string): string | null {
  let out = "";
  let cursor = 0;

  for (const token of tokens) {
    if (token.kind === "literal") {
      if (/\d/.test(token.char) && digits[cursor] === token.char) cursor += 1;
      out += token.char;
      continue;
    }

    if (cursor + token.count > digits.length) return null;
    out += digits.slice(cursor, cursor + token.count);
    cursor += token.count;
  }

  // Leftover digits mean this was not the same number, not a formatting slip.
  return cursor === digits.length ? out : null;
}

/**
 * Digit-run lengths the pattern expects, with fixed digit literals counted into
 * the run they sit in: `0\d{2}-\d{4}` expects runs of [3, 4].
 */
function patternGroupLengths(tokens: Token[]): number[] {
  const groups: number[] = [];
  let current = 0;

  for (const token of tokens) {
    if (token.kind === "digits") {
      current += token.count;
    } else if (/\d/.test(token.char)) {
      current += 1;
    } else if (current > 0) {
      groups.push(current);
      current = 0;
    }
  }

  if (current > 0) groups.push(current);
  return groups;
}

function digitRunLengths(value: string): number[] {
  return (value.match(/\d+/g) ?? []).map((run) => run.length);
}

/**
 * Returns a value matching `pattern` built from the digits in `value`, or null
 * when no confident reshaping exists.
 *
 * Deliberately conservative: reshaping is for a value whose digits are right and
 * whose grouping is wrong. When the value's own grouping contradicts the
 * pattern's, the digits most likely mean something else — "28/07/2026" against
 * `\d{4}-\d{2}-\d{2}` is a day-first date, not a mis-punctuated year-first one —
 * and guessing would produce a value the page accepts but a human would not.
 */
export function coerceToPattern(value: string, pattern: string): string | null {
  if (pattern.length > 200) return null;

  let anchored: RegExp;
  try {
    anchored = new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }

  if (anchored.test(value)) return value;

  const tokens = tokenizePattern(pattern);
  if (!tokens) return null;

  const digits = value.replace(/\D/g, "");
  if (!digits) return null;

  const hasInternationalPrefix = value.trimStart().startsWith("+");
  const runs = digitRunLengths(value);

  // Grouping conflict check, skipped for international numbers whose leading run
  // is a dialling prefix that is about to be dropped.
  if (runs.length > 1 && !hasInternationalPrefix) {
    const expected = patternGroupLengths(tokens);
    const sameShape =
      runs.length === expected.length && runs.every((run, index) => run === expected[index]);
    if (!sameShape) return null;
  }

  const maxDrop = hasInternationalPrefix ? MAX_LEADING_DIGITS_TO_DROP : 0;

  for (let drop = 0; drop <= maxDrop; drop++) {
    if (drop >= digits.length) break;
    const candidate = layOutDigits(tokens, digits.slice(drop));
    // The real regex is the only authority on whether this is acceptable.
    if (candidate !== null && anchored.test(candidate)) return candidate;
  }

  return null;
}
