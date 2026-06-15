import { useCopyText } from "../hooks/useCopyText";
import type { DashboardMode, DashboardViewModel, MissionStep } from "../types";

const STATE_CLASS: Record<string, string> = {
  done: "mission-done",
  active: "mission-active",
  ready: "mission-active",
  blocked: "mission-blocked",
  idle: "mission-idle",
};

const STATE_LABEL: Record<string, string> = {
  done: "Complete",
  active: "Current",
  ready: "Current",
  blocked: "Blocked",
  idle: "Pending",
};

function stateClass(state?: string): string {
  return STATE_CLASS[state || "idle"] || "mission-idle";
}

function stateLabel(state?: string, active?: boolean): string {
  if (active) return "Current";
  return STATE_LABEL[state || "idle"] || "Pending";
}

export function MissionControl({
  viewModel,
  mode,
}: {
  viewModel: DashboardViewModel;
  mode: DashboardMode;
}) {
  const mc = viewModel.missionControl;
  const steps = mc?.steps;
  if (!mc || !steps?.length) return null;

  return (
    <section id="mission-control" className="mission-section" tabIndex={-1}>
      <p className="eyebrow">Mission control</p>
      <ol className="mission-stepper" aria-label="Mission progress">
        {steps.map((step, i) => (
          <MissionStepItem
            key={step.id || i}
            step={step}
            active={step.id === mc.activeStep}
            showCommand={mode.liveRefresh && mode.liveActions}
            last={i === steps.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}

function MissionStepItem({
  step,
  active,
  showCommand,
  last,
}: {
  step: MissionStep;
  active: boolean;
  showCommand: boolean;
  last: boolean;
}) {
  const { copied, copy } = useCopyText();
  const primary = step.primaryCommand as { label?: string; command?: string } | undefined;
  const cmd = primary?.command;
  const label = stateLabel(step.state, active);
  const title = step.title || step.id || "Step";

  return (
    <li
      className={`mission-step ${stateClass(step.state)}${active ? " mission-current" : ""}`}
      aria-current={active ? "step" : undefined}
      aria-label={`${title}: ${label}. ${step.detail || ""}`.trim()}
    >
      <div className="mission-indicator">
        <span className="mission-dot" aria-hidden="true" />
        {!last && <span className="mission-line" aria-hidden="true" />}
      </div>
      <div className="mission-body">
        <strong className="mission-title">{title}</strong>
        <span className="mission-state-text">{label}</span>
        <span className="mission-detail">{step.detail || ""}</span>
        {active && showCommand && cmd && (
          <div className="mission-command">
            <code className="mission-cmd-text" translate="no">
              {cmd}
            </code>
            <button type="button" className="tool-button subtle" onClick={() => copy(cmd)}>
              {copied ? "Copied" : primary?.label || "Copy CLI Command"}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
