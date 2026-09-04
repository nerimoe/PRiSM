export type LegacyRow = Record<string, unknown>;

export function requiredValue(row: LegacyRow, key: string): unknown {
  const value = row[key];
  if (value === null || value === undefined) throw new Error(`Legacy column ${key} is required.`);
  return value;
}

export function requiredString(row: LegacyRow, key: string): string {
  const value = requiredValue(row, key);
  return typeof value === "string" ? value : String(value);
}

export function optionalString(row: LegacyRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

export function requiredNumber(row: LegacyRow, key: string): number {
  const value = toNumber(requiredValue(row, key));
  if (!Number.isFinite(value)) throw new Error(`Legacy column ${key} must be a finite number.`);
  return value;
}

export function optionalNumber(row: LegacyRow, key: string): number | null {
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  const value = toNumber(raw);
  if (!Number.isFinite(value)) throw new Error(`Legacy column ${key} must be a finite number.`);
  return value;
}

export function requiredBoolean(row: LegacyRow, key: string): boolean {
  return toBoolean(requiredValue(row, key), key);
}

export function optionalBoolean(row: LegacyRow, key: string): boolean | null {
  const value = row[key];
  return value === null || value === undefined ? null : toBoolean(value, key);
}

export function requiredJson(row: LegacyRow, key: string): unknown {
  const value = parseJsonValue(requiredValue(row, key), key);
  if (value === null || value === undefined) throw new Error(`Legacy column ${key} is required.`);
  return value;
}

export function optionalJson(row: LegacyRow, key: string): unknown {
  return parseJsonValue(row[key], key);
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function toBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "1", "yes"].includes(normalized)) return true;
    if (["false", "f", "0", "no"].includes(normalized)) return false;
  }
  throw new Error(`Legacy column ${key} must be a boolean-like value.`);
}

function parseJsonValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Legacy column ${key} must contain valid JSON: ${message}`);
  }
}
