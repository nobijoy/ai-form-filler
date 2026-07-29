import type { FieldDescriptor } from "./types";
import { isFillableField } from "./fillable";

/**
 * Network-free value generation for fields whose meaning is unambiguous from
 * their type or autocomplete token. Anything requiring judgement (selects,
 * radios, checkboxes, prose, payment data) is left to the model.
 *
 * Values are seeded from the run's identity map so that a field filled here
 * stays consistent with the same slot on a later step.
 */

const PAYMENT_AUTOCOMPLETE = /^(cc-|card)/i;

const HEURISTIC_AUTOCOMPLETE = new Set([
  "email",
  "username",
  "url",
  "nickname",
  "given-name",
  "family-name",
  "name",
  "street-address",
  "address-line1",
  "address-line2",
  "postal-code",
  "country",
  "country-name",
  "tel",
  "tel-national",
]);

/** Values already chosen this run, keyed by semantic slot. */
export type IdentityMap = Record<string, string>;

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sequenceFromSeed(seed: string): number | null {
  const match = /^v(\d+)-/.exec(seed);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function pick<T>(items: readonly T[], seed: string, slot: string): T {
  const sequence = sequenceFromSeed(seed);
  const offset = hashSeed(slot) % items.length;
  const index =
    sequence === null ? hashSeed(`${seed}:${slot}`) % items.length : (sequence + offset) % items.length;
  return items[index];
}

function numberFrom(seed: string, slot: string, min: number, max: number): number {
  const sequence = sequenceFromSeed(seed);
  if (sequence !== null && slot === "account-suffix") {
    return min + ((sequence * 7919) % (max - min + 1));
  }
  return min + (hashSeed(`${seed}:${slot}`) % (max - min + 1));
}

interface SyntheticProfile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  username: string;
  street: string;
  postalCode: string;
  country: string;
  phone: string;
}

const PROFILE_DATA = {
  en: {
    first: ["Avery", "Jordan", "Morgan", "Riley", "Cameron", "Taylor", "Casey", "Quinn"],
    last: ["Bennett", "Rivera", "Patel", "Kim", "Morgan", "Reed", "Sullivan", "Chen"],
    streets: ["Oak Avenue", "Maple Street", "Cedar Lane", "Market Street", "Willow Road"],
    country: "US",
  },
  fr: {
    first: ["Camille", "Élodie", "Lucas", "Manon", "Hugo", "Léa", "Noémie", "Théo"],
    last: ["Bernard", "Moreau", "Laurent", "Roux", "Simon", "Fournier", "Girard", "Mercier"],
    streets: ["rue des Lilas", "avenue Victor Hugo", "rue de la République", "boulevard Voltaire"],
    country: "FR",
  },
  de: {
    first: ["Lena", "Jonas", "Mia", "Felix", "Leonie", "Elias", "Sophie", "Niklas"],
    last: ["Schneider", "Fischer", "Weber", "Wagner", "Becker", "Hoffmann", "Koch", "Richter"],
    streets: ["Hauptstraße", "Gartenweg", "Lindenstraße", "Bahnhofstraße"],
    country: "DE",
  },
  ja: {
    first: ["陽翔", "結菜", "蓮", "葵", "湊", "凛", "悠真", "美咲"],
    last: ["佐藤", "鈴木", "高橋", "田中", "伊藤", "山本", "中村", "小林"],
    streets: ["桜町", "青葉通り", "中央", "本町"],
    country: "JP",
  },
} as const;

function localeFamily(locale: string): keyof typeof PROFILE_DATA {
  const normalized = locale.toLowerCase();
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("ja")) return "ja";
  return "en";
}

function profileFor(seed: string, locale: string): SyntheticProfile {
  const family = localeFamily(locale);
  const data = PROFILE_DATA[family];
  const firstName = pick(data.first, seed, "first-name");
  const lastName = pick(data.last, seed, "last-name");
  const suffix = numberFrom(seed, "account-suffix", 1000, 9999);
  const streetNumber = numberFrom(seed, "street-number", 10, 899);
  const postalNumber = numberFrom(seed, "postal-code", 10000, 99999);
  const asciiName = `${family}-${suffix}`;

  return {
    firstName,
    lastName,
    fullName: family === "ja" ? `${lastName} ${firstName}` : `${firstName} ${lastName}`,
    email: `qa.${asciiName}@example.com`,
    username: `qa_${asciiName}`,
    street: `${streetNumber} ${pick(data.streets, seed, "street")}`,
    postalCode: String(postalNumber),
    country: data.country,
    phone: `+1555${numberFrom(seed, "phone", 1000000, 9999999)}`,
  };
}

function primaryAutoCompleteToken(field: FieldDescriptor): string {
  return (field.autoComplete || "").toLowerCase().split(/\s+/)[0] ?? "";
}

/**
 * Semantic fallback for ordinary forms that omit autocomplete attributes.
 * Keep patterns narrow so fields such as "company name" are not mistaken for a
 * person's full name.
 */
