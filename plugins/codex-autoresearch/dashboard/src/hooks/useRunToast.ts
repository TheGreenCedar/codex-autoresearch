import { useEffect, useRef, useState } from "react";
import type { SessionRun } from "../types";

interface RunToast {
  id: number;
  title: string;
  message: string;
  type: "success" | "info" | "warn";
}

export function useRunToast(activeSegment: number, runs: SessionRun[]) {
  const [toast, setToast] = useState<RunToast | null>(null);
  const prevSegment = useRef(activeSegment);
  const prevRunsLength = useRef(runs.length);
  const nextToastId = useRef(0);

  useEffect(() => {
    if (activeSegment === prevSegment.current && runs.length > prevRunsLength.current) {
      const lastRun = runs[runs.length - 1];
      if (lastRun) {
        const statusLabel = lastRun.status.toUpperCase().replace("_", " ");
        setToast({
          id: nextToastId.current++,
          title: `New Run Logged: Run #${lastRun.run}`,
          message: `Status: ${statusLabel} | ${lastRun.description || "No description provided"}`,
          type: toastTypeFor(lastRun.status),
        });
      }
    }
    prevSegment.current = activeSegment;
    prevRunsLength.current = runs.length;
  }, [activeSegment, runs]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  return { dismissToast: () => setToast(null), toast };
}

function toastTypeFor(status: SessionRun["status"]): RunToast["type"] {
  if (status === "keep") return "success";
  if (status === "crash" || status === "checks_failed") return "warn";
  return "info";
}
