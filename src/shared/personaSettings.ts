/** Merge quick persona fields with optional extra JSON for storage in `personaJson`. */

export interface PersonaQuickFields {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

export interface PersonaUiSplit extends PersonaQuickFields {
  advancedJson: string;
}

export function buildPersonaJsonFromUi(
  quick: PersonaQuickFields,
  advancedRaw: string,
): string {
  let base: Record<string, unknown> = {};
  const adv = advancedRaw.trim();
  if (adv) {
    try {
      const parsed: unknown = JSON.parse(adv);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      /* invalid advanced JSON: still persist quick fields */
    }
  }
  const merged: Record<string, unknown> = { ...base };
  const apply = (key: string, value: string): void => {
    const t = value.trim();
    if (t) merged[key] = t;
    else delete merged[key];
  };
  apply("email", quick.email);
  apply("firstName", quick.firstName);
  apply("lastName", quick.lastName);
  apply("phone", quick.phone);
  if (Object.keys(merged).length === 0) return "";
  return JSON.stringify(merged);
}

export function splitPersonaJsonForUi(personaJson: string): PersonaUiSplit {
  const raw = personaJson.trim();
  if (!raw) {
    return { email: "", firstName: "", lastName: "", phone: "", advancedJson: "" };
  }
  let obj: Record<string, unknown>;
  try {
    const p: unknown = JSON.parse(raw);
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return { email: "", firstName: "", lastName: "", phone: "", advancedJson: raw };
    }
    obj = p as Record<string, unknown>;
  } catch {
    return { email: "", firstName: "", lastName: "", phone: "", advancedJson: raw };
  }
  const str = (v: unknown): string =>
    typeof v === "string" ? v : v != null ? String(v) : "";
  const email = str(obj.email);
  const firstName = str(obj.firstName);
  const lastName = str(obj.lastName);
  const phone = str(obj.phone);
  const rest = { ...obj };
  delete rest.email;
  delete rest.firstName;
  delete rest.lastName;
  delete rest.phone;
  const advancedJson =
    Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "";
  return { email, firstName, lastName, phone, advancedJson };
}
