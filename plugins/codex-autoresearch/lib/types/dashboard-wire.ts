import { unknownRecordOrEmpty, type UnknownRecord } from "./json.js";

export const DASHBOARD_PAYLOAD_VERSION = 1;

export interface DashboardWireConfig extends UnknownRecord {
  name?: string;
  goal?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher" | string;
}

export interface DashboardWireRun extends UnknownRecord {
  run?: number;
  metric?: number | null;
  status?: string;
  description?: string;
  segment?: number;
}

export interface DashboardWireState extends UnknownRecord {
  config: DashboardWireConfig;
  current?: DashboardWireRun[];
  results?: DashboardWireRun[];
  segment?: number;
  workDir?: string;
  cwd?: string;
}

export interface DashboardWireSettings extends UnknownRecord {
  deliveryMode?: string;
  liveUrl?: string;
  pluginVersion?: string;
  generatedAt?: string;
  sourceCwd?: string;
}

export interface DashboardContext {
  state: DashboardWireState;
  settings?: DashboardWireSettings;
  commands?: Array<UnknownRecord>;
  setupPlan?: UnknownRecord | null;
  guidedSetup?: UnknownRecord | null;
  qualityGap?: UnknownRecord | null;
  finalizePreview?: UnknownRecord | null;
  recipes?: UnknownRecord[];
  experimentMemory?: UnknownRecord | null;
  drift?: UnknownRecord | null;
  warnings?: unknown[];
}

/** Validate the backend-to-dashboard trust boundary before deriving a readout. */
export function parseDashboardContext(value: unknown): DashboardContext {
  const context = unknownRecordOrEmpty(value);
  if (!Object.keys(context).length) throw new TypeError("Dashboard context must be an object.");
  const state = requiredRecord(context.state, "Dashboard context.state");
  const config = requiredRecord(state.config, "Dashboard context.state.config");
  validateOptionalString(config.name, "Dashboard context.state.config.name");
  validateOptionalString(config.goal, "Dashboard context.state.config.goal");
  validateOptionalString(config.metricName, "Dashboard context.state.config.metricName");
  validateOptionalString(config.metricUnit, "Dashboard context.state.config.metricUnit");
  validateOptionalString(config.bestDirection, "Dashboard context.state.config.bestDirection");

  return {
    state: {
      ...state,
      config,
      current: runArray(state.current, "Dashboard context.state.current"),
      results: runArray(state.results, "Dashboard context.state.results"),
    },
    settings: optionalRecord(context.settings, "Dashboard context.settings"),
    commands: recordArray(context.commands, "Dashboard context.commands"),
    setupPlan: optionalRecord(context.setupPlan, "Dashboard context.setupPlan"),
    guidedSetup: optionalRecord(context.guidedSetup, "Dashboard context.guidedSetup"),
    qualityGap: optionalRecord(context.qualityGap, "Dashboard context.qualityGap"),
    finalizePreview: optionalRecord(context.finalizePreview, "Dashboard context.finalizePreview"),
    recipes: recordArray(context.recipes, "Dashboard context.recipes"),
    experimentMemory: optionalRecord(
      context.experimentMemory,
      "Dashboard context.experimentMemory",
    ),
    drift: optionalRecord(context.drift, "Dashboard context.drift"),
    warnings: optionalArray(context.warnings, "Dashboard context.warnings"),
  };
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function optionalRecord(value: unknown, label: string): UnknownRecord | undefined;
function optionalRecord(value: unknown, label: string): UnknownRecord | null | undefined;
function optionalRecord(value: unknown, label: string): UnknownRecord | null | undefined {
  if (value == null) return value;
  const record = unknownRecordOrEmpty(value);
  if (!Object.keys(record).length && !isPlainRecord(value)) {
    throw new TypeError(`${label} must be an object when provided.`);
  }
  return record;
}

function recordArray(value: unknown, label: string): UnknownRecord[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array when provided.`);
  return value.map((item, index) => {
    if (!isPlainRecord(item)) throw new TypeError(`${label}[${index}] must be an object.`);
    return item;
  });
}

function runArray(value: unknown, label: string): DashboardWireRun[] | undefined {
  const records = recordArray(value, label);
  return records?.map((record, index) => {
    validateOptionalFiniteNumber(record.run, `${label}[${index}].run`);
    validateOptionalFiniteNumber(record.metric, `${label}[${index}].metric`, true);
    validateOptionalFiniteNumber(record.segment, `${label}[${index}].segment`);
    validateOptionalString(record.status, `${label}[${index}].status`);
    validateOptionalString(record.description, `${label}[${index}].description`);
    return record;
  });
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string when provided.`);
  }
}

function validateOptionalFiniteNumber(value: unknown, label: string, allowNull = false): void {
  if (value === undefined || (allowNull && value === null)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number when provided.`);
  }
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array when provided.`);
  return value;
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
