import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  assertSafeDirectoryTree,
  assertSafeWriteTarget,
  checkedAtomicWriteFile,
} from "./checked-write.js";
import {
  privateStateCandidatePaths,
  resolvePrivateStateTarget,
  type PrivateStateSpec,
  type PrivateStateTarget,
} from "./git-private-state.js";
import {
  currentSessionMutationLockContext,
  sessionMutationLockLocation,
  withSessionMutationLock,
} from "./session-mutation-lock.js";
import { resolveSessionPaths } from "./session-paths.js";
import { parseJsonlRecords } from "./session-records.js";
import { pendingLogTransactionStateSpec } from "./pending-log-transaction-store.js";
import { progressStateSpec } from "./active-progress-store.js";
import {
  hashOutcomeValue,
  outcomeDigest,
  outcomeId,
  outcomeNumber,
  outcomeObject,
  outcomeString,
  outcomeUsage,
  parseOutcomeContract,
  parseOutcomeState,
  parseResourceSettlement,
  type LegacySource,
  type OutcomeContract,
  type OutcomeReservation,
  type OutcomeState,
  type ResourceSettlement,
} from "./outcome-contract.js";

export function outcomeStateSpec(cwd: string): PrivateStateSpec {
  return {
    scope: "repository",
    fallbackPath: path.join(cwd, ".autoresearch", "v3", "outcome.json"),
    gitRelativePath: "autoresearch/v3/outcome.json",
    label: "outcome",
  };
}

export async function outcomeStateLocation(cwd: string): Promise<PrivateStateTarget> {
  return await resolvePrivateStateTarget(
    await fsp.realpath(cwd),
    outcomeStateSpec(await fsp.realpath(cwd)),
  );
}

export async function readOutcomeBytes(cwd: string): Promise<Buffer | null> {
  const target = await outcomeStateLocation(cwd);
  return await readOutcomeLocation(target);
}

export async function readOutcomeLocation(target: {
  root: string;
  path: string;
}): Promise<Buffer | null> {
  return await readSafeOptional(target.root, target.path);
}

export async function readOutcome(cwd: string): Promise<OutcomeState | null> {
  const bytes = await readOutcomeBytes(cwd);
  if (bytes === null) return null;
  const state = parseOutcomeState(JSON.parse(bytes.toString("utf8")));
  await assertAuthorizedWorktree(state.contract, cwd);
  return state;
}

export async function withOutcomeMutation<T>(
  cwd: string,
  operation: (state: OutcomeState, location: PrivateStateTarget) => Promise<T>,
  additionalLegacyWorktrees: string[] = [],
): Promise<T> {
  const ownedLegacyLock = currentSessionMutationLockContext()?.lockPath;
  const location = await outcomeStateLocation(cwd);
  const lock = await sessionMutationLockLocation(location.root);
  return await withSessionMutationLock(
    lock.root,
    "outcome",
    async () => {
      const state = await readOutcome(cwd);
      if (!state)
        throw new Error("No outcome has been accepted. Start an outcome with an explicit budget.");
      return await withLegacyLocks(
        [...new Set([...state.contract.authorization.worktrees, ...additionalLegacyWorktrees])],
        async () => {
          await assertLegacyUnchanged(state);
          for (const worktree of state.contract.authorization.worktrees)
            await assertLegacyQuiescent(worktree);
          const result = await operation(state, location);
          state.revision += 1;
          await saveOutcome(location, state);
          return result;
        },
        ownedLegacyLock,
      );
    },
    `${lock.path}.outcome`,
  );
}

async function saveOutcome(location: PrivateStateTarget, state: OutcomeState): Promise<void> {
  const parsed = parseOutcomeState(state);
  await checkedAtomicWriteFile(location.root, location.path, `${JSON.stringify(parsed)}\n`, {
    mode: 0o600,
  });
}