function labelSemanticToken(field: FieldDescriptor): string {
  const text = [field.labelText, field.ariaLabel, field.name, field.id, field.placeholder]
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

  if (/\b(first|given)\s*name\b|pr[ée]nom|名(?:前)?|이름/.test(text)) return "given-name";
  if (/\b(last|family)\s*name\b|\bsurname\b|nom\s+de\s+famille|姓|성/.test(text)) {
    return "family-name";
  }
  if (
    /\b(full|complete)\s*name\b|nom\s+complet|氏名|お名前|성명/.test(text) &&
    !/\bcompany|organization|business|employer\b/.test(text)
  ) {
    return "name";
  }
  if (/\b(preferred\s*name|nickname|display\s*name)\b|surnom/.test(text)) return "nickname";
  if (/\buser\s*name\b|\busername\b|\blogin\b|nom\s+d['’]utilisateur/.test(text)) {
    return "username";
  }
  if (/\be-?mail\b|\bcourriel\b/.test(text)) return "email";
  if (/\b(phone|mobile|telephone|tel)\b|t[ée]l[ée]phone/.test(text)) return "tel";
  if (/\b(postal|zip)\s*(code)?\b|code\s+postal/.test(text)) return "postal-code";
  if (/\b(street\s*address|address\s*line\s*1)\b|adresse/.test(text)) return "address-line1";
  if (/\bpersonal\s*(website|site)\b|\bwebsite\b/.test(text)) return "url";
  return "";
}

function semanticToken(field: FieldDescriptor): string {
  return primaryAutoCompleteToken(field) || labelSemanticToken(field);
}

export function classifyField(field: FieldDescriptor): "heuristic" | "ai" {
  if (!isFillableField(field)) return "ai";
  if (PAYMENT_AUTOCOMPLETE.test(field.autoComplete || "")) return "ai";
  if (field.inputType === "password") return "ai";

  // Anything with a choice set, or any boolean, needs to understand the form.
  if (field.kind && field.kind !== "text" && field.kind !== "textarea") return "ai";
  if (field.tag === "select" || field.radioGroup) return "ai";

  const token = semanticToken(field);

  if (field.kind === "text" || field.tag === "input") {
    if (field.inputType === "email") return "heuristic";
    if (field.inputType === "url") return "heuristic";
    if (field.inputType === "tel") return "heuristic";
    if (token && HEURISTIC_AUTOCOMPLETE.has(token)) return "heuristic";
  }

  return "ai";
}

/**
 * Whether a generic value satisfies the constraints the field declares.
 *
 * A locale-specific format ("0XX-XXXX-XXXX") is exactly the case a generic
 * value gets wrong, and handing it over anyway costs a full validation round
 * trip. Deferring to the model is cheaper than being rejected by the page.
 */
function satisfiesConstraints(value: string, field: FieldDescriptor): boolean {
  if (field.maxLength && value.length > field.maxLength) return false;
  if (!field.pattern) return true;
  try {
    return new RegExp(`^(?:${field.pattern})$`).test(value);
  } catch {
    return true;
  }
}

/**
 * A generated value, or null when the field needs the model.
 *
 * `identity` is read *and* respected: reusing the earlier email is what makes a
 * later "confirm your email" field match.
 */
export function tryHeuristicValue(
  field: FieldDescriptor,
  identity: IdentityMap = {},
  variationSeed = "default",
  locale = "en",
): string | null {
  const value = generateHeuristicValue(field, identity, variationSeed, locale);
  if (value === null) return null;
  return satisfiesConstraints(value, field) ? value : null;
}

function generateHeuristicValue(
  field: FieldDescriptor,
  identity: IdentityMap,
  variationSeed: string,
  locale: string,
): string | null {
  if (classifyField(field) !== "heuristic") return null;

  const token = semanticToken(field);
  const profile = profileFor(variationSeed, locale);

  if (field.inputType === "email" || token === "email") {
    return identity.email || profile.email;
  }
  if (field.inputType === "url" || token === "url") {
    return identity.url || `https://${profile.username}.example.com`;
  }
  if (field.inputType === "tel" || token.startsWith("tel")) {
    return identity.phone || profile.phone;
  }

  switch (token) {
    case "given-name":
      return identity.firstName || profile.firstName;
    case "family-name":
      return identity.lastName || profile.lastName;
    case "name":
      return identity.fullName || profile.fullName;
    case "nickname":
      return identity.firstName || profile.firstName;
    case "username":
      return identity.username || identity.email?.split("@")[0] || profile.username;
    case "street-address":
    case "address-line1":
      return identity.street || profile.street;
    case "address-line2":
      return null;
    case "postal-code":
      return identity.postalCode || profile.postalCode;
    case "country":
    case "country-name":
      return identity.country || profile.country;
    default:
      break;
  }

  return null;
}
