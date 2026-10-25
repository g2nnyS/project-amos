import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import plugin from "./index.ts";

const ROOT = process.cwd();
const RULES = join(ROOT, "constraints", "rules.yaml");
const SCHEMA = join(ROOT, "constraints", "schema.json");
type Event = { tool?: unknown; input?: unknown };
type Context = Parameters<typeof plugin.setup>[0];

async function setupHook(t: any, optionOverrides: Record<string, unknown> = {}) {
  const temporary = mkdtempSync(join("/tmp/opencode", "atmos-hook-"));
  const logPath = join(temporary, "audit.jsonl");
  let callback: ((event: Event) => void) | undefined;
  const cleanup = await plugin.setup({
    location: { directory: ROOT },
    options: {
      mode: "log-only",
      rulesPath: RULES,
      schemaPath: SCHEMA,
      logPath,
      ...optionOverrides,
    },
    tool: {
      hook: async (_name: string, registered: (event: Event) => void) => {
        callback = registered;
        return { dispose: async () => {} };
      },
    },
  } as Context);
  t.after(async () => {
    await cleanup();
    rmSync(temporary, { recursive: true, force: true });
  });
  return {
    logPath,
    call(event: Event) {
      assert.ok(callback !== undefined);
      callback(event);
    },
    entries() {
      return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

test("compiled hook evaluates real snapshots and remains log-only", async (t) => {
  const hook = await setupHook(t);
  hook.call({ tool: "read", input: { path: "constraints/rules.yaml" } });
  hook.call({ tool: "write", input: { path: "docs/must-not-be-created.md", content: "no" } });

  const entries = hook.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry: any) => entry.verdict), ["log", "confirm"]);
  assert.deepEqual(entries[0].matched_rule_ids, ["side_effect-1-3"]);
  assert.deepEqual(entries[1].matched_rule_ids, ["side_effect-1-2"]);
  assert.equal(entries[0].action.target, RULES);
  assert.equal(existsSync(join(ROOT, "docs", "must-not-be-created.md")), false);
});

test("hook records parse and unknown payload errors without throwing", async (t) => {
  const hook = await setupHook(t);
  hook.call({ tool: "read", input: {} });
  hook.call({ tool: "patch", input: { patchText: "*** Update File: x" } });
  hook.call({ tool: "mystery_file_tool", input: {} });
  hook.call({ tool: "shell", input: { command: "echo ignored" } });

  const entries = hook.entries();
  assert.deepEqual(entries.map((entry: any) => entry.error), [
    "parse_error",
    "unknown_payload",
    "unknown_payload",
  ]);
  assert.ok(entries.every((entry: any) => entry.verdict === "deny"));
  assert.ok(entries.every((entry: any) => entry.action.target === "unknown"));
});

test("first snapshot failure is fail-closed in the audit record", async (t) => {
  const hook = await setupHook(t, { rulesPath: join(ROOT, "constraints", "missing.yaml") });
  hook.call({ tool: "read", input: { path: "constraints/rules.yaml" } });
  const [entry] = hook.entries();
  assert.equal(entry.verdict, "deny");
  assert.equal(entry.error, "snapshot_error");
  assert.deepEqual(entry.matched_rule_ids, []);
});

test("missing explicit configuration and non-log-only modes fail setup", async () => {
  const base = {
    location: { directory: ROOT },
    tool: { hook: async () => ({ dispose: async () => {} }) },
  };
  await assert.rejects(plugin.setup({
    ...base,
    options: { mode: "log-only" },
  } as Context), /rulesPath/);
  await assert.rejects(plugin.setup({
    ...base,
    options: { mode: "enforce", rulesPath: RULES, schemaPath: SCHEMA, logPath: "x" },
  } as Context), /Only log-only/);
});
