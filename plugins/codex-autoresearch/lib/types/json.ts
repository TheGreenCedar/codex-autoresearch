export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type UnknownRecord = Record<string, unknown>;

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unknownRecordOrNull(value: unknown): UnknownRecord | null {
  return isUnknownRecord(value) ? value : null;
}

export function unknownRecordOrEmpty(value: unknown): UnknownRecord {
  return isUnknownRecord(value) ? value : {};
}

export function jsonObjectOrEmpty(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isUnknownRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}
