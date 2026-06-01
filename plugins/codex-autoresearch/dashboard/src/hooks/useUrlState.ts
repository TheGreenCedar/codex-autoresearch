import { useCallback, useEffect, useState } from "react";

function readUrlParam(key: string, allowed: readonly string[], fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = new URLSearchParams(window.location.search).get(key);
    if (raw && allowed.includes(raw)) return raw;
  } catch {
    // Ignore URL parsing errors in restricted browser contexts.
  }
  return fallback;
}

function writeUrlParam(key: string, value: string, fallback: string): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (value === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // Keep the dashboard usable when history updates are blocked by policy.
  }
}

export function getUrlValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

export function setUrlValue(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (value == null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // Keep the dashboard usable when history updates are blocked by policy.
  }
}

export function useUrlParam(
  key: string,
  allowed: readonly string[],
  fallback: string,
): [string, (value: string) => void] {
  const [value, setValue] = useState(() => readUrlParam(key, allowed, fallback));

  const update = useCallback(
    (next: string) => {
      setValue(next);
      writeUrlParam(key, next, fallback);
    },
    [key, fallback],
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => setValue(readUrlParam(key, allowed, fallback));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [allowed, fallback, key]);

  return [value, update];
}
