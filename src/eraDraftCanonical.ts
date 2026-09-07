import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers.");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot encode cyclic objects.");

  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalValue(item, ancestors));
  } else {
    const record = value as Record<string, unknown>;
    result = Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalValue(record[key], ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}
