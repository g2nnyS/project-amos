import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index.ts";

const ROOT = process.cwd();
const RULES = join(ROOT, "constraints", "rules.yaml");
const SCHEMA = join(ROOT, "constraints", "schema.json");

// Logical session workspace supplied via the harness location. Rule evaluation
// uses this instead of process.cwd() so the assertions describe the explicit
// ${SESSION_WORKSPACE} boundary rather than the clone location.
const WORKSPACE = "/home/test-user/projects/project-atmos";
type Event = { tool?: unknown; input?: unknown };
type Context = Parameters<typeof plugin.setup>[0];

async function setupHook(t: any, optionOverrides: Record<string, unknown> = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "atmos-hook-"));
  const logPath =
    typeof optionOverrides.logPath === "string"
      ? optionOverrides.logPath
      : join(temporary, "audit.jsonl");
  let callback: ((event: Event) => void) | undefined;
  const cleanup = await plugin.setup({
    location: { directory: WORKSPACE },
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
  const readTarget = join(WORKSPACE, "constraints", "rules.yaml");
  const writeTarget = join(WORKSPACE, "docs", "must-not-be-created.md");
  const contentSecret = "OPENCODE_WRITE_SECRET";
  hook.call({ tool: "read", input: { path: readTarget } });
  hook.call({ tool: "write", input: { path: writeTarget, content: contentSecret } });

  const entries = hook.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry: any) => entry.verdict), ["log", "confirm"]);
  assert.deepEqual(entries[0].matched_rule_ids, ["side_effect-1-3"]);
  assert.deepEqual(entries[1].matched_rule_ids, ["side_effect-1-2"]);
  assert.equal(entries[0].action.target, readTarget);
  assert.equal(entries[1].action.target, writeTarget);
  assert.equal(existsSync(writeTarget), false);

  const rawLog = readFileSync(hook.logPath, "utf8");
  assert.equal(rawLog.includes(contentSecret), false);
});

test("targets outside the explicit session workspace are denied", async (t) => {
  const hook = await setupHook(t);
  const outsideTarget = "/home/test-user/projects/other-project/src/example.ts";

  hook.call({ tool: "read", input: { path: outsideTarget } });

  const [entry] = hook.entries();
  assert.equal(entry.verdict, "deny");
  assert.ok(entry.matched_rule_ids.includes("filesystem-0-2"));
  assert.deepEqual(entry.action, {
    tool: "read",
    operation: "file_read",
    target: outsideTarget,
  });
});

test("hook records parse, unknown and coverage records without throwing", async (t) => {
  const hook = await setupHook(t);
  const shellSecret = "OPENCODE_SHELL_SECRET";
  hook.call({ tool: "read", input: {} });
  hook.call({
    tool: "patch",
    input: { patchText: "*** Update File: x", content: shellSecret },
  });
  hook.call({ tool: "mystery_file_tool", input: { command: shellSecret } });
  hook.call({
    tool: "shell",
    input: { command: `echo ${shellSecret} --token=abc`, content: shellSecret },
  });

  const entries = hook.entries();
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.slice(0, 3).map((entry: any) => entry.error),
    ["parse_error", "unknown_payload", "unknown_payload"],
  );
  assert.ok(entries.slice(0, 3).every((entry: any) => entry.verdict === "deny"));
  assert.ok(entries.slice(0, 3).every((entry: any) => entry.action.target === "unknown"));

  const coverage = entries[3];
  assert.equal(coverage.verdict, null);
  assert.equal(coverage.decision, "not_evaluated");
  // The normalizer emits target: "unknown"; the shared audit sanitizer redacts
  // targets for non-file operations, so the logged target stays opaque.
  assert.deepEqual(coverage.action, {
    tool: "shell",
    operation: "tool_input",
    target: "[redacted-target]",
  });
  assert.deepEqual(coverage.coverage, {
    reason: "unsupported_tool",
    confirmation_eligible: false,
  });
  assert.equal(coverage.error, undefined);

  const rawLog = readFileSync(hook.logPath, "utf8");
  assert.equal(rawLog.includes(shellSecret), false);
  assert.equal(rawLog.includes("token=abc"), false);
});

test("first snapshot failure is fail-closed in the audit record", async (t) => {
  const hook = await setupHook(t, { rulesPath: join(ROOT, "constraints", "missing.yaml") });
  hook.call({ tool: "read", input: { path: "constraints/rules.yaml" } });
  const [entry] = hook.entries();
  assert.equal(entry.verdict, "deny");
  assert.equal(entry.error, "snapshot_error");
  assert.deepEqual(entry.matched_rule_ids, []);
});

test("throwing event getters are audited as engine_error without escaping the hook", async (t) => {
  const hook = await setupHook(t);
  const toolSecret = "OPENCODE_TOOL_GETTER_SECRET";
  const badToolEvent: Event = {};
  Object.defineProperty(badToolEvent, "tool", {
    enumerable: true,
    get() {
      throw new Error(toolSecret);
    },
  });
  assert.doesNotThrow(() => hook.call(badToolEvent));

  const inputSecret = "OPENCODE_INPUT_GETTER_SECRET";
  const badInputEvent: Event = { tool: "read" };
  Object.defineProperty(badInputEvent, "input", {
    enumerable: true,
    get() {
      throw new Error(inputSecret);
    },
  });
  assert.doesNotThrow(() => hook.call(badInputEvent));

  const entries = hook.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].action, {
    tool: "unknown",
    operation: "unknown",
    target: "unknown",
  });
  assert.equal(entries[0].verdict, "deny");
  assert.equal(entries[0].error, "engine_error");
  assert.deepEqual(entries[1].action, {
    tool: "read",
    operation: "unknown",
    target: "unknown",
  });
  assert.equal(entries[1].verdict, "deny");
  assert.equal(entries[1].error, "engine_error");

  const rawLog = readFileSync(hook.logPath, "utf8");
  assert.equal(rawLog.includes(toolSecret), false);
  assert.equal(rawLog.includes(inputSecret), false);
});

test("audit write failure is visible once without leaking path or payload", async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.error = originalError;
  });

  const root = mkdtempSync(join(tmpdir(), "atmos-hook-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "not a directory", "utf8");

  const hook = await setupHook(t, {
    logPath: join(blocker, "audit.jsonl"),
  });

  const secret = "OPENCODE_AUDIT_FAILURE_SECRET";
  hook.call({ tool: "read", input: { path: join(WORKSPACE, secret) } });
  hook.call({ tool: "read", input: { path: join(WORKSPACE, "second.ts") } });

  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /audit write failed/);
  assert.equal(errors[0]?.includes(secret), false);
  assert.equal(errors[0]?.includes(root), false);
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
