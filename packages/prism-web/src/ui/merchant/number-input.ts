export type NumericDraftOptions = {
  integer?: boolean;
  allowNegative?: boolean;
};

/** Validates partial numeric text while typing (including empty, "-", "."). */
export function isValidNumericDraft(
  raw: string,
  options: NumericDraftOptions = {},
): boolean {
  const { integer = false, allowNegative = false } = options;
  if (integer && allowNegative) return /^-?\d*$/.test(raw);
  if (integer) return /^\d*$/.test(raw);
  if (allowNegative) return /^-?\d*\.?\d*$/.test(raw);
  return /^\d*\.?\d*$/.test(raw);
}

/**
 * Converts a valid numeric draft to a number, treating empty as `0`, and
 * returns `null` for incomplete prefixes ("-", ".", "-.") or invalid text.
 */
export function parseNumericDraft(
  raw: string,
  options: NumericDraftOptions = {},
): number | null {
  if (!isValidNumericDraft(raw, options)) return null;
  if (raw === "") return 0;
  if (raw === "-" || raw === "." || raw === "-.") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed === 0 ? 0 : parsed;
}

/** Formats stored numbers without "-0" or non-finite placeholders. */
export function formatNumericValue(value: number): string {
  return Number.isFinite(value) ? String(value === 0 ? 0 : value) : "";
}
