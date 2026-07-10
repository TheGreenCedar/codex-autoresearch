import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MARKER_FILE = ".codex-autoresearch-swap-owner.json";
const OWNER = "codex-autoresearch";
const SCHEMA = 1;

export async function hasDirectorySwapArtifacts(targets) {
  for (const target of targets) {
    if (await pathExists(path.join(path.resolve(target), MARKER_FILE))) return true;
    const parent = path.dirname(path.resolve(target));
    const prefix = `.${path.basename(target)}.codex-autoresearch-`;
    const entries = await fs.readdir(parent).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (entries.some((entry) => nameStartsWith(entry, prefix))) return true;
  }
  return false;
}

export async function recoverDirectorySwapArtifacts(root, targets, options = {}) {
  const operations = resolveOperations(options);
  const onPhase = options.onPhase || (async () => {});
  const rootInfo = await canonicalRoot(root);
  for (const input of targets) {
    const target = await canonicalTarget(rootInfo, input);
    await recoverStaleArtifacts(rootInfo, target, operations, onPhase);
  }
}

/**
 * Replace one or more directories as a transaction. Each replacement is staged and verified
 * before any active target moves. Existing targets are then retained as rollback directories
 * until every staged directory has been installed and verified.
 */
export async function replaceDirectoriesRollbackSafe(root, replacements, options = {}) {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new Error("Directory replacement requires at least one target and source.");
  }

  const operations = resolveOperations(options);
  const onPhase = options.onPhase || (async () => {});
  const rootInfo = await canonicalRoot(root);
  const states = [];
  const targetKeys = new Set();

  for (const replacement of replacements) {
    const target = await canonicalTarget(rootInfo, replacement.target);
    const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
    if (targetKeys.has(targetKey)) {
      throw new Error(`Directory replacement target is duplicated: ${target}`);
    }
    targetKeys.add(targetKey);
    const source = path.resolve(replacement.source);
    await assertPlainDirectory(source, "Replacement source");
    await assertTreeContainsNoLinks(source, "Replacement source tree");
    await assertMarkerAbsent(source, "Replacement source");
    await recoverStaleArtifacts(rootInfo, target, operations, onPhase);

    const token = randomUUID();
    const parent = path.dirname(target);
    const base = path.basename(target);
    const stage = path.join(parent, `.${base}.codex-autoresearch-stage-${token}`);
    const rollback = path.join(parent, `.${base}.codex-autoresearch-rollback-${token}`);
    const state = {
      backedUp: false,
      installed: false,
      marker: { owner: OWNER, root: rootInfo.real, schema: SCHEMA, target, token },
      replacement,
      rollback,
      stage,
      target,
      token,
    };
    states.push(state);
  }

  try {
    for (const state of states) {
      await fs.mkdir(state.stage);
      await writeMarker(state.stage, { ...state.marker, kind: "stage" });
      await onPhase("before-copy", phaseDetails(state));
      await operations.copy(state.replacement.source, stagePayload(state), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      await assertTreeContainsNoLinks(stagePayload(state), "Staged replacement tree");
      await state.replacement.verify?.(stagePayload(state));
      await onPhase("after-copy", phaseDetails(state));
    }
    await onPhase("after-stage", transactionDetails(states));

    for (const state of states) {
      await onPhase("before-backup", phaseDetails(state));
      if (await pathExists(state.target)) {
        await assertSafeTarget(rootInfo, state.target);
        await assertMarkerAbsent(state.target, "Active target");
        await operations.rename(state.target, state.rollback);
        state.backedUp = true;
        try {
          await assertPlainDirectory(state.rollback, "Rollback target");
          await assertTreeContainsNoLinks(state.rollback, "Rollback target");
          await writeMarker(state.rollback, { ...state.marker, kind: "rollback" });
        } catch (error) {
          await restoreAfterMarkerFailure(state, operations, error);
        }
      }
      await onPhase("after-backup", phaseDetails(state));
    }
    await onPhase("after-all-backups", transactionDetails(states));

    for (const state of states) {
      await onPhase("before-install", phaseDetails(state));
      await operations.rename(stagePayload(state), state.target);
      state.installed = true;
      await assertSafeTarget(rootInfo, state.target);
      await state.replacement.verify?.(state.target);
      await onPhase("after-install", phaseDetails(state));
    }
    await onPhase("after-all-installs", transactionDetails(states));
  } catch (error) {
    const restoreErrors = await restoreTransaction(rootInfo, states, operations, onPhase);
    const cleanupErrors = await cleanupStages(rootInfo, states, operations);
    if (restoreErrors.length || cleanupErrors.length) {
      const evidence = states
        .flatMap((state) =>
          state.backedUp ? [state.rollback] : state.recoveryPath ? [state.recoveryPath] : [],
        )
        .join(", ");
      throw new Error(
        [
          `Directory replacement failed: ${errorMessage(error)}`,
          restoreErrors.length
            ? `Directory restoration needs attention: ${restoreErrors.join("; ")}.`
            : "The original target was restored.",
          cleanupErrors.length
            ? `Owned staging cleanup also failed: ${cleanupErrors.join("; ")}.`
            : "",
          evidence ? `Recovery evidence was retained at: ${evidence}.` : "",
          "Inspect the named paths before retrying; no unowned path was removed.",
        ]
          .filter(Boolean)
          .join(" "),
        { cause: error },
      );
    }
    throw error;
  }

  const cleanupErrors = [];
  for (const state of states) {
    if (state.backedUp) {
      try {
        await removeOwnedArtifact(rootInfo, state.rollback, state, "rollback", operations);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      await removeOwnedArtifact(rootInfo, state.stage, state, "stage", operations);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
  }
  if (cleanupErrors.length) {
    throw new Error(
      `Replacement was installed and verified, but owned swap cleanup failed: ${cleanupErrors.join("; ")}. Inspect the retained rollback path before retrying.`,
    );
  }
}

function phaseDetails(state) {
  return {
    rollback: state.rollback,
    stage: state.stage,
    target: state.target,
    token: state.token,
  };
}

function transactionDetails(states) {
  return { replacements: states.map(phaseDetails) };
}

function stagePayload(state) {
  return path.join(state.stage, "payload");
}

async function restoreAfterMarkerFailure(state, operations, markerError) {
  try {
    await operations.rename(state.rollback, state.target);
    state.backedUp = false;
  } catch (restoreError) {
    throw new Error(
      `Could not mark rollback directory ${state.rollback}: ${errorMessage(markerError)}. Restoring ${state.target} also failed: ${errorMessage(restoreError)}. Recover the original directory from the rollback path before retrying.`,
      { cause: markerError },
    );
  }
  throw markerError;
}

async function restoreTransaction(rootInfo, states, operations, onPhase) {
  const errors = [];
  for (const state of [...states].reverse()) {
    try {
      await onPhase("before-restore", phaseDetails(state));
      if (state.installed) {
        await operations.rename(state.target, stagePayload(state));
        state.installed = false;
      }
      if (state.backedUp) {
        await validateOwnedArtifact(rootInfo, state.rollback, state, "rollback");
        await operations.rename(state.rollback, state.target);
        state.backedUp = false;
        state.recoveryPath = state.target;
        await assertSafeTarget(rootInfo, state.target);
        await removeActiveRollbackMarker(rootInfo, state.target, operations, state.marker);
        state.recoveryPath = "";
      }
      await onPhase("after-restore", phaseDetails(state));
    } catch (error) {
      errors.push(`${state.target}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function cleanupStages(rootInfo, states, operations) {
  const errors = [];
  for (const state of states) {
    try {
      if (await pathExists(state.stage)) {
        await removeOwnedArtifact(rootInfo, state.stage, state, "stage", operations);
      }
    } catch (error) {
      errors.push(`${state.stage}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function recoverStaleArtifacts(rootInfo, target, operations, onPhase) {
  const parent = path.dirname(target);
  await assertSafeParent(rootInfo, parent);
  const base = escapeRegExp(path.basename(target));
  const pattern = new RegExp(
    `^\\.${base}\\.codex-autoresearch-(stage|rollback)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
    "i",
  );
  const entries = await operations.readDirectory(parent, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    const prefix = `.${path.basename(target)}.codex-autoresearch-`;
    if (!nameStartsWith(entry.name, prefix)) continue;
    const match = pattern.exec(entry.name);
    if (!match) {
      throw new Error(
        `Unrecognized directory swap artifact ${path.join(parent, entry.name)} does not use the expected owned name. It was not deleted.`,
      );
    }
    const kind = match[1].toLowerCase();
    const token = match[2];
    const artifact = path.join(parent, entry.name);
    const state = {
      marker: { owner: OWNER, root: rootInfo.real, schema: SCHEMA, target, token },
      rollback: kind === "rollback" ? artifact : "",
      stage: kind === "stage" ? artifact : "",
      target,
      token,
    };
    await validateOwnedArtifact(rootInfo, artifact, state, kind);
    artifacts.push({ artifact, kind, state, token });
  }

  const rollbacks = artifacts.filter((artifact) => artifact.kind === "rollback");
  if (rollbacks.length > 1) {
    throw new Error(
      `Multiple owned rollback directories exist for ${target}: ${rollbacks.map((item) => item.artifact).join(", ")}. Inspect them before choosing recovery; none were deleted.`,
    );
  }
  if (rollbacks.length === 1) {
    const rollback = rollbacks[0];
    if (await pathExists(target)) {
      throw new Error(
        `Stale owned rollback directory ${rollback.artifact} exists beside active target ${target}. Inspect both paths and remove only the obsolete owned copy before retrying.`,
      );
    }
    await operations.rename(rollback.artifact, target);
    await assertSafeTarget(rootInfo, target);
    await removeActiveRollbackMarker(rootInfo, target, operations, rollback.state.marker);
    await onPhase("after-stale-rollback-recovery", {
      artifact: rollback.artifact,
      kind: rollback.kind,
      target,
      token: rollback.token,
    });
  } else {
    await recoverActiveRollbackMarker(rootInfo, target, operations, onPhase);
  }

  for (const stage of artifacts.filter((artifact) => artifact.kind === "stage")) {
    if (!(await pathExists(target))) {
      throw new Error(
        `Stale owned staging directory ${stage.artifact} exists while ${target} is missing. Inspect the staged payload before choosing recovery; it was not deleted.`,
      );
    }
    await removeOwnedArtifact(rootInfo, stage.artifact, stage.state, stage.kind, operations);
    await onPhase("after-stale-stage-cleanup", {
      artifact: stage.artifact,
      kind: stage.kind,
      target,
      token: stage.token,
    });
  }
}

async function recoverActiveRollbackMarker(rootInfo, target, operations, onPhase) {
  if (!(await pathExists(path.join(target, MARKER_FILE)))) return;
  await assertSafeTarget(rootInfo, target);
  await removeActiveRollbackMarker(rootInfo, target, operations);
  await onPhase("after-stale-active-marker-cleanup", { target });
}

async function removeActiveRollbackMarker(rootInfo, target, operations, expected = null) {
  if (!isPathInside(rootInfo.real, target)) {
    throw new Error(`Active rollback marker target escapes the trusted root: ${target}`);
  }
  const marker = await readMarker(target, "Active restored target");
  const expectedMarker = expected
    ? { ...expected, kind: "rollback" }
    : {
        kind: "rollback",
        owner: OWNER,
        root: rootInfo.real,
        schema: SCHEMA,
        target,
      };
  for (const [key, value] of Object.entries(expectedMarker)) {
    if (marker?.[key] !== value) {
      throw new Error(`Active restored target marker does not match ${key}: ${target}`);
    }
  }
  if (
    typeof marker.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker.token)
  ) {
    throw new Error(`Active restored target marker has an invalid token: ${target}`);
  }
  try {
    await operations.remove(path.join(target, MARKER_FILE), { force: false });
  } catch (error) {
    throw new Error(
      `The original directory is active at ${target}, but its ownership marker could not be removed: ${errorMessage(error)}. Retry recovery before using this target.`,
      { cause: error },
    );
  }
}

async function removeOwnedArtifact(rootInfo, artifact, state, kind, operations) {
  if (!(await pathExists(artifact))) return;
  await validateOwnedArtifact(rootInfo, artifact, state, kind);
  await operations.remove(artifact, { recursive: true, force: false });
}

async function validateOwnedArtifact(rootInfo, artifact, state, kind) {
  const expected =
    kind === "stage"
      ? path.join(
          path.dirname(state.target),
          `.${path.basename(state.target)}.codex-autoresearch-stage-${state.token}`,
        )
      : path.join(
          path.dirname(state.target),
          `.${path.basename(state.target)}.codex-autoresearch-rollback-${state.token}`,
        );
  if (!samePath(path.resolve(artifact), expected) || !isPathInside(rootInfo.real, expected)) {
    throw new Error(`Refusing cleanup outside the expected owned ${kind} path: ${artifact}`);
  }
  await assertPlainDirectory(expected, `Owned ${kind} directory`);
  await assertTreeContainsNoLinks(expected, `Owned ${kind} directory`);
  const marker = await readMarker(expected, `Owned ${kind} directory`);
  const expectedMarker = { ...state.marker, kind };
  for (const [key, value] of Object.entries(expectedMarker)) {
    if (marker?.[key] !== value) {
      throw new Error(`Owned ${kind} directory marker does not match ${key}: ${expected}`);
    }
  }
}

async function readMarker(directory, label) {
  const markerPath = path.join(directory, MARKER_FILE);
  const markerStat = await fs.lstat(markerPath).catch(() => null);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`${label} is missing a regular ownership marker: ${directory}`);
  }
  try {
    return JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} has an invalid ownership marker: ${errorMessage(error)}`);
  }
}

async function writeMarker(directory, marker) {
  const markerPath = path.join(directory, MARKER_FILE);
  const handle = await fs.open(markerPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertMarkerAbsent(directory, label) {
  if (await pathExists(path.join(directory, MARKER_FILE))) {
    throw new Error(`${label} contains reserved ownership marker ${MARKER_FILE}: ${directory}`);
  }
}

async function canonicalRoot(root) {
  const absolute = path.resolve(root);
  await assertPlainDirectory(absolute, "Directory replacement root");
  return { absolute, real: await fs.realpath(absolute) };
}

async function canonicalTarget(rootInfo, target) {
  const absolute = path.resolve(target);
  if (!isPathInside(rootInfo.absolute, absolute) || samePath(rootInfo.absolute, absolute)) {
    throw new Error(`Refusing directory replacement outside the trusted root: ${absolute}`);
  }
  const safe = path.join(rootInfo.real, path.relative(rootInfo.absolute, absolute));
  await assertSafeParent(rootInfo, path.dirname(safe));
  if (await pathExists(safe)) await assertSafeTarget(rootInfo, safe);
  return safe;
}

async function assertSafeParent(rootInfo, parent) {
  if (!isPathInside(rootInfo.real, parent) && !samePath(rootInfo.real, parent)) {
    throw new Error(`Directory replacement parent escapes the trusted root: ${parent}`);
  }
  let cursor = rootInfo.real;
  for (const segment of path.relative(rootInfo.real, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(cursor);
      stat = await fs.lstat(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Directory replacement parent must not be a symlink, junction, or file: ${cursor}`,
      );
    }
  }
  const realParent = await fs.realpath(parent);
  if (!isPathInside(rootInfo.real, realParent) && !samePath(rootInfo.real, realParent)) {
    throw new Error(`Directory replacement parent resolves outside the trusted root: ${parent}`);
  }
}

async function assertSafeTarget(rootInfo, target) {
  if (!isPathInside(rootInfo.real, target)) {
    throw new Error(`Directory replacement target escapes the trusted root: ${target}`);
  }
  await assertPlainDirectory(target, "Directory replacement target");
  await assertTreeContainsNoLinks(target, "Directory replacement target");
}

async function assertPlainDirectory(directory, label) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `${label} must be a real directory, not a symlink, junction, or file: ${directory}`,
    );
  }
}

async function assertTreeContainsNoLinks(root, label) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not contain symlinks or junctions: ${child}`);
    }
    if (stat.isDirectory()) await assertTreeContainsNoLinks(child, label);
  }
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function nameStartsWith(value, prefix) {
  return process.platform === "win32"
    ? value.toLowerCase().startsWith(prefix.toLowerCase())
    : value.startsWith(prefix);
}

function resolveOperations(options) {
  return {
    copy: options.operations?.copy || fs.cp,
    readDirectory: options.operations?.readDirectory || fs.readdir,
    remove: options.operations?.remove || fs.rm,
    rename: options.operations?.rename || fs.rename,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