export async function startOutcome(
  cwd: string,
  input: unknown,
  options: { adopt?: boolean } = {},
): Promise<OutcomeState> {
  const ownedLegacyLock = currentSessionMutationLockContext()?.lockPath;
  const contract = await canonicalContract(input);
  await assertAuthorizedWorktree(contract, cwd);
  const location = await outcomeStateLocation(cwd);
  for (const worktree of contract.authorization.worktrees) {
    if ((await outcomeStateLocation(worktree)).path !== location.path)
      throw new Error("Authorized worktrees must share the same repository outcome store.");
  }
  const lock = await sessionMutationLockLocation(location.root);
  return await withSessionMutationLock(
    lock.root,
    "outcome",
    async () => {
      const existing = await readOutcome(cwd);
      if (existing) {
        if (existing.contract.digest === contract.digest) return existing;
        throw new Error(
          "An outcome already exists. Amend its accepted authority explicitly; starting again cannot reset its budget.",
        );
      }
      return await withLegacyLocks(
        contract.authorization.worktrees,
        async () => {
          for (const worktree of contract.authorization.worktrees)
            await assertLegacyQuiescent(worktree);
          const sources = (
            await Promise.all(contract.authorization.worktrees.map(captureLegacySources))
          ).flat();
          if (!options.adopt && sources.some((item) => item.digest !== "missing"))
            throw new Error(
              "Legacy session state exists. Use outcome adopt to preserve its history and establish a remaining allowance.",
            );
          const state: OutcomeState = {
            schemaVersion: 3,
            revision: 1,
            contract,
            history: [
              {
                contract,
                at: new Date().toISOString(),
                authorization: contract.authorization.reference,
                reason: options.adopt
                  ? "Adopted with an explicit remaining allowance"
                  : "Outcome accepted",
              },
            ],
            reservations: [],
            investigations: [],
            executions: [],
            evidence: [],
            evaluators: [],
            legacySources: sources,
            lifecycle: { kind: "active" },
            adoption: options.adopt
              ? {
                  allowance: "remaining",
                  priorConsumption: {
                    kind: "unknown",
                    reason:
                      "Legacy model, execution, preparation, and review costs are not reconstructible from a complete trusted accounting record.",
                  },
                }
              : null,
          };
          await assertLegacyUnchanged(state);
          await saveOutcome(location, state);
          return state;
        },
        ownedLegacyLock,
      );
    },
    `${lock.path}.outcome`,
  );
}

export async function amendOutcome(
  cwd: string,
  input: unknown,
  authorization: string,
  reason: string,
): Promise<OutcomeState> {
  outcomeString(authorization, "amendment authorization");
  outcomeString(reason, "amendment reason");
  const next = await canonicalContract(input);
  return await withOutcomeMutation(
    cwd,
    async (state, location) => {
      if (state.contract.id !== next.id)
        throw new Error("An amendment cannot change outcome identity or reset accounting.");
      await assertAuthorizedWorktree(next, cwd);
      for (const worktree of next.authorization.worktrees) {
        if ((await outcomeStateLocation(worktree)).path !== location.path)
          throw new Error("An amendment cannot change the outcome storage owner.");
      }
      if (state.reservations.some((item) => item.settlement.kind !== "measured"))
        throw new Error("Reconcile outstanding execution before changing its authorization.");

      await assertLegacyUnchanged(state);
      for (const worktree of next.authorization.worktrees) await assertLegacyQuiescent(worktree);
      const added = next.authorization.worktrees.filter(
        (worktree) => !state.contract.authorization.worktrees.includes(worktree),
      );
      const sources = (await Promise.all(added.map(captureLegacySources))).flat();
      state.legacySources.push(
        ...sources.filter(
          (source) => !state.legacySources.some((prior) => prior.path === source.path),
        ),
      );
      if (sources.some((source) => source.digest !== "missing"))
        state.adoption ??= {
          allowance: "remaining",
          priorConsumption: {
            kind: "unknown",
            reason:
              "Added worktrees contain historical work without complete consumption telemetry.",
          },
        };
      state.contract = next;
      state.history.push({ contract: next, authorization, reason, at: new Date().toISOString() });
      state.lifecycle = { kind: "active" };
      await assertLegacyUnchanged(state);
      return state;
    },
    next.authorization.worktrees,
  );
}

export interface OutcomeReservationRequest {
  id: string;
  investigationId: string;
  specificationDigest: string;
  seconds: number;
}

