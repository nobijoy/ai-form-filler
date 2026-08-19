import type { FieldDescriptor } from "./types";
import { isFillableField, PAYMENT_AUTOCOMPLETE } from "./fillable";
import { formatDateForControl, looksLikeDateField, looksLikeEndDateField } from "./dateField";

/**
 * Network-free value generation for fields whose meaning is unambiguous from
 * their type or autocomplete token. Anything requiring judgement (selects,
 * radios, checkboxes, prose, payment data) is left to the model.
 *
 * Values are seeded from the run's identity map so that a field filled here
 * stays consistent with the same slot on a later step.
 */

const HEURISTIC_AUTOCOMPLETE = new Set([
  "email",
  "username",
  "url",
  "nickname",
  "given-name",
  "additional-name",
  "family-name",
  "name",
  "street-address",
  "address-line1",
  "address-line2",
  "address-level2",
  "postal-code",
  "country",
  "country-name",
  "tel",
  "tel-national",
  "bday",
  "bday-year",
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
  // Rotate first names explicitly so adjacent runs never repeat until the pool
  // wraps. Hash all other slots with the full seed (including its random
  // suffix), avoiding a fixed first/last/street combination that cycles as one.
  const index =
    sequence !== null && slot === "first-name"
      ? (sequence + offset) % items.length
      : hashSeed(`${seed}:${slot}`) % items.length;
  return items[index];
}

function numberFrom(seed: string, slot: string, min: number, max: number): number {
  const sequence = sequenceFromSeed(seed);
  if (sequence !== null && slot === "account-suffix") {
    return min + ((sequence * 7919) % (max - min + 1));
  }
  return min + (hashSeed(`${seed}:${slot}`) % (max - min + 1));
}

export interface SyntheticProfile {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  fullName: string;
  email: string;
  username: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
  phone: string;
  dateOfBirth: string;
  birthYear: string;
}

/** Known-valid, non-user-owned example numbers in international E.164 form. */
const TEST_PHONE_BY_COUNTRY: Record<string, readonly string[]> = {
  US: ["+12025550123", "+14155552671", "+12125550184"],
  CA: ["+14165550123", "+16045550184", "+15145550142"],
  GB: ["+447911123456", "+447700900123", "+447911654321"],
  FR: ["+33612345678", "+33756123456", "+33698765432"],
  DE: ["+4915123456789", "+491601234567", "+491709876543"],
  JP: ["+819012345678", "+818012345678", "+817012345678"],
  AU: ["+61412345678", "+61487654321", "+61400123456"],
  IN: ["+919876543210", "+919812345678", "+917654321098"],
  BR: ["+5511987654321", "+5521987654321", "+5531987654321"],
  BD: ["+8801712345678", "+8801812345678", "+8801912345678"],
};

const CALLING_PREFIX_BY_COUNTRY: Record<string, string> = {
  US: "+1",
  CA: "+1",
  GB: "+44",
  FR: "+33",
  DE: "+49",
  JP: "+81",
  AU: "+61",
  IN: "+91",
  BR: "+55",
  BD: "+880",
};

function phoneFitsCountry(value: string, country: string): boolean {
  const prefix = CALLING_PREFIX_BY_COUNTRY[country];
  if (!prefix) return true;
  const digits = value.replace(/[^\d+]/g, "");
  return digits.startsWith(prefix);
}

const PROFILE_DATA = {
  en: {
    first: [
      "Avery", "Jordan", "Morgan", "Riley", "Cameron", "Taylor", "Casey", "Quinn",
      "Harper", "Rowan", "Skyler", "Peyton", "Reese", "Finley", "Dakota", "Emery",
    ],
    middle: ["James", "Lee", "Anne", "Ray", "Blake", "Kai", "Noel", "Sage"],
    last: [
      "Bennett", "Rivera", "Patel", "Kim", "Morgan", "Reed", "Sullivan", "Chen",
      "Brooks", "Nguyen", "Hayes", "Ortiz", "Powell", "Flores", "Griffin", "Watts",
    ],
    streets: ["Oak Avenue", "Maple Street", "Cedar Lane", "Market Street", "Willow Road", "Pine Court"],
    cities: ["Austin", "Seattle", "Denver", "Portland", "Chicago", "Boston", "Atlanta", "Phoenix"],
    country: "US",
    countryName: "United States",
  },
  fr: {
    first: [
      "Camille", "Élodie", "Lucas", "Manon", "Hugo", "Léa", "Noémie", "Théo",
      "Chloé", "Mathis", "Inès", "Enzo", "Jade", "Louis", "Alice", "Nathan",
    ],
    middle: ["Marie", "Jean", "Paul", "Claire", "Luc", "Anne", "Yves", "Eve"],
    last: [
      "Bernard", "Moreau", "Laurent", "Roux", "Simon", "Fournier", "Girard", "Mercier",
      "Blanc", "Guerin", "Boyer", "Garnier", "Chevalier", "Francois", "Legrand", "Bonnet",
    ],
    streets: ["rue des Lilas", "avenue Victor Hugo", "rue de la République", "boulevard Voltaire", "rue Pasteur"],
    cities: ["Lyon", "Nantes", "Toulouse", "Bordeaux", "Lille", "Rennes", "Strasbourg", "Nice"],
    country: "FR",
    countryName: "France",
  },
  de: {
    first: [
      "Lena", "Jonas", "Mia", "Felix", "Leonie", "Elias", "Sophie", "Niklas",
      "Emma", "Paul", "Hannah", "Ben", "Clara", "Luis", "Greta", "Finn",
    ],
    middle: ["Marie", "Max", "Anna", "Luca", "Eva", "Theo", "Lia", "Otto"],
    last: [
      "Schneider", "Fischer", "Weber", "Wagner", "Becker", "Hoffmann", "Koch", "Richter",
      "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun", "Krüger",
    ],
    streets: ["Hauptstraße", "Gartenweg", "Lindenstraße", "Bahnhofstraße", "Schulstraße", "Parkallee"],
    cities: ["Hamburg", "München", "Köln", "Frankfurt", "Stuttgart", "Düsseldorf", "Leipzig", "Dresden"],
    country: "DE",
    countryName: "Germany",
  },
  ja: {
    first: ["陽翔", "結菜", "蓮", "葵", "湊", "凛", "悠真", "美咲", "大輝", "陽菜", "颯太", "咲良", "樹", "彩", "翔", "結衣"],
    middle: ["", "", "", "", "", "", "", ""],
    last: ["佐藤", "鈴木", "高橋", "田中", "伊藤", "山本", "中村", "小林", "加藤", "吉田", "山田", "佐々木", "松本", "井上", "木村", "林"],
    streets: ["桜町", "青葉通り", "中央", "本町", "緑ケ丘", "西新宿"],
    cities: ["横浜", "大阪", "名古屋", "札幌", "福岡", "神戸", "京都", "仙台"],
    country: "JP",
    countryName: "Japan",
  },
} as const;

function localeFamily(locale: string): keyof typeof PROFILE_DATA {
  const normalized = locale.toLowerCase();
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("ja")) return "ja";
  return "en";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Deterministic synthetic person for one fill run.
 *
 * Used by local heuristics and injected into the LLM context so the model does
 * not fall back to its favourite stock names (Julian, John Doe, …).
 */
export function profileFor(seed: string, locale: string): SyntheticProfile {
  const family = localeFamily(locale);
  const data = PROFILE_DATA[family];
  const firstName = pick(data.first, seed, "first-name");
  const middleName = pick(data.middle, seed, "middle-name");
  const lastName = pick(data.last, seed, "last-name");
  const preferredName = firstName;
  const suffix = numberFrom(seed, "account-suffix", 1000, 9999);
  const streetNumber = numberFrom(seed, "street-number", 10, 899);
  const postalNumber = numberFrom(seed, "postal-code", 10000, 99999);
  const asciiName = `${family}-${suffix}`;
  const birthYear = numberFrom(seed, "birth-year", 1978, 2002);
  const birthMonth = numberFrom(seed, "birth-month", 1, 12);
  const birthDay = numberFrom(seed, "birth-day", 1, 28);

  return {
    firstName,
    middleName,
    lastName,
    preferredName: family === "ja" ? firstName : preferredName,
    fullName: family === "ja" ? `${lastName} ${firstName}` : `${firstName} ${lastName}`,
    email: `qa.${asciiName}@example.com`,
    username: `qa_${asciiName}`,
    street: `${streetNumber} ${pick(data.streets, seed, "street")}`,
    city: pick(data.cities, seed, "city"),
    postalCode: String(postalNumber),
    country: data.countryName,
    phone: pick(TEST_PHONE_BY_COUNTRY[data.country] ?? TEST_PHONE_BY_COUNTRY.US, seed, "phone"),
    dateOfBirth: `${birthYear}-${pad2(birthMonth)}-${pad2(birthDay)}`,
    birthYear: String(birthYear),
  };
}

/**
 * Identity slots + sketch facts derived from the run seed.
 *
 * Pre-seeding these keeps heuristic and AI fills on the same person, and forces
 * run-to-run diversity even when the model would otherwise reuse stereotypes.
 */
export function buildSeededPersona(
  seed: string,
  locale: string,
): { identity: IdentityMap; sketch: Record<string, string> } {
  const profile = profileFor(seed, locale);
  const identity: IdentityMap = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: profile.fullName,
    email: profile.email,
    username: profile.username,
    phone: profile.phone,
    street: profile.street,
    city: profile.city,
    postalCode: profile.postalCode,
    country: profile.country,
    url: `https://${profile.username}.example.com`,
    preferredName: profile.preferredName,
    dateOfBirth: profile.dateOfBirth,
    birthYear: profile.birthYear,
  };
  if (profile.middleName) identity.middleName = profile.middleName;

  const sketch: Record<string, string> = {
    firstName: profile.firstName,
    middleName: profile.middleName,
    lastName: profile.lastName,
    preferredName: profile.preferredName,
    fullName: profile.fullName,
    email: profile.email,
    username: profile.username,
    phone: profile.phone,
    street: profile.street,
    city: profile.city,
    postalCode: profile.postalCode,
    country: profile.country,
    dateOfBirth: profile.dateOfBirth,
    personalWebsite: `https://${profile.username}.example.com`,
  };

  if (!profile.middleName) delete sketch.middleName;

  return { identity, sketch };
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
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

  if (/\b(first|given)\s*name\b|pr[ée]nom|名(?:前)?|이름/.test(text)) return "given-name";
  if (/\b(middle|additional|second)\s*name\b|deuxi[eè]me\s+pr[ée]nom|ミドル/.test(text)) {
    return "additional-name";
  }
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
  if (/\b(city|town|ville|stadt|市区町村)\b/.test(text)) return "address-level2";
  if (/\b(date\s*of\s*birth|birth\s*date|dob|birthday|geburtsdatum|date\s+de\s+naissance)\b/.test(text)) {
    return "bday";
  }
  if (/\b(birth\s*year|year\s*of\s*birth|geburtsjahr)\b/.test(text)) return "bday-year";
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
  if (field.kind === "date" || field.inputType === "date" || looksLikeDateField(field)) {
    return "heuristic";
  }
  if (field.kind && field.kind !== "text" && field.kind !== "textarea") return "ai";
  if (field.tag === "select" || field.radioGroup) return "ai";

  const token = semanticToken(field);

  if (field.kind === "text" || field.tag === "input") {
    if (field.inputType === "email") return "heuristic";
    if (field.inputType === "url") return "heuristic";
    if (field.inputType === "tel") return "heuristic";
    if (field.inputType === "date" || looksLikeDateField(field)) return "heuristic";
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
    const country = field.phoneCountry?.toUpperCase();
    const candidates = country ? TEST_PHONE_BY_COUNTRY[country] : undefined;
    if (identity.phone && (!country || phoneFitsCountry(identity.phone, country))) {
      return identity.phone;
    }
    return candidates ? pick(candidates, variationSeed, "phone") : profile.phone;
  }

  switch (token) {
    case "given-name":
      return identity.firstName || profile.firstName;
    case "additional-name":
      return identity.middleName || profile.middleName || null;
    case "family-name":
      return identity.lastName || profile.lastName;
    case "name":
      return identity.fullName || profile.fullName;
    case "nickname":
      return identity.preferredName || identity.firstName || profile.preferredName;
    case "username":
      return identity.username || identity.email?.split("@")[0] || profile.username;
    case "street-address":
    case "address-line1":
      return identity.street || profile.street;
    case "address-line2":
      return null;
    case "address-level2":
      return identity.city || profile.city;
    case "postal-code":
      return identity.postalCode || profile.postalCode;
    case "country":
    case "country-name":
      return identity.country || profile.country;
    case "bday":
      return identity.dateOfBirth || profile.dateOfBirth;
    case "bday-year":
      return identity.birthYear || profile.birthYear;
    default:
      break;
  }

  if (looksLikeDateField(field)) {
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    const dayOffset = looksLikeEndDateField(field)
      ? numberFrom(variationSeed, "end-date", 14, 90)
      : numberFrom(variationSeed, "start-date", 0, 5);
    start.setDate(start.getDate() + (looksLikeEndDateField(field) ? dayOffset : -dayOffset));
    const iso = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
    return formatDateForControl(iso, field);
  }

  return null;
}
