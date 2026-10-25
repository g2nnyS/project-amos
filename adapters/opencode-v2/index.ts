import { isAbsolute, resolve } from "node:path";
import { evaluateWithMatches, type Verdict } from "../../engine/engine.ts";
import { appendAuditEntry, type AuditAction, type AuditError } from "../../storage/jsonl.ts";
import { createSnapshotStore } from "../../storage/snapshot.ts";
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
type Outcome = {
  action: AuditAction;
  matched_rule_ids: string[];
  verdict: Verdict;
  error?: AuditError;
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
    const snapshots = createSnapshotStore();
    snapshots.load(config.rulesPath, config.schemaPath);

    const registration = await ctx.tool.hook("execute.before", (event) => {
      const started = performance.now();
      const now = Date.now();
      let outcome: Outcome;
      try {
        const normalized = normalizeOpenCodeAction(event, config.directory);
        if (normalized.kind === "skip") return;
        if (normalized.kind === "error") {
          outcome = {
            action: normalized.action,
            matched_rule_ids: [],
            verdict: "deny",
            error: normalized.error,
          };
        } else {
          const snapshot = snapshots.current();
          if (snapshot === null) {
            outcome = {
              action: normalized.action,
              matched_rule_ids: [],
              verdict: "deny",
              error: "snapshot_error",
            };
          } else {
            const result = evaluateWithMatches(normalized.action, snapshot.table, now);
            outcome = {
              action: normalized.action,
              matched_rule_ids: result.matched_rule_ids,
              verdict: result.verdict,
              ...(result.error === undefined ? {} : { error: result.error }),
            };
          }
        }
      } catch {
        outcome = {
          action: fallbackAction(event),
          matched_rule_ids: [],
          verdict: "deny",
          error: "engine_error",
        };
      }

      try {
        appendAuditEntry(config.logPath, {
          ts: new Date(now).toISOString(),
          ...outcome,
          latency_ms: Number((performance.now() - started).toFixed(3)),
        });
      } catch {
        // Log-only must never interfere with the actual tool call.
      }
    });

    return async () => { await registration.dispose(); };
  },
};