export function reserveInOutcome(
  state: OutcomeState,
  request: OutcomeReservationRequest,
  worktree: string,
): OutcomeReservation {
  const normalized = {
    id: outcomeId(request.id),
    investigationId: outcomeId(request.investigationId),
    specificationDigest: outcomeDigest(request.specificationDigest),
    seconds: outcomeNumber(request.seconds, "reservation seconds", Number.MIN_VALUE),
  };
  const existing = state.reservations.find((item) => item.id === normalized.id);
  if (existing) {
    if (
      existing.specificationDigest !== normalized.specificationDigest ||
      existing.seconds !== normalized.seconds ||
      existing.investigationId !== normalized.investigationId ||
      existing.worktree !== worktree
    )
      throw new Error("The reservation identity already belongs to different action content.");
    return existing;
  }
  if (state.lifecycle.kind !== "active")
    throw new Error(
      "This effort is stopped-unmet. An explicitly authorized amendment is required to resume.",
    );
  const usage = outcomeUsage(state);
  if (usage.unknownExecutions)
    throw new Error("Reconcile unknown execution before reserving another action.");
  const budget = state.contract.budget;
  if (budget.actions !== null && usage.actions + 1 > budget.actions)
    throw new Error("Outcome action budget exhausted.");
  const exposure = outcomeNumber(
    usage.measuredSeconds + usage.reservedSeconds + normalized.seconds,
    "execution budget exposure",
  );
  if (budget.executionSeconds !== null && exposure > budget.executionSeconds)
    throw new Error("Outcome execution budget cannot cover this reservation.");
  if (
    budget.deadline !== null &&
    Date.now() + normalized.seconds * 1000 > Date.parse(budget.deadline)
  )
    throw new Error("Outcome deadline cannot cover this reservation.");
  const reservation: OutcomeReservation = {
    ...normalized,
    contractDigest: state.contract.digest,
    worktree,
    reservedAt: new Date().toISOString(),
    settlement: { kind: "reserved" },
  };
  state.reservations.push(reservation);
  return reservation;
}

export async function reserveOutcomeAction(
  cwd: string,
  request: OutcomeReservationRequest,
): Promise<OutcomeReservation> {
  const worktree = await fsp.realpath(cwd);
  return await withOutcomeMutation(cwd, async (state) =>
    reserveInOutcome(state, request, worktree),
  );
}

export function settleInOutcome(
  state: OutcomeState,
  id: string,
  settlement: ResourceSettlement,
): OutcomeReservation {
  const parsed = parseResourceSettlement(settlement);
  if (parsed.kind === "reserved") throw new Error("Settlement cannot restore a reservation.");
  const reservation = state.reservations.find((item) => item.id === id);
  if (!reservation) throw new Error("Unknown execution reservation.");
  if (reservation.settlement.kind === "measured") {
    if (hashOutcomeValue(reservation.settlement) !== hashOutcomeValue(parsed))
      throw new Error("Execution is already settled with different consumption.");
    return reservation;
  }
  reservation.settlement = parsed;
  return reservation;
}

export async function settleOutcomeAction(
  cwd: string,
  id: string,
  settlement: ResourceSettlement,
): Promise<OutcomeReservation> {
  return await withOutcomeMutation(cwd, async (state) => settleInOutcome(state, id, settlement));
}

export async function stopOutcome(cwd: string, reason: string): Promise<OutcomeState> {
  return await withOutcomeMutation(cwd, async (state) => {
    outcomeString(reason, "stop reason");
    if (state.reservations.some((item) => item.settlement.kind !== "measured"))
      throw new Error("Reconcile or cancel active execution before stopping this outcome.");
    state.lifecycle = { kind: "stopped-unmet", at: new Date().toISOString(), reason };
    return state;
  });
}

async function canonicalContract(input: unknown): Promise<OutcomeContract> {
  const contract = parseOutcomeContract(input);
  const worktrees = await Promise.all(
    contract.authorization.worktrees.map((cwd) => fsp.realpath(cwd)),
  );
  const { digest: _digest, ...body } = contract;
  return parseOutcomeContract({
    ...body,
    authorization: { ...body.authorization, worktrees: [...new Set(worktrees)].sort() },
  });
}

async function assertAuthorizedWorktree(contract: OutcomeContract, cwd: string): Promise<void> {
  const real = await fsp.realpath(cwd);
  if (!contract.authorization.worktrees.includes(real))
    throw new Error("This worktree is outside the accepted outcome authorization.");
}

async function withLegacyLocks<T>(
  worktrees: string[],
  operation: () => Promise<T>,
  ownedLegacyLock?: string,
): Promise<T> {
  const locks = (await Promise.all([...worktrees].sort().map(sessionMutationLockLocation))).filter(
    (lock) => lock.path !== ownedLegacyLock,
  );
  const enter = async (index: number): Promise<T> => {
    const lock = locks[index];
    return lock
      ? await withSessionMutationLock(
          lock.root,
          "outcome-adopt",
          async () => enter(index + 1),
          lock.path,
        )
      : await operation();
  };
  return await enter(0);
}

