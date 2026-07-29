import type { FieldDescriptor, FieldOption } from "../../shared/types";
import type { FieldIdentityParts } from "../fieldId";

/**
 * A widget adapter teaches the scanner and the applier about one family of
 * controls. Splitting this out keeps ARIA-only widgets (which have no `value`
 * property and are driven entirely by clicks) from leaking special cases into
 * the native code path.
 */

export interface DescribeContext {
  /** Mints the synthetic id, so identity rules stay in one place. */
  allocateSid: (el: Element, parts: FieldIdentityParts) => string;
  isVisible: (el: HTMLElement) => boolean;
  /** Shared descriptor fields the scanner already knows how to compute. */
  commonParts: (el: HTMLElement) => CommonDescriptorParts;
}

export interface CommonDescriptorParts {
  labelText?: string;
  ariaLabel?: string;
  formPurpose?: string;
  surroundingText?: string;
  describedByText?: string;
  fieldLocale?: string;
  groupKey?: string;
  groupLabel?: string;
  ariaInvalid?: boolean;
  validationMessage?: string;
  required?: boolean;
}

export interface WidgetInstance {
  descriptor: FieldDescriptor;
  /** Elements the applier drives. A radio group owns several. */
  elements: HTMLElement[];
}

export interface WidgetAdapter {
  readonly name: string;
  /** CSS used to find candidates; the scanner queries all adapters' selectors. */
  readonly selector: string;
  /** Rejects elements the selector matched but this adapter does not own. */
  match(el: HTMLElement): boolean;
  describe(el: HTMLElement, ctx: DescribeContext): WidgetInstance | null;
  /** Current value in the same encoding `describe` reports. */
  read(instance: WidgetInstance): string;
  apply(instance: WidgetInstance, value: string): Promise<ApplyReport>;
}

export interface ApplyReport {
  success: boolean;
  appliedValue?: string;
  reason?: string;
}

export function optionSignatureOf(options: FieldOption[] | undefined): string | undefined {
  if (!options || options.length === 0) return undefined;
  return options
    .slice(0, 25)
    .map((option) => `${option.value}=${option.label}`)
    .join(",");
}
