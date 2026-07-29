import { beginEpoch, currentEpoch, resetEpoch, sidBelongsToEpoch } from "./fieldId";
import type { FieldDescriptor, RunContext } from "../shared/types";

function createVariationSeed(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return `${Date.now().toString(36)}-${bytes[0].toString(36)}${bytes[1].toString(36)}`;
}

/**
 * Semantic slots worth carrying between steps so that a later "confirm email"
 * or read-only summary matches what was entered earlier.
 */
const IDENTITY_SLOTS: Array<{ slot: string; autoComplete?: RegExp; label?: RegExp }> = [
  { slot: "email", autoComplete: /^email$/, label: /e-?mail|courriel|メール|이메일|correo/i },
  { slot: "firstName", autoComplete: /^given-name$/, label: /first.?name|given.?name|prénom|prenom|名|이름/i },
  { slot: "lastName", autoComplete: /^family-name$/, label: /last.?name|family.?name|surname|nom de famille|姓|성/i },
  { slot: "fullName", autoComplete: /^name$/, label: /full.?name|your name|氏名|お名前|성명/i },
  { slot: "phone", autoComplete: /^tel/, label: /phone|mobile|tel|téléphone|telephone|電話|전화/i },
  { slot: "username", autoComplete: /^username$/, label: /user.?name|login|ユーザー名/i },
  { slot: "password", autoComplete: /^(new|current)-password$/, label: /password|mot de passe|パスワード|비밀번호/i },
  { slot: "street", autoComplete: /^(street-address|address-line1)$/, label: /street|address.?line.?1|adresse|番地/i },
  { slot: "city", autoComplete: /^address-level2$/, label: /city|town|ville|市区町村/i },
  { slot: "postalCode", autoComplete: /^postal-code$/, label: /zip|postal|code postal|郵便番号/i },
  { slot: "country", autoComplete: /^country(-name)?$/, label: /country|pays|国/i },
  { slot: "company", autoComplete: /^organization$/, label: /company|organi[sz]ation|employer|会社|企業/i },
];

function detectIdentitySlot(field: FieldDescriptor): string | null {
  const autoComplete = (field.autoComplete ?? "").toLowerCase().split(/\s+/).pop() ?? "";
  const label = [field.labelText, field.ariaLabel, field.name, field.placeholder]
    .filter(Boolean)
    .join(" ");

  for (const entry of IDENTITY_SLOTS) {
    if (autoComplete && entry.autoComplete?.test(autoComplete)) return entry.slot;
  }
  for (const entry of IDENTITY_SLOTS) {
    if (label && entry.label?.test(label)) return entry.slot;
  }
  return null;
}

/**
 * Mutable state for one fill run.
 *
 * Applied values are scoped to a step epoch. Crossing a step boundary starts a
 * fresh map instead of pruning the old one, which is what stops step 1's values
 * from being replayed into step 2's recycled DOM nodes.
 */
export class RunState {
  private applied: Record<string, string> = {};
  private stepEpoch: number;
  private stepNumber = 0;
  /** sid -> consecutive failed attempts, used to report genuinely stuck fields. */
  private readonly attemptCounts = new Map<string, number>();

  readonly context: RunContext;

  constructor(variationSeed = createVariationSeed()) {
    this.context = {
      variationSeed,
      facts: {},
      identity: {},
      stepSummaries: [],
    };
    resetEpoch();
    this.stepEpoch = beginEpoch();
    this.stepNumber = 1;
  }

  /**
   * Rebuilds state after a full-page navigation so identity/facts survive and
   * the next step starts with a fresh sid epoch.
   */
  static resumeFrom(context: RunContext, nextStep: number): RunState {
    const state = new RunState();
    state.context.variationSeed = context.variationSeed || state.context.variationSeed;
    state.context.facts = { ...context.facts };
    state.context.identity = { ...context.identity };
    state.context.stepSummaries = [...context.stepSummaries];
    state.stepNumber = Math.max(1, nextStep);
    return state;
  }

  get epoch(): number {
    return this.stepEpoch;
  }

  get step(): number {
    return this.stepNumber;
  }

  /** Values applied during the *current* step only. */
  get appliedValues(): Record<string, string> {
    return this.applied;
  }

  /** Opens a new step: fresh applied map, fresh sid namespace. */
  beginStep(summary?: string): number {
    if (summary) this.addStepSummary(summary);
    this.applied = {};
    this.attemptCounts.clear();
    this.stepEpoch = beginEpoch();
    this.stepNumber += 1;
    return this.stepEpoch;
  }

  recordApplied(field: FieldDescriptor | undefined, sid: string, value: string): void {
    this.applied[sid] = value;
    if (!field) return;
    const slot = detectIdentitySlot(field);
    if (!slot) return;
    if (field.inputType === "checkbox" || field.inputType === "radio") return;
    if (!value.trim()) return;
    this.context.identity[slot] = value;
  }

  forgetApplied(sid: string): void {
    delete this.applied[sid];
  }

  /** Drops any recorded sid that no longer belongs to the current step. */
  dropForeignEpochEntries(): void {
    for (const sid of Object.keys(this.applied)) {
      if (!sidBelongsToEpoch(sid, this.stepEpoch)) delete this.applied[sid];
    }
  }

  isCurrentEpoch(): boolean {
    return this.stepEpoch === currentEpoch();
  }

  mergeFacts(facts: Record<string, unknown> | undefined): void {
    if (!facts || typeof facts !== "object") return;
    for (const [key, value] of Object.entries(facts)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 200) continue;
      if (Object.keys(this.context.facts).length >= 40) return;
      this.context.facts[key.slice(0, 40)] = trimmed;
    }
  }

  addStepSummary(summary: string): void {
    const trimmed = summary.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!trimmed) return;
    this.context.stepSummaries.push(trimmed);
    if (this.context.stepSummaries.length > 20) this.context.stepSummaries.shift();
  }

  noteAttempt(sid: string): number {
    const next = (this.attemptCounts.get(sid) ?? 0) + 1;
    this.attemptCounts.set(sid, next);
    return next;
  }

  attempts(sid: string): number {
    return this.attemptCounts.get(sid) ?? 0;
  }
}
