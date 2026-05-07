import { useCallback, useState } from "react";

export function useCopyText(resetMs = 1600) {
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setStatus("success");
        window.setTimeout(() => setStatus("idle"), resetMs);
        return true;
      } catch {
        setStatus("error");
        window.setTimeout(() => setStatus("idle"), resetMs);
        return false;
      }
    },
    [resetMs],
  );

  return { copied: status === "success", copy, status };
}
