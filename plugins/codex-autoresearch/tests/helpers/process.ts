import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const quoteForShell = (value) => {
  return JSON.stringify(String(value));
};

export const processResult = (code, stdout, stderr) => ({ code, stdout, stderr });

const spawnTestProcess = (command, args, cwd, stdio, env) => {
  const options = {
    cwd,
    ...(env ? { env } : {}),
    windowsHide: true,
    shell: false,
    stdio,
  };
  if (command === process.execPath) {
    return spawn(process.execPath, args, options);
  }
  switch (command) {
    case "git":
      return spawn("git", args, options);
    case "tar":
      return spawn("tar", args, options);
    default:
      throw new Error(`Refusing to spawn unlisted test command: ${command}`);
  }
};

const captureProcessOutput = (child, onStdout) => {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    onStdout?.(stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const resolveWithProcessResult = (child, output, resolve) => {
  child.on("error", (error) =>
    resolve(processResult(-1, output.stdout(), String(error.message || error))),
  );
  child.on("close", (code) => resolve(processResult(code, output.stdout(), output.stderr())));
};

const processOptions = (cwdOrOptions) =>
  typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;

export const runProcess = (command, args, cwdOrOptions) => {
  const options = processOptions(cwdOrOptions);
  return new Promise((resolve) => {
    const child = spawnTestProcess(
      command,
      args,
      options.cwd,
      ["ignore", "pipe", "pipe"],
      options.env,
    );
    const output = captureProcessOutput(child);
    resolveWithProcessResult(child, output, resolve);
  });
};

export const runInteractiveProcess = (command, args, answers, cwd) => {
  return new Promise((resolve) => {
    const child = spawnTestProcess(command, args, cwd, ["pipe", "pipe", "pipe"]);
    let answered = 0;
    let seenPrompts = 0;
    const output = captureProcessOutput(child, (stdout) => {
      const promptCount = (stdout.match(/: /g) || []).length;
      while (seenPrompts < promptCount && answered < answers.length) {
        child.stdin.write(`${answers[answered]}\n`);
        answered += 1;
        seenPrompts += 1;
      }
      if (answered === answers.length && !child.stdin.destroyed) child.stdin.end();
    });
    resolveWithProcessResult(child, output, resolve);
  });
};

const cliModuleCache = new Map();

const cliModule = async (cli) => {
  const href = pathToFileURL(cli).href;
  if (!cliModuleCache.has(href)) cliModuleCache.set(href, import(href));
  return await cliModuleCache.get(href);
};

const shouldSpawnCli = (args, options = {}) => {
  if (options.spawn === true) return true;
  if (options.env) return true;
  if (process.env.CODEX_AUTORESEARCH_TEST_SPAWN_CLI === "1") return true;
  return args?.[0] === "serve";
};

const runCliInProcess = async (cli, args, cwd) => {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";
  try {
    process.chdir(cwd);
    process.exitCode = undefined;
    const mod = await cliModule(cli);
    assert.equal(
      typeof mod.runAutoresearchCli,
      "function",
      "CLI module must export runAutoresearchCli for fast in-process tests",
    );
    const code = await mod.runAutoresearchCli(args, {
      stdout: (text) => {
        stdout += `${text}\n`;
      },
      stderr: (text) => {
        stderr += `${text}\n`;
      },
    });
    return processResult(code, stdout, stderr);
  } catch (error) {
    stderr += `${error?.stack || error?.message || String(error)}\n`;
    return processResult(-1, stdout, stderr);
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }
};

export const createCliRunner = (cli, defaultCwd) => {
  return (args, options = {}) =>
    shouldSpawnCli(args, options)
      ? createSpawnedCliRunner(cli, defaultCwd)(args, options)
      : runCliInProcess(cli, args, options.cwd || defaultCwd);
};

export const createFastCliRunner = (cli, defaultCwd) => {
  return (args, options = {}) => runCliInProcess(cli, args, options.cwd || defaultCwd);
};

export const createSpawnedCliRunner = (cli, defaultCwd) => {
  return (args, options = {}) =>
    runProcess(process.execPath, [cli, ...args], {
      cwd: options.cwd || defaultCwd,
      env: options.env,
    });
};

export const createInteractiveCliRunner = (cli, defaultCwd) => {
  return (args, answers, options = {}) =>
    runInteractiveProcess(process.execPath, [cli, ...args], answers, options.cwd || defaultCwd);
};

export const withProcess = async (command, args, cwd, fn) => {
  const child = spawnTestProcess(command, args, cwd, ["ignore", "pipe", "pipe"]);
  const output = captureProcessOutput(child);
  try {
    return await fn(child, output.stdout, output.stderr);
  } finally {
    child.kill();
  }
};

export const withTempDir = async (prefix, name, fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-${name}-`));
  try {
    return await fn(dir);
  } finally {
    await rmWithRetries(dir);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rmWithRetries = async (dir) => {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code || "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
      await sleep(Math.min(1000, 100 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch(() => {
    if (process.env.CODEX_AUTORESEARCH_TEST_STRICT_CLEANUP === "1") {
      if (lastError) throw lastError;
      throw new Error(`Failed to remove temp dir ${dir}`);
    }
    console.warn(`warning: temp cleanup deferred for ${dir}`);
  });
};

const testGitConfigEntries = [
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["core.autocrlf", "false"],
  ["core.hooksPath", ""],
  ["user.email", "codex@example.invalid"],
  ["user.name", "Codex Test"],
];

export const testGitArgs = (args) =>
  testGitConfigEntries.flatMap(([key, value]) => ["-c", `${key}=${value}`]).concat(args);

export const runGit = async (cwd, args) => {
  const result = await runProcess("git", testGitArgs(args), cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
  if (args[0] === "init") await configureTestGitRepo(cwd);
  return result.stdout.trim();
};

export const configureTestGitRepo = async (cwd) => {
  for (const [key, value] of testGitConfigEntries) {
    const result = await runProcess("git", ["config", key, value], cwd);
    assert.equal(result.code, 0, `git config ${key} failed\n${result.stderr}${result.stdout}`);
  }
};
