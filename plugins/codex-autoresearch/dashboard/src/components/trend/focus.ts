export type ChartPointOpener = HTMLElement | SVGElement | null;

const FOCUSABLE_DIALOG_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function chartPointAriaLabel(runNumber: number): string {
  return `Open details for run ${runNumber}`;
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
  for (const fallbackSelector of [".chart-point-button", "#trend-panel"]) {
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
