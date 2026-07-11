export type ChartPointOpener = HTMLElement | SVGElement | null;

type ChartPointLabelInput = {
  best?: boolean;
  description?: string;
  heldMetric?: boolean;
  latest?: boolean;
  metricDisplay?: string;
  rawMetric?: number | null;
  runNumber: number;
  statusLabel?: string;
  timestampLabel?: string;
};

const FOCUSABLE_DIALOG_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function chartPointAriaLabel(point: ChartPointLabelInput | number): string {
  if (typeof point === "number") return `Open details for run ${point}`;
  return `Open details for ${chartPointSelectionText(point)}`;
}

export function chartPointSelectionText(point: ChartPointLabelInput): string {
  const markers = [
    point.latest ? "latest plotted run" : "",
    point.best ? "best kept run" : "",
    point.heldMetric ? "plotted at nearest successful metric" : "",
  ].filter(Boolean);
  const metric =
    point.rawMetric == null && point.heldMetric
      ? `${point.metricDisplay || "metric held"}; original metric unavailable`
      : point.metricDisplay || "metric unavailable";
  const suffix = markers.length ? ` ${markers.join(", ")}.` : "";
  return [
    `run ${point.runNumber}.`,
    point.statusLabel ? `Status: ${point.statusLabel}.` : "",
    `Metric: ${metric}.`,
    point.timestampLabel ? `Time: ${point.timestampLabel}.` : "",
    point.description ? `Summary: ${point.description}.` : "",
    suffix,
  ]
    .filter(Boolean)
    .join(" ");
}

export function restoreChartPointFocus(opener: ChartPointOpener, fallbackSelector: string) {
  let attempts = 0;
  const focusWhenReady = () => {
    if (focusCandidate(opener?.isConnected ? opener : null)) return;
    if (focusCandidate(focusFallback(fallbackSelector))) return;
    attempts += 1;
    if (attempts < 20) window.setTimeout(focusWhenReady, 50);
  };
  window.setTimeout(focusWhenReady, 0);
}

function focusCandidate(target: ChartPointOpener) {
  target?.focus();
  return Boolean(target && document.activeElement === target);
}

export function focusFallback(selector: string) {
  for (const target of focusFallbackCandidates(selector)) {
    if (focusCandidate(target)) return target;
  }
  return null;
}

function focusFallbackCandidates(selector: string) {
  const candidates: HTMLElement[] = [];
  try {
    const selected = selector ? document.querySelector<HTMLElement>(selector) : null;
    if (selected) candidates.push(selected);
  } catch {
    // Fall back to stable chart targets when a selector was empty or stale.
  }
  for (const fallbackSelector of ["#trend-chart-range", "#trend-panel"]) {
    const target = document.querySelector<HTMLElement>(fallbackSelector);
    if (target && !candidates.includes(target)) candidates.push(target);
  }
  return candidates;
}

export function getFocusableDialogElements(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_DIALOG_SELECTOR) || []).filter(
    (item) => !item.hasAttribute("disabled") && !item.getAttribute("aria-hidden"),
  );
}
