import fs from "node:fs";
import { createInterface } from "node:readline";

import { redactEvidenceText } from "./evidence-redaction.js";
import {
  DEFAULT_DECISION_THRESHOLDS,
  resolveDecisionThresholds,
  type DecisionThresholdConfig,
} from "./decision-thresholds.js";
import {
  buildSessionDecisionCapsule,
  matchDecisionRules,
  type SessionDecisionCapsule,
} from "./session-decision-capsule.js";

type LooseObject = Record<string, any>;

export interface SessionForensicsOptions {
  sessionJsonl: string;
  allowSnippets?: boolean;
  maxSnippets?: number;
  maxSnippetChars?: number;
  thresholds?: Partial<DecisionThresholdConfig>;
  createReadStream?: typeof fs.createReadStream;
}

export interface SessionForensicsError {
  ok: false;
  code: "missing_file" | "unreadable_file" | "malformed_jsonl" | "unsupported_session";
  message: string;
  path?: string;
  line?: number;
}

export interface ForensicsSignal {
  kind: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  count?: number;
  source?: string;
  commandHead?: string;
  size?: { tokens?: number; lines?: number };
}

export interface RedactedSnippet {
  source: string;
  text: string;
}

export interface SessionForensicsSummary {
  ok: true;
  sourcePath: string;
  timeWindow: { first: string | null; last: string | null };
  counts: Record<string, number>;
  responseCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  commandClasses: Record<string, number>;
  compactions: number;
  goal: { status: string | null; tokensUsed: number | null; timeUsedSeconds: number | null };
  userCorrections: ForensicsSignal[];
  productSignals: ForensicsSignal[];
  repeatedFamilies: ForensicsSignal[];
  workflowWaste: ForensicsSignal[];
  blockers: ForensicsSignal[];
  decisionCapsule: SessionDecisionCapsule;
  snippets: RedactedSnippet[];
  thresholds: DecisionThresholdConfig;
}

export type SessionForensicsResult = SessionForensicsSummary | SessionForensicsError;

export async function parseSessionForensics(
  options: SessionForensicsOptions,
): Promise<SessionForensicsResult> {
  const sessionJsonl = String(options.sessionJsonl || "");
  if (!sessionJsonl || !fs.existsSync(sessionJsonl)) {
    return {
      ok: false,
      code: "missing_file",
      message: `Session JSONL does not exist: ${sessionJsonl}`,
      path: sessionJsonl,
    };
  }
  const thresholds = resolveDecisionThresholds({
    decisionThresholds: { ...DEFAULT_DECISION_THRESHOLDS, ...options.thresholds },
  });
  const state = createAccumulator(sessionJsonl, thresholds);
  const openStream = options.createReadStream ?? fs.createReadStream;
  const stream = openStream(sessionJsonl, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = String(rawLine).trim();
      if (!line) continue;
      let entry: LooseObject;
      try {
        entry = JSON.parse(line);
      } catch (error: any) {
        stream.destroy();
        return {
          ok: false,
          code: "malformed_jsonl",
          message: `Invalid JSONL at line ${lineNumber}: ${error.message || error}`,
          path: sessionJsonl,
          line: lineNumber,
        };
      }
      observeEntry(state, entry, {
        allowSnippets: options.allowSnippets === true,
        maxSnippetChars: positiveInt(options.maxSnippetChars, 320),
        maxSnippets: positiveInt(options.maxSnippets, 8),
      });
    }
  } catch (error: any) {
    return {
      ok: false,
      code: "unreadable_file",
      message: error.message || String(error),
      path: sessionJsonl,
      line: lineNumber || undefined,
    };
  }
  return finalizeSummary(state);
}

function createAccumulator(sourcePath: string, thresholds: DecisionThresholdConfig) {
  return {
    sourcePath,
    thresholds,
    first: null as string | null,
    last: null as string | null,
    counts: new Map<string, number>(),
    responseCounts: new Map<string, number>(),
    toolCounts: new Map<string, number>(),
    commandClasses: new Map<string, number>(),
    commandTokenCounts: new Map<string, number>(),
    commandLineCounts: new Map<string, number>(),
    totalOutputTokens: 0,
    compactions: 0,
    goalStatus: null as string | null,
    goalTokensUsed: null as number | null,
    goalTimeUsedSeconds: null as number | null,
    snippets: [] as RedactedSnippet[],
    userCorrections: [] as ForensicsSignal[],
    productSignals: [] as ForensicsSignal[],
    repeatedFamilies: [] as ForensicsSignal[],
    workflowWaste: [] as ForensicsSignal[],
    blockers: [] as ForensicsSignal[],
    decisionHints: [] as ForensicsSignal[],
  };
}

