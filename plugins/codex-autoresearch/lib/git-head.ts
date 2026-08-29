import { runGit } from "./git-private-state.js";
import type { ProcessRunResult } from "./runner.js";

export interface GitHeadCaptureIo {
  runGit(args: string[], cwd: string): Promise<ProcessRunResult>;
}

export async function captureVerifiedGitHead(
  workDir: string,
  io: GitHeadCaptureIo = { runGit },
): Promise<string> {
  const headResult = await io.runGit(["rev-parse", "--verify", "HEAD"], workDir);
  const head = headResult.stdout.trim();
  if (headResult.code === 0 && !headResult.stdoutTruncated && head) return head;

  const symbolic = await io.runGit(["symbolic-ref", "-q", "HEAD"], workDir);
  const symbolicRef = symbolic.stdout.trim();
  const missingRef =
    symbolic.code === 0 && !symbolic.stdoutTruncated && symbolicRef.startsWith("refs/heads/")
      ? await io.runGit(["show-ref", "--verify", "--quiet", symbolicRef], workDir)
      : null;
  if (missingRef?.code === 1 && !missingRef.stdoutTruncated) return "unborn";

  const detail =
    headResult.stderr ||
    headResult.stdout ||
    symbolic.stderr ||
    symbolic.stdout ||
    missingRef?.stderr ||
    missingRef?.stdout ||
    `exit ${String(headResult.code)}`;
  throw new Error(`Git HEAD could not be captured: ${detail}`);
}
