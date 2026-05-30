import { fallbackAiSummary } from "../model";
import type {
  ChecklistItemModel,
  DashboardViewModel,
  FinalizePreviewModel,
  SessionSegment,
} from "../types";

export function ResearchTruthMeter({ viewModel }: { viewModel: DashboardViewModel }) {
  const gap = viewModel.qualityGap || {};
  const truth = viewModel.researchTruth || viewModel.truthMeter || {};
  const open = numeric(truth.open ?? gap.open);
  const closed = numeric(truth.closed ?? gap.closed);
  const total = numeric(truth.total ?? gap.total);
  const hasTotal = total != null && total > 0;
  const score =
    truth.score ??
    truth.percent ??
    (hasTotal ? (open != null ? Math.max(0, total - open) / total : (closed ?? 0) / total) : null);
  const percent = normalizePercent(score);
  const label =
    truth.label ||
    truth.title ||
    (percent == null ? "Research state unknown" : `${percent}% accepted checklist closed`);
  const detail =
    truth.detail ||
    truth.summary ||
    (hasTotal
      ? `${Number.isFinite(open) ? open : 0} open / ${total} total accepted gap${total === 1 ? "" : "s"}.`
      : "No accepted research checklist is embedded in this snapshot.");
  return (
    <section
      className="panel truth-panel"
      id="research-truth-meter"
      aria-label="Research truth meter"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Research truth</p>
          <h2 id="research-truth-title">{label}</h2>
        </div>
        <span className="panel-note">{truth.source || gap.slug || "dashboard state"}</span>
      </div>
      <div
        className="truth-meter"
        id="research-truth-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : percent}
        aria-valuetext={percent == null ? `${label}: unknown progress` : label}
      >
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="truth-detail" id="research-truth-detail">
        {detail}
      </p>
    </section>
  );
}

