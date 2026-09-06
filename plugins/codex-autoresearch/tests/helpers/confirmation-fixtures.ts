import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import type { GitHubTransport } from "../../lib/github-artifact.js";
import { outcomeObject } from "../../lib/outcome-contract.js";

export function artifactZip(name: string, value: unknown) {
  const file = Buffer.from(name),
    bytes = Buffer.from(JSON.stringify(value));
  const checksum = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(header.length + file.length + bytes.length, 16);
  const archive = Buffer.concat([header, file, bytes, central, file, end]);
  return { archive, digest: createHash("sha256").update(archive).digest("hex") };
}
export const confirmationRevision = "a".repeat(40);
export class FakeConfirmationTransport implements GitHubTransport {
  calls = 0;
  uncertain = false;
  inputs: Record<string, unknown> = {};
  receiptDelta: Record<string, unknown> = {};
  runDelta: Record<string, unknown> = {};
  repository = "fixture/evaluator";
  constructor(readonly candidate: ReturnType<typeof artifactZip>) {}
  receipt() {
    return artifactZip("receipt.json", {
      schemaVersion: 1,
      attemptId: this.inputs.attempt_id,
      runId: 123,
      runAttempt: 1,
      repository: this.repository,
      workflow: ".github/workflows/confirm.yml",
      workflowRevision: confirmationRevision,
      candidateArtifactDigest: this.inputs.candidate_artifact_digest,
      candidateInputDigest: this.inputs.candidate_input_digest,
      protocolDigest: this.inputs.protocol_digest,
      datasetId: this.inputs.dataset_id,
      criterionIds: JSON.parse(String(this.inputs.criterion_ids)),
      environment: this.inputs.environment,
      checksPassed: true,
      executionSeconds: 0.1,
      observation: { kind: "predicate", observed: "satisfied" },
      feedback: ["Synthetic fixture passed"],
      ...this.receiptDelta,
    });
  }
  run() {
    return {
      id: 123,
      run_attempt: 1,
      event: "workflow_dispatch",
      path: ".github/workflows/confirm.yml",
      head_sha: confirmationRevision,
      repository: { full_name: this.repository },
      display_title: `autoresearch-confirmation:${this.inputs.attempt_id}`,
      created_at: new Date().toISOString(),
      status: "completed",
      conclusion: "success",
      ...this.runDelta,
    };
  }
  async json(
    endpoint: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> {
    if (endpoint.endsWith("/dispatches")) {
      this.calls++;
      const inputs = outcomeObject(outcomeObject(options.body, "dispatch").inputs, "inputs");
      this.inputs = outcomeObject(JSON.parse(String(inputs.confirmation)), "confirmation inputs");
      if (this.uncertain) throw new Error("Connection lost after accepted dispatch");
      return { workflow_run_id: 123 };
    }
    if (endpoint.includes("/commits/")) return { sha: confirmationRevision };
    if (endpoint.includes("/runs?")) return { total_count: 1, workflow_runs: [this.run()] };
    if (endpoint.endsWith("/workflows/confirm.yml"))
      return { path: ".github/workflows/confirm.yml", state: "active", id: 5 };
    if (endpoint.endsWith("/artifacts/10"))
      return { id: 10, digest: `sha256:${this.candidate.digest}`, expired: false };
    if (endpoint.endsWith("/runs/123")) return this.run();
    if (endpoint.endsWith("/runs/123/artifacts?per_page=100"))
      return {
        total_count: 1,
        artifacts: [
          {
            id: 20,
            name: `autoresearch-confirmation-${this.inputs.attempt_id}`,
            digest: `sha256:${this.receipt().digest}`,
            expired: false,
            workflow_run: { id: 123 },
          },
        ],
      };
    throw new Error(`Unexpected fake endpoint: ${endpoint}`);
  }
  async artifact(endpoint: string): Promise<Buffer> {
    if (endpoint.endsWith("/artifacts/10/zip")) return this.candidate.archive;
    if (endpoint.endsWith("/artifacts/20/zip")) return this.receipt().archive;
    throw new Error("Unknown fake artifact");
  }
}
