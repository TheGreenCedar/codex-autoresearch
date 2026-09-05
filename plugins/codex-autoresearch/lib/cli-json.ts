import { isResultSemantics } from "./result-semantics.js";

/** Keep the independent result dimensions visible without expanding every projection by eight lines. */
export function formatCliJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value ?? null));
  const render = (item: unknown, depth: number): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (
      isResultSemantics(item) &&
      Object.keys(item).every((key) =>
        [
          "execution",
          "validity",
          "conclusion",
          "movement",
          "attainment",
          "codeAcceptance",
          "kind",
        ].includes(key),
      )
    )
      return JSON.stringify(item);
    const indent = "  ".repeat(depth + 1),
      end = "  ".repeat(depth);
    if (Array.isArray(item)) {
      const inline = JSON.stringify(item);
      if (
        inline.length <= 100 &&
        item.every((entry) => entry === null || typeof entry !== "object")
      )
        return inline;
      return item.length
        ? `[\n${item.map((entry) => indent + render(entry, depth + 1)).join(",\n")}\n${end}]`
        : "[]";
    }
    const entries = Object.entries(item);
    return entries.length
      ? `{\n${entries.map(([key, entry]) => `${indent}${JSON.stringify(key)}: ${render(entry, depth + 1)}`).join(",\n")}\n${end}}`
      : "{}";
  };
  return render(normalized, 0);
}