function observeEntry(
  state: ReturnType<typeof createAccumulator>,
  entry: LooseObject,
  snippetOptions: { allowSnippets: boolean; maxSnippetChars: number; maxSnippets: number },
) {
  increment(state.counts, String(entry.type || "unknown"));
  if (entry.timestamp) {
    state.first ??= String(entry.timestamp);
    state.last = String(entry.timestamp);
  }
  if (entry.type === "compacted") state.compactions += 1;
  const payload = entry.payload || {};
  if (entry.type !== "response_item") {
    scanGoalSnapshot(state, entry);
    return;
  }
  const payloadType = String(payload.type || "unknown");
  increment(state.responseCounts, payloadType);
  scanGoalSnapshot(state, payload);
  if (payloadType === "message") {
    observeMessage(state, payload, snippetOptions);
    return;
  }
  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    observeFunctionCall(state, payload);
    return;
  }
  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    observeFunctionOutput(state, payload, snippetOptions);
  }
}

function observeMessage(
  state: ReturnType<typeof createAccumulator>,
  payload: LooseObject,
  snippetOptions: { allowSnippets: boolean; maxSnippetChars: number; maxSnippets: number },
) {
  const text = messageText(payload);
  scanDecisionHints(state, text, "message");
  if (
    payload.role === "user" &&
    /\b(no|not|rather|actually|instead|wrong|don't|do not)\b/i.test(text)
  ) {
    state.userCorrections.push(signal("user_correction", "info", summarize(text), "message"));
  }
  if (
    payload.role === "user" &&
    /impossible that you solved it that fast|said you (were )?done|why.*done|false done|not done/i.test(
      text,
    )
  ) {
    state.productSignals.push(
      signal("early_false_done_correction", "blocker", summarize(text), "message"),
    );
  }
  if (/\bapproved\b/i.test(text) && /\b(wait|stall|again|approval|night|waste)\b/i.test(text)) {
    state.productSignals.push(signal("approval_stall", "blocker", summarize(text), "message"));
  }
  if (/\b(ram|cpu|memory|reboot|100%|frozen|hung)\b/i.test(text)) {
    state.workflowWaste.push(
      signal("resource_interruption", "blocker", summarize(text), "message"),
    );
  }
  if (/segment.+not.+best|metric formula|metric details|tell me nothing|chart/i.test(text)) {
    state.productSignals.push(
      signal("dashboard_ux_feedback", "warning", summarize(text), "message"),
    );
  }
  if (/quality_gap|quality gap/i.test(text)) {
    state.productSignals.push(
      signal(
        "quality_gap_wording",
        "warning",
        "Quality-gap wording appeared in session feedback.",
        "message",
      ),
    );
  }
  if (
    payload.role === "user" &&
    (/did not test accuracy|broken experiment|not what I wanted/i.test(text) ||
      (/\bshippable product\b/i.test(text) &&
        /\b(not|n't|no|never|isn't|aren't|wasn't|reject|wrong|broken|unproven|missing proof)\b/i.test(
          text,
        )))
  ) {
    state.productSignals.push(
      signal("product_bar_rejection", "blocker", summarize(text), "message"),
    );
  }
  if (
    payload.role === "assistant" &&
    /treated autoresearch loop completion|wrong product judgment/i.test(text)
  ) {
    state.productSignals.push(
      signal(
        "false_done_admission",
        "warning",
        "Assistant admitted the Autoresearch loop signal was mistaken for product proof.",
        "message",
      ),
    );
  }
  if (
    payload.role === "assistant" &&
    /\b(implemented|finalized|done|complete)\b/i.test(text) &&
    /\b(review remediation|everything|all issues|finalized)\b/i.test(text)
  ) {
    state.productSignals.push(
      signal(
        "early_false_done_claim",
        "warning",
        "Assistant made a broad completion claim before the remediation surface was fully verified.",
        "message",
      ),
    );
  }
  if (/\b(did not push|not pushed|local only|local-only|only locally)\b/i.test(text)) {
    state.productSignals.push(
      signal("finalization_local_only", "blocker", summarize(text), "message"),
    );
  }
  if (/\b(cleanup|deleted worktree|delete branch|remove branch)\b/i.test(text)) {
    state.workflowWaste.push(signal("cleanup_afterthought", "warning", summarize(text), "message"));
  }
  addSnippet(state, "message", text, snippetOptions);
}

function observeFunctionCall(state: ReturnType<typeof createAccumulator>, payload: LooseObject) {
  const name = String(payload.name || "unknown");
  increment(state.toolCounts, name);
  if (name === "write_stdin") increment(state.toolCounts, "shell_poll");
  const args = parseMaybeJson(payload.arguments);
  if (name === "update_goal") {
    scanGoalSnapshot(state, args);
    if (String(args?.status || "").toLowerCase() === "complete") {
      state.productSignals.push(
        signal(
          "goal_churn_or_early_completion",
          "warning",
          "A function call marked the Codex goal complete.",
          "function_call:update_goal",
        ),
      );
    }
  }
  if (name !== "exec_command") return;
  const command = redactEvidenceText(String(args?.cmd || ""));
  const head = commandHead(command);
  if (head) increment(state.commandClasses, head);
}

function observeFunctionOutput(
  state: ReturnType<typeof createAccumulator>,
  payload: LooseObject,
  snippetOptions: { allowSnippets: boolean; maxSnippetChars: number; maxSnippets: number },
) {
  const output = String(payload.output || "");
  scanDecisionHints(state, output.slice(0, 12_000), String(payload.call_id || "tool-output"));
  const tokenCount = Number(output.match(/Original token count:\s*(\d+)/)?.[1] || 0);
  const lineCount = Number(output.match(/Total output lines:\s*(\d+)/)?.[1] || 0);
  state.totalOutputTokens += Number.isFinite(tokenCount) ? tokenCount : 0;
  const callId = String(payload.call_id || "tool-output");
  if (tokenCount) state.commandTokenCounts.set(callId, tokenCount);
  if (lineCount) state.commandLineCounts.set(callId, lineCount);
  if (/exited with code [1-9]/.test(output)) {
    state.blockers.push(signal("command_failed", "warning", summarize(output), callId));
  }
  if (/unknown recipe/i.test(output)) {
    state.blockers.push(signal("unknown_recipe", "warning", summarize(output), callId));
  }
  if (
    /"codexObjectiveRole"\s*:\s*"(missing|operator_instruction|different_research_goal)"/.test(
      output,
    )
  ) {
    state.productSignals.push(
      signal(
        "goal_contract_gap",
        "blocker",
        "Forensics observed a missing or mismatched Codex goal objective in product output.",
        callId,
      ),
    );
  }
  if (/\b(did not push|not pushed|local only|local-only|only locally)\b/i.test(output)) {
    state.productSignals.push(
      signal("finalization_local_only", "blocker", summarize(output), callId),
    );
  }
  if (/\b(cleanup|deleted worktree|delete branch|remove branch)\b/i.test(output)) {
    state.workflowWaste.push(signal("cleanup_afterthought", "warning", summarize(output), callId));
  }
  if (/timed out|timeout/i.test(output)) {
    state.blockers.push(signal("timeout", "warning", summarize(output), callId));
  }
  if (/polling/i.test(output)) {
    state.workflowWaste.push(signal("progress_polling", "warning", summarize(output), callId));
  }
  if (/stdin is closed/i.test(output)) {
    state.workflowWaste.push(
      signal(
        "closed_stdin_poll",
        "warning",
        "A completed foreground session was polled after stdin closed.",
        callId,
      ),
    );
  }
  if (tokenCount >= 20_000) {
    state.workflowWaste.push({
      kind: "oversized_tool_output",
      severity: "warning",
      message: `One tool output reported ${tokenCount} tokens.`,
      source: callId,
      size: { tokens: tokenCount, lines: lineCount || undefined },
    });
  }
  if (tokenCount >= state.thresholds.outputCommandTokenBudget) {
    const duplicateOversized =
      tokenCount >= 20_000 &&
      state.workflowWaste.some((item) => item.kind === "oversized_tool_output");
    if (!duplicateOversized) {
      state.workflowWaste.push({
        kind: "output_budget_exceeded",
        severity: "warning",
        message: `One command output reported ${tokenCount} tokens.`,
        source: callId,
        size: { tokens: tokenCount, lines: lineCount || undefined },
      });
    }
  }
  if (lineCount >= state.thresholds.outputCommandLineBudget) {
    state.workflowWaste.push({
      kind: "output_budget_exceeded",
      severity: "warning",
      message: `One command output reported ${lineCount} lines.`,
      source: callId,
      size: { tokens: tokenCount || undefined, lines: lineCount },
    });
  }
  addSnippet(state, callId, output, snippetOptions);
}

function finalizeSummary(state: ReturnType<typeof createAccumulator>): SessionForensicsSummary {
  for (const [commandHeadValue, count] of state.commandClasses.entries()) {
    if (count >= state.thresholds.repeatedCommandHeadCount) {
      state.workflowWaste.push({
        kind: "verification_churn",
        severity: "warning",
        message: `Command head repeated ${count} times: ${commandHeadValue}`,
        count,
        commandHead: commandHeadValue,
      });
    }
  }
  if ((state.toolCounts.get("shell_poll") || 0) >= state.thresholds.shellPolls) {
    state.workflowWaste.push({
      kind: "progress_polling",
      severity: "warning",
      message: `Shell polling exceeded threshold: ${state.toolCounts.get("shell_poll")} polls.`,
      count: state.toolCounts.get("shell_poll"),
    });
  }
  if (state.totalOutputTokens >= state.thresholds.outputSegmentTokenBudget) {
    state.workflowWaste.push({
      kind: "output_budget_exceeded",
      severity: "warning",
      message: `Session output reported ${state.totalOutputTokens} cumulative tokens.`,
      size: { tokens: state.totalOutputTokens },
    });
  }
  if (state.compactions >= state.thresholds.compactions) {
    state.productSignals.push({
      kind: "context_distillation_required",
      severity: "warning",
      message: `Compactions reached ${state.compactions}; refresh a context capsule before more packets.`,
      count: state.compactions,
    });
  }
  if ((state.toolCounts.get("exec_command") || 0) >= state.thresholds.functionCalls) {
    state.productSignals.push({
      kind: "context_distillation_required",
      severity: "warning",
      message: `Function calls exceeded threshold: ${state.toolCounts.get("exec_command")} exec commands.`,
      count: state.toolCounts.get("exec_command"),
    });
  }
  const userCorrections = dedupeSignals(state.userCorrections);
  const productSignals = dedupeSignals([...state.productSignals, ...state.decisionHints]);
  const repeatedFamilies = dedupeSignals(state.repeatedFamilies);
  const workflowWaste = dedupeSignals(state.workflowWaste);
  const blockers = dedupeSignals(state.blockers);
  const toolCounts = toObject(state.toolCounts);
  const commandClasses = toObject(state.commandClasses);
  return {
    ok: true,
    sourcePath: state.sourcePath,
    timeWindow: { first: state.first, last: state.last },
    counts: toObject(state.counts),
    responseCounts: toObject(state.responseCounts),
    toolCounts,
    commandClasses,
    compactions: state.compactions,
    goal: {
      status: state.goalStatus,
      tokensUsed: state.goalTokensUsed,
      timeUsedSeconds: state.goalTimeUsedSeconds,
    },
    userCorrections,
    productSignals,
    repeatedFamilies,
    workflowWaste,
    blockers,
    decisionCapsule: buildSessionDecisionCapsule({
      compactions: state.compactions,
      first: state.first,
      last: state.last,
      userCorrections,
      productSignals,
      workflowWaste,
      blockers,
      toolCounts,
      commandClasses,
      thresholds: state.thresholds,
    }),
    snippets: state.snippets,
    thresholds: state.thresholds,
  };
}

function scanDecisionHints(
  state: ReturnType<typeof createAccumulator>,
  text: string,
  source: string,
) {
  for (const finding of matchSessionFrictionHints(text, source)) {
    state.decisionHints.push(finding);
  }
  for (const finding of matchDecisionRules(text, source)) {
    state.decisionHints.push(
      signal(finding.kind, finding.severity, finding.message, finding.source),
    );
  }
}

function matchSessionFrictionHints(text: string, source: string): ForensicsSignal[] {
  const findings: ForensicsSignal[] = [];
  const add = (kind: string, severity: ForensicsSignal["severity"], message: string) => {
    findings.push(signal(kind, severity, message, source));
  };
  if (
    /setup alone is not autoresearch|scaffold\b[^.?!;]{0,160}\bnot started|loop did not start/i.test(
      text,
    )
  ) {
    add(
      "setup_not_started",
      "blocker",
      "The session says setup or scaffold work happened, but the measured Autoresearch loop did not start.",
    );
  }
  if (
    /(?:do not|don't) rerun[^.?!;]*(?:baseline|control)|reuse [^.?!;]*fixed control|reuse [^.?!;]*control artifact/i.test(
      text,
    )
  ) {
    add(
      "fixed_control_rerun_correction",
      "blocker",
      "The session corrected a control rerun; reuse the fixed control artifact unless an invalidator changed.",
    );
  }
  if (/old segment|stale segment|picked up [^.?!;]{0,120}segment|unexpected segment/i.test(text)) {
    add(
      "stale_segment_pickup",
      "warning",
      "The session indicates a stale or unexpected segment was picked up.",
    );
  }
  if (hasGoalChurnOrEarlyCompletionEvent(text)) {
    add(
      "goal_churn_or_early_completion",
      "warning",
      "The session indicates Codex goal churn or early completion before loop evidence was resolved.",
    );
  }
  if (
    /hard-?coded|overfit[^.?!;]{0,80}filename|repo-specific assumption|answer-key steering/i.test(
      text,
    )
  ) {
    add(
      "overfit_correction",
      "blocker",
      "The session flags hard-coded, repo-specific, or answer-key-shaped evidence that needs generalization proof.",
    );
  }
  return findings;
}

function hasGoalChurnOrEarlyCompletionEvent(text: string): boolean {
  return goalCompletionSegments(text).some(
    (segment) =>
      hasGoalCompletionEventPhrase(segment) && !hasPreventiveGoalCompletionLanguage(segment),
  );
}

function goalCompletionSegments(text: string): string[] {
  return String(text || "")
    .split(/(?:[\r\n]+|[.!?;]+)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function hasGoalCompletionEventPhrase(segment: string): boolean {
  return (
    /completed (?:the )?(?:Codex )?goal/i.test(segment) ||
    /\bmarked [^.?!;]{0,80}goal [^.?!;]{0,40}complete\b/i.test(segment) ||
    /\bupdate_goal\s*\(\s*status\s*=\s*["']?complete["']?\s*\)/i.test(segment) ||
    /goal churn|early completion/i.test(segment)
  );
}

function hasPreventiveGoalCompletionLanguage(segment: string): boolean {
  return (
    /\b(?:do\s+not|don't|should\s+not|must\s+not|never|cannot|can't)\s+(?:mark|complete|call|treat|use)\b/i.test(
      segment,
    ) ||
    /\bbefore\s+(?:marking|calling|completing|complete)\b/i.test(segment) ||
    /\b(?:until|unless)\b[^.?!;]{0,120}\b(?:mark|complete|completion|update_goal)\b/i.test(
      segment,
    ) ||
    /\b(?:blocked|blocks|blocker|refuse[sd]?|insufficient)\b[^.?!;]{0,120}\b(?:mark|complete|completion|update_goal)\b/i.test(
      segment,
    )
  );
}

function scanGoalSnapshot(state: ReturnType<typeof createAccumulator>, value: unknown) {
  const text = JSON.stringify(value);
  const status = text.match(
    /"status"\s*:\s*"(active|complete|blocked|paused|budget_limited)"/,
  )?.[1];
  if (status) state.goalStatus = status;
  for (const match of text.matchAll(/"tokensUsed"\s*:\s*(\d+)/g)) {
    state.goalTokensUsed = Math.max(state.goalTokensUsed || 0, Number(match[1]));
  }
  for (const match of text.matchAll(/"timeUsed(?:Seconds)?"\s*:\s*(\d+)/g)) {
    state.goalTimeUsedSeconds = Math.max(state.goalTimeUsedSeconds || 0, Number(match[1]));
  }
}

function addSnippet(
  state: ReturnType<typeof createAccumulator>,
  source: string,
  text: string,
  options: { allowSnippets: boolean; maxSnippetChars: number; maxSnippets: number },
) {
  if (!options.allowSnippets || state.snippets.length >= options.maxSnippets) return;
  const clean = redactEvidenceText(summarize(text, options.maxSnippetChars));
  if (!clean) return;
  state.snippets.push({ source, text: clean });
}

function messageText(payload: LooseObject): string {
  const content = payload.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object")
          return part.text || part.input_text || part.output_text || "";
        return "";
      })
      .join("\n");
  }
  return String(content || "");
}

function signal(
  kind: string,
  severity: ForensicsSignal["severity"],
  message: string,
  source?: string,
): ForensicsSignal {
  return { kind, severity, message, ...(source ? { source } : {}) };
}

function summarize(text: string, maxChars = 220): string {
  return redactEvidenceText(
    String(text || "")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, maxChars);
}

function commandHead(command: string): string {
  return String(command || "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
}

function parseMaybeJson(value: unknown): LooseObject | null {
  if (!value) return null;
  if (typeof value === "object") return value as LooseObject;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function toObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function dedupeSignals(signals: ForensicsSignal[]): ForensicsSignal[] {
  const seen = new Set<string>();
  const out = [];
  for (const signalValue of signals) {
    const key = `${signalValue.kind}\n${signalValue.message}\n${signalValue.source || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signalValue);
  }
  return out.slice(0, 50);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
