import { readFile, stat } from "node:fs/promises";

export interface TaskArtifactSummary {
  acceptedTasks: Array<Record<string, unknown>>;
  quarantinedTasks: Array<Record<string, unknown>>;
  warnings: string[];
  totalTasks?: number;
  processedTasks?: number;
  acceptedTaskCount?: number;
  quarantinedTaskCount?: number;
  truncated?: boolean;
}

export interface TaskArtifactPathReference {
  path: string;
}

export interface TaskArtifactInput {
  manifest?: unknown;
  manifestObject?: unknown;
  manifests?: unknown[];
  artifactPaths?: string[];
  artifacts?: Array<string | TaskArtifactPathReference>;
  path?: string;
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TASK_ROWS = 50;
const MAX_TASK_ROW_JSON_BYTES = 4096;

function emptySummary(warnings: string[] = []): TaskArtifactSummary {
  return {
    acceptedTasks: [],
    quarantinedTasks: [],
    warnings,
    totalTasks: 0,
    processedTasks: 0,
    acceptedTaskCount: 0,
    quarantinedTaskCount: 0,
    truncated: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const copied = copyRecord(value);
  const sizeBytes = Buffer.byteLength(JSON.stringify(copied), "utf8");
  if (sizeBytes <= MAX_TASK_ROW_JSON_BYTES) return copied;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    truncated: true,
    sizeBytes,
    maxBytes: MAX_TASK_ROW_JSON_BYTES,
  };
}

function quarantinedRow(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return copyRecord(value);
  }

  return { value };
}

function mergeSummaries(summaries: TaskArtifactSummary[]): TaskArtifactSummary {
  return {
    acceptedTasks: summaries.flatMap((summary) => summary.acceptedTasks),
    quarantinedTasks: summaries.flatMap((summary) => summary.quarantinedTasks),
    warnings: summaries.flatMap((summary) => summary.warnings),
    totalTasks: summaries.reduce((sum, summary) => sum + (summary.totalTasks || 0), 0),
    processedTasks: summaries.reduce((sum, summary) => sum + (summary.processedTasks || 0), 0),
    acceptedTaskCount: summaries.reduce(
      (sum, summary) => sum + (summary.acceptedTaskCount ?? summary.acceptedTasks.length),
      0,
    ),
    quarantinedTaskCount: summaries.reduce(
      (sum, summary) => sum + (summary.quarantinedTaskCount ?? summary.quarantinedTasks.length),
      0,
    ),
    truncated: summaries.some((summary) => summary.truncated === true),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function pathDiagnosticSummary(path: string, reason: string, error: unknown): TaskArtifactSummary {
  const message = errorMessage(error);

  return {
    acceptedTasks: [],
    quarantinedTasks: [{ path, reason, error: message }],
    warnings: [`task artifact ${reason} for ${path}: ${message}`],
  };
}

async function indexTaskArtifactPath(path: string): Promise<TaskArtifactSummary> {
  let contents: string;

  try {
    const stats = await stat(path);
    if (stats.size > MAX_MANIFEST_BYTES) {
      return {
        acceptedTasks: [],
        quarantinedTasks: [
          {
            path,
            reason: "too_large",
            sizeBytes: stats.size,
            maxBytes: MAX_MANIFEST_BYTES,
          },
        ],
        warnings: [
          `task artifact too_large for ${path}: ${stats.size} bytes exceeds ${MAX_MANIFEST_BYTES} byte cap`,
        ],
        totalTasks: 0,
        processedTasks: 0,
        acceptedTaskCount: 0,
        quarantinedTaskCount: 1,
        truncated: true,
      };
    }
  } catch (error) {
    return pathDiagnosticSummary(path, "stat_failed", error);
  }

  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    return pathDiagnosticSummary(path, "read_failed", error);
  }

  try {
    return indexTaskArtifactManifestObject(JSON.parse(contents));
  } catch (error) {
    return pathDiagnosticSummary(path, "malformed_json", error);
  }
}

export function indexTaskArtifactManifestObject(input: unknown): TaskArtifactSummary {
  if (!isRecord(input)) {
    return emptySummary(["task artifact manifest is not an object"]);
  }

  if (!("tasks" in input)) {
    return emptySummary();
  }

  if (!Array.isArray(input.tasks)) {
    return emptySummary(["task artifact manifest tasks field is not an array"]);
  }

  const acceptedTasks: Array<Record<string, unknown>> = [];
  const quarantinedTasks: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const totalTasks = input.tasks.length;
  const rows = input.tasks.slice(0, MAX_TASK_ROWS);
  const truncated = input.tasks.length > rows.length;

  rows.forEach((task, index) => {
    if (!isRecord(task)) {
      quarantinedTasks.push(quarantinedRow(task));
      warnings.push(`malformed task artifact row at index ${index}: task is not an object`);
      return;
    }

    if (typeof task.id !== "string" || task.id.trim() === "") {
      quarantinedTasks.push(boundedRecord(task));
      warnings.push(`malformed task artifact row at index ${index}: task id is missing`);
      return;
    }

    const bounded = boundedRecord(task);
    if (bounded.truncated === true) {
      warnings.push(
        `task artifact row at index ${index} exceeded ${MAX_TASK_ROW_JSON_BYTES} bytes`,
      );
    }
    acceptedTasks.push(bounded);
  });

  if (truncated) {
    warnings.push(
      `task artifact manifest truncated after ${rows.length} of ${input.tasks.length} task rows`,
    );
  }

  return {
    acceptedTasks,
    quarantinedTasks,
    warnings,
    totalTasks,
    processedTasks: rows.length,
    acceptedTaskCount: acceptedTasks.length,
    quarantinedTaskCount: quarantinedTasks.length,
    truncated,
  };
}

export async function indexTaskArtifacts(input: TaskArtifactInput): Promise<TaskArtifactSummary> {
  if (typeof input === "string") {
    return indexTaskArtifactPath(input);
  }

  if (!isRecord(input)) {
    return indexTaskArtifactManifestObject(input);
  }

  const manifests: unknown[] = [];
  const paths: string[] = [];

  if ("manifest" in input) {
    manifests.push(input.manifest);
  }

  if ("manifestObject" in input) {
    manifests.push(input.manifestObject);
  }

  if (Array.isArray(input.manifests)) {
    manifests.push(...input.manifests);
  }

  if (typeof input.path === "string") {
    paths.push(input.path);
  }

  if (Array.isArray(input.artifactPaths)) {
    paths.push(...input.artifactPaths.filter((path) => typeof path === "string"));
  }

  if (Array.isArray(input.artifacts)) {
    for (const artifact of input.artifacts) {
      if (typeof artifact === "string") {
        paths.push(artifact);
      } else if (isRecord(artifact) && typeof artifact.path === "string") {
        paths.push(artifact.path);
      }
    }
  }

  if (manifests.length === 0 && "tasks" in input) {
    manifests.push(input);
  }

  if (manifests.length === 0 && paths.length === 0) {
    return emptySummary();
  }

  return mergeSummaries([
    ...manifests.map(indexTaskArtifactManifestObject),
    ...(await Promise.all(paths.map(indexTaskArtifactPath))),
  ]);
}
