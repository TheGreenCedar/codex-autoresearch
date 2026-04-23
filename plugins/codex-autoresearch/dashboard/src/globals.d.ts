import type { DashboardEntry, DashboardMeta } from "./types";

declare global {
  interface Window {
    __AUTORESEARCH_DATA__?: DashboardEntry[];
    __AUTORESEARCH_META__?: DashboardMeta;
    __AUTORESEARCH_DASHBOARD_READY__?: boolean;
  }
}

export {};
