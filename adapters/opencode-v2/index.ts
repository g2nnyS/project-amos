import { isAbsolute, resolve } from "node:path";
import type { AuditAction } from "../../storage/jsonl.ts";
import { createLogOnlyRecorder } from "../shared/log-only.ts";
import { normalizeOpenCodeAction } from "./normalize.ts";

type ToolEvent = { tool?: unknown; input?: unknown };
type Registration = { dispose(): unknown | Promise<unknown> };
type PluginContext = {
  location: { directory: string };
  options: Record<string, unknown>;
  tool: {
    hook(
      name: "execute.before",
      callback: (event: ToolEvent) => void,
    ): Promise<Registration>;
  };
};

function requiredPath(options: Record<string, unknown>, key: string, directory: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be explicitly configured`);
  }
  return resolve(directory, value);
}

function readConfig(options: Record<string, unknown>, directory: string) {
  if (!isAbsolute(directory)) throw new Error("OpenCode location must be absolute");
  if (options.mode !== "log-only") throw new Error("Only log-only mode is enabled in stage A");
  return {
    directory,
    rulesPath: requiredPath(options, "rulesPath", directory),
    schemaPath: requiredPath(options, "schemaPath", directory),
    logPath: requiredPath(options, "logPath", directory),
  };
}

function fallbackAction(event: ToolEvent): AuditAction {
  return {
    tool: typeof event.tool === "string" && event.tool.length > 0 ? event.tool : "unknown",
    operation: "unknown",
    target: "unknown",
  };
}

export default {
  id: "atmos-opencode-v2-log-only",
  async setup(ctx: PluginContext) {
    const config = readConfig(ctx.options ?? {}, ctx.location.directory);
    const recorder = createLogOnlyRecorder({
      rulesPath: config.rulesPath,
      schemaPath: config.schemaPath,
      logPath: config.logPath,
    });

    const registration = await ctx.tool.hook("execute.before", (event) => {
      const started = performance.now();
      const now = Date.now();
      try {
        recorder.record(normalizeOpenCodeAction(event, config.directory), now, started);
      } catch {
        recorder.record(
          { kind: "error", error: "engine_error", action: fallbackAction(event) },
          now,
          started,
        );
      }
    });

    return async () => { await registration.dispose(); };
  },
};
