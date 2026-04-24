import type { DashboardEntry, DashboardMeta } from "./types";

const BASELINE_SECONDS = 10;
const BASELINE_MEMORY_MB = 420;

export const DEMO_ENTRIES: DashboardEntry[] = [
  {
    type: "config",
    name: "Indexing Pipeline Speed and Memory Footprint Optimization",
    metricName: "seconds",
    bestDirection: "lower",
    metricUnit: "s",
    metricMode: "weighted_cost",
    metricWeights: { time: 0.7, memory: 0.3 },
    metricMemoryKey: "memory_mb",
    metricFormula:
      "weighted_cost = 0.7 * (seconds / baseline_seconds) + 0.3 * (memory_mb / baseline_memory_mb); lower is better.",
  },
  ...buildDemoRuns(),
];

export const DEMO_META: DashboardMeta = {
  deliveryMode: "live-server",
  liveRefreshAvailable: true,
  liveActionsAvailable: false,
  showcaseMode: true,
  generatedAt: new Date().toISOString(),
  modeGuidance: { title: "Live runboard", detail: "100 embedded packets." },
  viewModel: {
    summary: { segment: 0, confidence: 4.61, runs: 100 },
    nextBestAction: {
      priority: "Next move",
      title: "Confirm the kept index path",
      detail:
        "Compare the fastest indexing path against peak memory and correctness checks before promoting it.",
      utilityCopy:
        "The score already includes time and memory; the next call is about proving the tradeoff is durable.",
      source: "run #100 / metric details",
    },
    missionControl: {
      activeStep: "log",
      steps: [
        {
          id: "setup",
          title: "Setup",
          state: "done",
          detail: "Benchmark contract and metric formula are visible.",
        },
        { id: "measure", title: "Measure", state: "done", detail: "100 embedded packets plotted." },
        {
          id: "log",
          title: "Decision",
          state: "ready",
          detail: "Review the kept path against memory evidence.",
        },
        {
          id: "finalize",
          title: "Finalize",
          state: "idle",
          detail: "Preview after the kept path survives correctness checks.",
        },
      ],
    },
    experimentMemory: {
      latestNextAction:
        "Run correctness and recall checks on the kept index path before promoting it.",
      plateau: { detected: false },
      lanePortfolio: [
        {
          id: "latency",
          title: "Index rebuild speed",
          status: "active",
          nextActionHint: "Preserve the latest 5.62s rebuild path.",
        },
        {
          id: "footprint",
          title: "Peak memory",
          status: "watch",
          nextActionHint: "Keep memory below 220 MB while retaining the faster path.",
        },
      ],
    },
    aiSummary: {
      title: "Promotion candidate is visible",
      happened: ["100 runs logged", "54 kept", "46 rejected, failed, or crashed"],
      plan: [
        "Keep the faster index path only if the 216 MB memory profile stays stable under correctness checks.",
        "Use the weighted score as the cockpit summary, then inspect the raw time and memory split below the chart.",
      ],
      blockers: [],
      source: "latest #100 / live demo state",
    },
  },
};

function buildDemoRuns(): DashboardEntry[] {
  const runs: DashboardEntry[] = [];
  const start = Date.parse("2026-04-23T14:00:00.000Z");
  for (let index = 0; index < 100; index += 1) {
    const run = index + 1;
    const seconds = demoSeconds(run);
    const memory = demoMemory(run);
    const status = demoStatus(run);
    runs.push({
      type: "run",
      run,
      metric: seconds,
      status,
      description: demoDescription(run, status),
      confidence: Number((1 + run / 30).toFixed(2)),
      timestamp: new Date(start + index * 75_000).toISOString(),
      metrics: {
        seconds,
        memory_mb: memory,
      },
      asi: demoAsi(run, seconds, memory, status),
    });
  }
  return runs;
}

function demoSeconds(run: number): number {
  if (run === 1) return BASELINE_SECONDS;
  const slope = 10 - (run - 1) * 0.041;
  const wave = Math.sin(run / 2.7) * 0.28;
  const spike = [19, 38, 57, 74, 96].includes(run) ? 0.82 : 0;
  return Number(Math.max(5.62, slope + wave + spike).toFixed(run === 100 ? 2 : 3));
}

function demoMemory(run: number): number {
  if (run === 1) return BASELINE_MEMORY_MB;
  const slope = 420 - (run - 1) * 2.05;
  const wave = Math.cos(run / 5.2) * 7;
  const spike = [22, 41, 63, 88].includes(run) ? 18 : 0;
  return Math.max(216, Math.round(slope + wave + spike));
}

function demoStatus(run: number): string {
  if (
    run === 1 ||
    run === 8 ||
    run === 13 ||
    run === 21 ||
    run === 28 ||
    run === 36 ||
    run === 44 ||
    run === 51 ||
    run === 60 ||
    run === 68 ||
    run === 77 ||
    run === 85 ||
    run === 94 ||
    run === 100
  ) {
    return "keep";
  }
  if ([11, 47, 72].includes(run)) return "crash";
  if ([17, 58, 83].includes(run)) return "checks_failed";
  return run % 3 === 0 ? "discard" : "keep";
}

function demoDescription(run: number, status: string): string {
  if (run === 1) return "Baseline indexing corpus rebuild";
  if (run === 100) return "Keep faster index path #100";
  if (status === "crash") return `Crash on shard planner experiment #${run}`;
  if (status === "checks_failed") return `Checks failed on candidate path #${run}`;
  if (status === "discard") return `Reject slower index path #${run}`;
  return `Keep faster index path #${run}`;
}

function demoAsi(run: number, seconds: number, memory: number, status: string) {
  const evidence = `METRIC seconds=${seconds} | memory_mb=${memory}`;
  if (status === "crash") {
    return {
      hypothesis: `Push shard parallelism on packet ${run}.`,
      rollback_reason: "Packet crashed before the benchmark completed.",
      evidence,
      next_action_hint:
        "Hold the crash on the previous score and inspect the shard planner rollback path.",
    };
  }
  if (status === "checks_failed") {
    return {
      hypothesis: `Reduce copy pressure on packet ${run}.`,
      rollback_reason: "Correctness checks failed after the faster path completed.",
      evidence,
      next_action_hint: "Compare the faster path against correctness and memory before keeping it.",
    };
  }
  if (status === "discard") {
    return {
      hypothesis: `Try a narrower indexing window on packet ${run}.`,
      rollback_reason: "Slower overall weighted score than the current kept path.",
      evidence,
    };
  }
  return {
    hypothesis: `Trim indexing passes and reuse the warmed segment cache on packet ${run}.`,
    evidence,
    next_action_hint:
      run === 100
        ? "Run correctness and recall checks on the kept index path before promoting it."
        : "Keep compressing rebuild time without letting peak memory rise back above the saved floor.",
  };
}
