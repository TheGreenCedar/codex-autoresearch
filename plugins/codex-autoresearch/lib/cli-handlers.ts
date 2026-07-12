import {
  commandTable,
  compatibilityErrorForCli,
  normalizeCliCommandArguments,
  type CommandHandlerBinding,
} from "./command-table.js";
import { createSessionReadCache } from "./session-core.js";

type LooseObject = Record<string, any>;
type CliHandler = (args: LooseObject) => Promise<LooseObject>;
type CliDependency = (...args: any[]) => any;

type ActiveHandlerBinding = Exclude<CommandHandlerBinding, "compatibilityError">;
type HandlerAdapter = (deps: CliCommandDeps, args: LooseObject) => Promise<LooseObject>;

export type CliCommandDeps = Record<ActiveHandlerBinding, CliDependency> & {
  doctorHooks: CliDependency;
  interactiveSetup: CliDependency;
  parseJsonOption: CliDependency;
};

const HANDLER_ADAPTERS: Partial<Record<ActiveHandlerBinding, HandlerAdapter>> = {
  setupSession: async (deps, args) => ({
    result: await (args.interactive ? deps.interactiveSetup(args) : deps.setupSession(args)),
  }),
  recipeCommand: async (deps, args) => ({
    result: await deps.recipeCommand(args._?.[1] || "list", args),
  }),
  measureQualityGap: async (deps, args) => {
    const result = await deps.measureQualityGap(args);
    return args.list || args.json ? { result } : { text: result.metricOutput };
  },
  logExperiment: async (deps, args) => ({
    result: await deps.logExperiment({
      ...args,
      metrics: args.metricsFile ? args.metrics : deps.parseJsonOption(args.metrics, null),
      asi: args.asiFile || args.asiJsonFile ? args.asi : deps.parseJsonOption(args.asi, null),
    }),
  }),
  publicState: async (deps, args) => ({
    result: await deps.publicState({ ...args, bounded: args.jsonFull !== true }),
  }),
  doctorSession: async (deps, args) => ({
    result: await (args._?.[1] === "hooks" || args.hooks
      ? deps.doctorHooks(args)
      : deps.doctorSession(args)),
  }),
  checksInspect: async (deps, args) => ({
    result: await deps.checksInspect({ ...args, command: args.command || args.checksCommand }),
  }),
  serveDashboard: async (deps, args) => ({
    keepAlive: true,
    result: await deps.serveDashboard(args),
  }),
};

export const commandHandlerAdapterBindings = Object.freeze(
  Object.keys(HANDLER_ADAPTERS) as ActiveHandlerBinding[],
);

export function createCliCommandHandlers(deps: CliCommandDeps): Record<string, CliHandler> {
  const dependencies = deps as unknown as Record<string, CliDependency>;
  const handlers = Object.fromEntries(
    commandTable.map((command) => {
      const adapter = HANDLER_ADAPTERS[command.handler as ActiveHandlerBinding];
      return [
        command.cliCommand,
        command.compatibility
          ? async () => {
              throw new Error(command.compatibility.error);
            }
          : adapter
            ? async (args: LooseObject) => await adapter(deps, args)
            : async (args: LooseObject) => ({ result: await dependencies[command.handler](args) }),
      ];
    }),
  ) as Record<string, CliHandler>;

  return normalizeCliHandlers(handlers);
}

function normalizeCliHandlers(handlers: Record<string, CliHandler>): Record<string, CliHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([command, handler]) => [
      command,
      (args: LooseObject) =>
        handler({
          ...(normalizeCliCommandArguments(command, args) as LooseObject),
          readCache: createSessionReadCache(),
        }),
    ]),
  );
}

export async function runCliCommand(
  command: string,
  args: LooseObject,
  handlers: Record<string, CliHandler>,
) {
  const migrationError = compatibilityErrorForCli(command);
  if (migrationError) throw new Error(migrationError);
  const handler = handlers[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return await handler(args);
}