async function assertLegacyQuiescent(cwd: string): Promise<void> {
  for (const target of await privateStateCandidatePaths(cwd, pendingLogTransactionStateSpec(cwd))) {
    if ((await readSafeOptional(cwd, target, true)) !== null)
      throw new Error("Resolve the pending legacy log transaction before adoption.");
  }
  for (const target of await privateStateCandidatePaths(cwd, progressStateSpec(cwd))) {
    const bytes = await readSafeOptional(cwd, target, true);
    if (!bytes) continue;
    let process: ReturnType<typeof outcomeObject>;
    try {
      process = outcomeObject(JSON.parse(bytes.toString("utf8")), "legacy process");
    } catch {
      throw new Error("Legacy process evidence is malformed; resolve it before adoption.");
    }
    if (
      !["completed", "failed", "timed_out", "crashed"].includes(String(process.exitState)) ||
      process.terminationFailed === true
    )
      throw new Error(
        "Legacy process termination is unresolved; observation age does not prove completion.",
      );
  }
}

async function captureLegacySources(cwd: string): Promise<LegacySource[]> {
  const paths = resolveSessionPaths({ workDir: cwd });
  const sources: LegacySource[] = [];
  const files = new Set([paths.ledgerPath, paths.configPath, paths.notesPath, paths.ideasPath]);
  const ledger = await readSafeOptional(cwd, paths.ledgerPath);
  if (ledger) {
    for (const record of parseJsonlRecords(ledger.toString("utf8"), paths.ledgerPath)) {
      const artifacts = record.artifacts;
      if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
        for (const artifact of Object.values(artifacts)) {
          if (typeof artifact === "string" && artifact !== "<outside-workdir>")
            files.add(path.resolve(cwd, artifact));
        }
      }
      if (Array.isArray(record.artifactEvidence)) {
        for (const artifact of record.artifactEvidence) {
          if (
            artifact &&
            typeof artifact === "object" &&
            typeof artifact.path === "string" &&
            artifact.path !== "<outside-workdir>"
          )
            files.add(path.resolve(cwd, artifact.path));
        }
      }
    }
  }
  for (const file of files) {
    sources.push(...(await captureLegacyPath(cwd, file)));
  }
  return [...new Map(sources.map((source) => [source.path, source])).values()];
}

async function captureLegacyPath(root: string, file: string): Promise<LegacySource[]> {
  const stat = await fsp.lstat(file).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!stat?.isDirectory()) {
    const bytes = await readSafeOptional(root, file);
    return [
      {
        kind: "file",
        path: file,
        digest: bytes === null ? "missing" : createHash("sha256").update(bytes).digest("hex"),
        bytesBase64: bytes === null ? null : bytes.toString("base64"),
      },
    ];
  }
  await assertSafeDirectoryTree(root, file);
  const names = (await fsp.readdir(file)).sort();
  const bytes = Buffer.from(JSON.stringify(names));
  const entries: LegacySource[] = [
    {
      kind: "directory",
      path: file,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
    },
  ];
  for (const name of names) entries.push(...(await captureLegacyPath(root, path.join(file, name))));
  return entries;
}

export async function assertLegacyUnchanged(state: OutcomeState): Promise<void> {
  for (const source of state.legacySources) {
    const owner = state.history
      .flatMap((entry) => entry.contract.authorization.worktrees)
      .find((cwd) => source.path.startsWith(`${cwd}${path.sep}`));
    if (!owner) throw new Error("Legacy source is outside the outcome's authorized worktrees.");
    let bytes: Buffer | null;
    if (source.kind === "directory") {
      await assertSafeDirectoryTree(owner, source.path);
      bytes = Buffer.from(JSON.stringify((await fsp.readdir(source.path)).sort()));
    } else bytes = await readSafeOptional(owner, source.path);
    const digest = bytes === null ? "missing" : createHash("sha256").update(bytes).digest("hex");
    if (digest !== source.digest)
      throw new Error(
        `Legacy source drift: ${source.path}. Reconcile it without rewriting imported evidence.`,
      );
  }
}

async function readSafeOptional(
  root: string,
  target: string,
  gitPrivate = false,
): Promise<Buffer | null> {
  // Git-owned transient paths can be outside a linked worktree. Their location is
  // resolved by Git, never taken from a supplied document.
  const safeRoot = gitPrivate ? path.dirname(target) : root;
  if (
    !gitPrivate &&
    (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target)))
  )
    throw new Error("Legacy source path escapes its authorized worktree.");
  try {
    await fsp.lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  await assertSafeWriteTarget(safeRoot, target);
  return await fsp.readFile(target);
}
