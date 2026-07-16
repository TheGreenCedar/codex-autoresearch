import { createHash } from "node:crypto";

export type GitRefComponentOptions = {
  fallback?: string;
  maxLength?: number;
};

function normalizedFallback(value: unknown): string {
  const fallback = String(value || "autoresearch")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fallback || "autoresearch";
}

export function gitRefComponent(
  value: unknown,
  { fallback: fallbackValue = "autoresearch", maxLength = 80 }: GitRefComponentOptions = {},
): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 16) {
    throw new Error("Git ref component maxLength must be an integer of at least 16.");
  }

  const original = String(value || "");
  const fallback = normalizedFallback(fallbackValue);
  let component = original
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  if (!component || component === "@") component = fallback;
  if (/\.lock$/i.test(component)) {
    component = `${component.slice(0, -5).replace(/[.-]+$/g, "") || fallback}-lock`;
  }

  if (component.length > maxLength) {
    const digest = createHash("sha256").update(original).digest("hex").slice(0, 10);
    const prefixLength = maxLength - digest.length - 1;
    const prefix =
      component.slice(0, prefixLength).replace(/[.-]+$/g, "") ||
      fallback.slice(0, prefixLength).replace(/[.-]+$/g, "") ||
      "ref";
    component = `${prefix}-${digest}`;
  }

  component = component.replace(/[.-]+$/g, "");
  if (!component || component === "@") component = fallback;
  if (/\.lock$/i.test(component)) component = `${component.slice(0, -5)}-lock`;
  return component;
}