export function CodexBrief({
  session,
  viewModel,
}: {
  session: SessionSegment;
  viewModel: DashboardViewModel;
}) {
  const summary = (viewModel.aiSummary || fallbackAiSummary(session, viewModel)) as NonNullable<
    DashboardViewModel["aiSummary"]
  >;
  const latestRun = summary.generatedFrom?.latestRun;
  const source =
    summary.source || (latestRun ? `latest #${latestRun} / dashboard state` : "dashboard state");
  return (
    <section className="panel brief-panel" id="codex-brief" aria-label="Codex brief" tabIndex={-1}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">Codex brief</p>
          <h2 id="ai-summary-title">{summary.title}</h2>
        </div>
      </div>
      <div id="ai-summary-happened" className="brief-lines">
        {(summary.happened || []).map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div id="ai-summary-plan" className="brief-plan">
        {(summary.plan || []).map((item) => (
          <p key={item}>{item}</p>
        ))}
      </div>
      <p className="source-line" id="ai-summary-source">
        {source}
      </p>
    </section>
  );
}

export function StrategyMemory({ viewModel }: { viewModel: DashboardViewModel }) {
  const memory = viewModel.experimentMemory || {};
  const lanes = (
    Array.isArray(viewModel.parallelLanes) && viewModel.parallelLanes.length
      ? viewModel.parallelLanes
      : Array.isArray(memory.lanePortfolio)
        ? memory.lanePortfolio
        : []
  ).slice(0, 6);
  const fanoutStatus =
    typeof viewModel.fanoutPlan?.status === "string" ? viewModel.fanoutPlan.status : "";
  const completed = lanes.filter((lane) => laneStatusKey(lane) === "completed").length;
  const active = lanes.filter((lane) =>
    ["active", "ready", "running", "tracking", "planned", "accepted"].includes(laneStatusKey(lane)),
  ).length;
  return (
    <section
      className="panel memory-panel"
      id="strategy-memory"
      aria-label="Strategy lanes"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Strategy lanes</p>
          <h2>Parallel exploration board</h2>
        </div>
        <span className="panel-note">
          {lanes.length
            ? `${active} active / ${completed} done`
            : fanoutStatus || (memory.plateau?.detected ? "Plateau detected" : "No lanes")}
        </span>
      </div>
      <div className="lane-board">
        {lanes.length ? (
          lanes.map((lane) => (
            <article className="strategy-lane-card" key={lane.id || lane.title}>
              <div className="strategy-lane-card__head">
                <strong>{lane.title || lane.label || lane.id || "Lane"}</strong>
                <span className={`status-pill ${laneStatusTone(laneStatusKey(lane))}`}>
                  {lane.status || "tracking"}
                </span>
              </div>
              <div className="strategy-lane-meta">
                <span>{lane.mode || "mode unknown"}</span>
                <span className={`evidence-state ${evidenceStateKey(lane.evidenceStatus)}`}>
                  {lane.evidenceStatus || "evidence pending"}
                </span>
              </div>
              <p>
                {lane.nextActionHint ||
                  lane.recommendation ||
                  "Use ASI to choose the next measured hypothesis."}
              </p>
            </article>
          ))
        ) : (
          <div className="empty">No strategy lanes are embedded in this export.</div>
        )}
      </div>
    </section>
  );
}

export function QualityGapPanel({ viewModel }: { viewModel: DashboardViewModel }) {
  const gap = viewModel.qualityGap || null;
  const title = gap ? `${gap.open ?? 0} open / ${gap.total ?? 0} total` : "No quality gap file";
  const detail = gap
    ? Number(gap.open) === 0 && Number(gap.total) > 0
      ? `Accepted gaps closed. ${gap.roundGuidance?.requiredRefresh || "Start a fresh research round before declaring the domain permanently complete."}`
      : `${gap.slug || "research"} has ${gap.open ?? 0} open accepted gap${Number(gap.open) === 1 ? "" : "s"}.`
    : "Run a project study or gap-candidates pass to create a measurable quality checklist.";
  return (
    <section className="panel gap-panel" aria-label="Quality gap">
      <p className="eyebrow">Quality gap</p>
      <h2 id="quality-gap-title">{title}</h2>
      <p id="quality-gap-detail">{detail}</p>
    </section>
  );
}

export function FinalizationChecklist({ viewModel }: { viewModel: DashboardViewModel }) {
  const checklist = normalizeChecklist(
    viewModel.finalizationChecklist || viewModel.finalizePreview?.checklist,
    viewModel.finalizePreview,
  );
  return (
    <section
      className="panel finalize-panel"
      id="finalization-checklist"
      aria-label="Finalization checklist"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Finalization</p>
          <h2 id="finalization-checklist-title">{checklist.title}</h2>
        </div>
        <span className="panel-note">{checklist.ready ? "Preview ready" : "Preview gated"}</span>
      </div>
      <div className="checklist" id="finalization-checklist-items">
        {checklist.items.map((item) => (
          <div className={`checklist-item ${item.state}`} key={item.id || item.label}>
            <span aria-hidden="true">
              {item.state === "done" ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M5 8l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : item.state === "blocked" ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 1.5l6.5 12H1.5L8 1.5z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <line
                    x1="8"
                    y1="6"
                    x2="8"
                    y2="9.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="4" cy="8" r="1.5" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" />
                  <circle cx="12" cy="8" r="1.5" fill="currentColor" />
                </svg>
              )}
            </span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProcessHygiene({ viewModel }: { viewModel: DashboardViewModel }) {
  const hygiene = (viewModel.processHygiene || {}) as Record<string, unknown>;
  const watchdog = (viewModel.watchdogSummary || {}) as Record<string, unknown>;
  const warnings = toList(hygiene.warnings);
  const status = String(hygiene.status || "unknown");
  return (
    <section
      className="panel process-panel"
      id="process-hygiene"
      aria-label="Process hygiene"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Process hygiene</p>
          <h2 id="process-hygiene-title">
            {status === "needs-attention" ? "Runtime needs attention" : "Runtime provenance"}
          </h2>
        </div>
        <span className="panel-note">{String(hygiene.mode || "unknown")}</span>
      </div>
      <div className="memory-list" id="process-hygiene-detail">
        <div className="memory-lane">
          <strong>Active cwd</strong>
          <span>{String(hygiene.activeCwd || "unknown")}</span>
          <p>{String(hygiene.pluginVersion || "unknown")}</p>
        </div>
        <div className="memory-lane">
          <strong>Server checks</strong>
          <span>{String(hygiene.duplicateServerDetection || "unavailable")}</span>
          <p>{String(hygiene.staleServerDetection || "unavailable")}</p>
        </div>
        <div className="memory-lane">
          <strong>Watchdog</strong>
          <span>{String(watchdog.status || "unknown")}</span>
          <p>{String(watchdog.recommendation || "No watchdog summary embedded.")}</p>
        </div>
        {warnings.length ? (
          <div className="memory-lane">
            <strong>Warnings</strong>
            <span>{warnings.length}</span>
            <p>{warnings[0]}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function laneStatusKey(lane: Record<string, unknown>) {
  const key = String(lane.status || lane.state || lane.evidenceStatus || "tracking").toLowerCase();
  if (["done", "complete", "completed", "accepted", "finished"].includes(key)) return "completed";
  if (["blocked", "failed", "error", "rejected"].includes(key)) return "blocked";
  if (["ready", "active", "running", "tracking", "planned"].includes(key)) return key;
  return "tracking";
}

function laneStatusTone(status: string) {
  if (status === "completed" || status === "accepted") return "good";
  if (status === "blocked") return "warn";
  return "neutral";
}

function evidenceStateKey(value: unknown) {
  const key = String(value || "pending").toLowerCase();
  if (["accepted", "current", "promotion_eligible"].includes(key)) return "accepted";
  if (["rejected", "superseded"].includes(key)) return "rejected";
  if (["quarantined", "suspicious"].includes(key)) return "warning";
  if (["provisional", "pending", "exploratory"].includes(key)) return "provisional";
  return "provisional";
}

function normalizeChecklist(
  source: DashboardViewModel["finalizationChecklist"] | FinalizePreviewModel["checklist"],
  finalizePreview: FinalizePreviewModel = {},
) {
  const sourceObject = !source || Array.isArray(source) ? {} : source;
  const rawItems = Array.isArray(sourceObject.items)
    ? sourceObject.items
    : Array.isArray(source)
      ? source
      : [];
  const ready = Boolean(sourceObject.ready ?? finalizePreview?.ready);
  const warnings = toList(sourceObject.warnings).concat(toList(finalizePreview?.warnings));
  const items: ChecklistItemModel[] = rawItems.length
    ? rawItems.map((item, index) => ({
        id: item.id || `check-${index}`,
        label: item.label || item.title || `Check ${index + 1}`,
        detail:
          item.detail || item.message || item.reason || "Review this finalization prerequisite.",
        state: normalizeState(item.state || item.status || (item.complete ? "done" : "idle")),
      }))
    : [
        {
          id: "kept-evidence",
          label: "Kept evidence",
          detail: finalizePreview?.ready
            ? "Finalize preview found reviewable kept work."
            : "Keep at least one evidenced run before packaging review branches.",
          state: finalizePreview?.ready ? "done" : "idle",
        },
        {
          id: "warnings",
          label: "Warnings",
          detail: warnings.length ? warnings[0] : "No finalization warnings embedded.",
          state: warnings.length ? "blocked" : "done",
        },
        {
          id: "preview",
          label: "Preview only",
          detail:
            finalizePreview?.nextAction ||
            "Dashboard exposes finalize-preview only; branch creation stays outside this UI.",
          state: ready ? "done" : "idle",
        },
      ];
  return {
    title:
      sourceObject.title ||
      (ready ? "Review packet can be previewed" : "Review packet needs evidence"),
    ready,
    items,
  };
}

function normalizeState(value: unknown) {
  const key = String(value || "").toLowerCase();
  if (["done", "pass", "passed", "ok", "complete", "ready"].includes(key)) return "done";
  if (["blocked", "fail", "failed", "error", "warn", "warning"].includes(key)) return "blocked";
  return "idle";
}

function toList(value: unknown) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return String(record.message || record.code || record.title || record.detail || "");
      }
      return String(item || "");
    })
    .filter(Boolean);
}

function numeric(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePercent(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const percent = number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(percent)));
}
