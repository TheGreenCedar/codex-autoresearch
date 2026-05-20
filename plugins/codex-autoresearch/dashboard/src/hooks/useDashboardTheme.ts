import { useEffect, useState } from "react";

export type DashboardTheme = "light" | "dark";

export function useDashboardTheme() {
  const [theme, setTheme] = useState<DashboardTheme>(initialDashboardTheme);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = window.document.documentElement;
    root.classList.toggle("dark-theme", theme === "dark");
    root.classList.toggle("light-theme", theme === "light");
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    try {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (event: MediaQueryListEvent) => {
        try {
          const saved =
            typeof localStorage !== "undefined" ? localStorage.getItem("autoresearch-theme") : null;
          if (!saved) setTheme(event.matches ? "dark" : "light");
        } catch {
          // Ignore storage access errors in restricted browser contexts.
        }
      };
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    } catch {
      return undefined;
    }
  }, []);

  return { theme, setTheme };
}

function initialDashboardTheme(): DashboardTheme {
  if (typeof window === "undefined") return "light";
  try {
    const saved =
      typeof localStorage !== "undefined" ? localStorage.getItem("autoresearch-theme") : null;
    if (saved === "dark" || saved === "light") return saved;
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // Ignore storage and media-query errors in test environments.
  }
  return "light";
}
