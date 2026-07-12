export type GitPorcelainEntry = {
  status: string;
  path: string;
  originalPath?: string;
  paths: string[];
};

type GitPathOutput = string | Uint8Array;

function decodeGitPathOutput(output: GitPathOutput): string {
  return typeof output === "string"
    ? output
    : new TextDecoder("utf-8", { fatal: true }).decode(output);
}

export function parseNulPathList(output: GitPathOutput): string[] {
  const text = decodeGitPathOutput(output);
  if (!text) return [];
  if (!text.endsWith("\0")) throw new Error("Malformed Git path output: missing NUL terminator.");
  const paths = text.slice(0, -1).split("\0");
  if (paths.some((path) => !path)) throw new Error("Malformed Git path output: empty path.");
  return paths;
}

export function parsePorcelainV1Z(output: GitPathOutput): GitPorcelainEntry[] {
  const fields = parseNulPathList(output);
  const entries: GitPorcelainEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Malformed Git porcelain v1 -z record.");
    }
    const status = record.slice(0, 2);
    const currentPath = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = fields[index + 1];
      if (!originalPath) throw new Error("Malformed Git porcelain rename/copy record.");
      index += 1;
      entries.push({
        status,
        path: currentPath,
        originalPath,
        paths: [originalPath, currentPath],
      });
    } else {
      entries.push({ status, path: currentPath, paths: [currentPath] });
    }
  }
  return entries;
}

export function parseNameStatusZ(output: GitPathOutput): GitPorcelainEntry[] {
  const fields = parseNulPathList(output);
  const entries: GitPorcelainEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error("Malformed Git --name-status -z record.");
    }
    const originalPath = fields[index++];
    if (!originalPath) throw new Error("Malformed Git --name-status -z path.");
    if (status.startsWith("R") || status.startsWith("C")) {
      const currentPath = fields[index++];
      if (!currentPath) throw new Error("Malformed Git rename/copy destination.");
      entries.push({
        status,
        path: currentPath,
        originalPath,
        paths: [originalPath, currentPath],
      });
    } else {
      entries.push({ status, path: originalPath, paths: [originalPath] });
    }
  }
  return entries;
}

export function displayGitPath(value: string): string {
  return JSON.stringify(value);
}
