export type CommandShell = "bash" | "powershell";

const BASH_SAFE_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;
const POWERSHELL_SAFE_ARG = /^[A-Za-z0-9_./:@%+=,\\:-]+$/;

export function defaultCommandShell(platform = process.platform): CommandShell {
  return platform === "win32" ? "powershell" : "bash";
}

export function normalizeCommandShell(
  value: unknown,
  fallback: CommandShell = defaultCommandShell(),
): CommandShell {
  const requested = String(value || "").toLowerCase();
  if (["bash", "sh", "posix"].includes(requested)) return "bash";
  if (["powershell", "pwsh", "ps1", "windows"].includes(requested)) return "powershell";
  return fallback;
}

export function quoteShellArg(value: unknown, shell: CommandShell = defaultCommandShell()): string {
  const text = String(value);
  if (text === "") return "''";
  const safePattern = shell === "powershell" ? POWERSHELL_SAFE_ARG : BASH_SAFE_ARG;
  if (safePattern.test(text)) return text;
  if (shell === "powershell") return `'${escapePowerShellNativeQuotes(text).replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

export function renderShellCommand(
  argv: readonly unknown[],
  shell: CommandShell = defaultCommandShell(),
): string {
  const args = argv.map((value) => quoteShellArg(value, shell));
  if (args.length === 0) return "";
  const command =
    shell === "powershell" && args[0].startsWith("'") ? `& ${args.join(" ")}` : args.join(" ");
  if (shell === "powershell") {
    return `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${command} }`;
  }
  return command;
}

function escapePowerShellNativeQuotes(text: string): string {
  return text.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`);
}
