export const COMMAND_EXECUTION_BOUNDARY = {
  mode: "not_sandboxed",
  note: "Benchmark and checks commands run as local shell commands with the current user's permissions.",
  recommendation:
    "Prefer project-local scripts or --command-file for reviewable command text and safer quoting.",
} as const;
