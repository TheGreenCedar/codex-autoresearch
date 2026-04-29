import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const quoteForShell = (value) => {
  return `"${String(value).replace(/"/g, '\\"')}"`;
};

export const processResult = (code, stdout, stderr) => ({ code, stdout, stderr });

export const runProcess = (command, args, cwd) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve(processResult(-1, stdout, String(error.message || error))),
    );
    child.on("close", (code) => resolve(processResult(code, stdout, stderr)));
  });
};

export const runInteractiveProcess = (command, args, answers, cwd) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answered = 0;
    let seenPrompts = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const promptCount = (stdout.match(/: /g) || []).length;
      while (seenPrompts < promptCount && answered < answers.length) {
        child.stdin.write(`${answers[answered]}\n`);
        answered += 1;
        seenPrompts += 1;
      }
      if (answered === answers.length && !child.stdin.destroyed) child.stdin.end();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve(processResult(-1, stdout, String(error.message || error))),
    );
    child.on("close", (code) => resolve(processResult(code, stdout, stderr)));
  });
};

export const createCliRunner = (cli, defaultCwd) => {
  return (args, options = {}) =>
    runProcess(process.execPath, [cli, ...args], options.cwd || defaultCwd);
};

export const createInteractiveCliRunner = (cli, defaultCwd) => {
  return (args, answers, options = {}) =>
    runInteractiveProcess(process.execPath, [cli, ...args], answers, options.cwd || defaultCwd);
};

export const withProcess = async (command, args, cwd, fn) => {
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  try {
    return await fn(
      child,
      () => stdout,
      () => stderr,
    );
  } finally {
    child.kill();
  }
};

export const withTempDir = async (prefix, name, fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-${name}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const runGit = async (cwd, args) => {
  const result = await runProcess("git", args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
  return result.stdout.trim();
};
