import { type JsonValue, type UnknownRecord, unknownRecordOrEmpty } from "./json.js";

export type CommandAudience = "default" | "advanced" | "maintainer";
export type CommandCategory =
  | "happy_path"
  | "setup"
  | "diagnostic"
  | "advanced"
  | "integration"
  | "dangerous";

export interface CommandInvocation extends UnknownRecord {
  args: UnknownRecord;
  command: string;
}

export interface CommandResultEnvelope<
  TPayload extends UnknownRecord = UnknownRecord,
> extends UnknownRecord {
  ok: boolean;
  result?: TPayload;
  error?: string;
}

export interface CommandMetadata extends UnknownRecord {
  audience: CommandAudience;
  category: CommandCategory;
  name: string;
  public?: boolean;
}

export type RuntimeToolArguments = Record<string, JsonValue | undefined>;

export function normalizeCommandInvocation(command: string, args: unknown): CommandInvocation {
  return {
    args: unknownRecordOrEmpty(args),
    command,
  };
}
