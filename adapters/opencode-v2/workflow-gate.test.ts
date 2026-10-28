import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenCodeV2Plugin,
  type WorkflowGateDeps,
} from "./index.ts";
import type {
  ChangeCheckResult,
  ChangeReviewResult,
} from "../../workflow/change-review.ts";
import type { EngineeringReviewResult } from "../../workflow/engineering-review.ts";
import type { LoadedJevConfig } from "../../decision/config.ts";

const ROOT = process.cwd();
const RULES = join(ROOT, "constraints", "rules.yaml");
const SCHEMA = join(ROOT, "constraints", "schema.json");
const WORKSPACE = "/home/test-user/projects/project-amos";

type AnyHook = (event: any) => unknown;

type MockOptions = {
  shell?: boolean;
  permission?: boolean;
  session?: boolean;
  instructions?: boolean;
  put?: (input: {
    sessionID: string;
    key: string;
    value: string;
  }) => Promise<unknown>;
};

type MockContext = {
  hooks: {
    tool: Map<string, AnyHook>;
    shell: Map<string, AnyHook>;
    permission: Map<string, AnyHook>;
    session: Map<string, AnyHook>;
  };
  putCalls: Array<{ sessionID: string; key: string; value: string }>;
  context: unknown;
};

function createMock(
  options: Record<string, unknown>,
  mockOptions: MockOptions = {},
): MockContext {
  const hooks = {
    tool: new Map<string, AnyHook>(),
    shell: new Map<string, AnyHook>(),
    permission: new Map<string, AnyHook>(),
    session: new Map<string, AnyHook>(),
  };
  const putCalls: Array<{ sessionID: string; key: string; value: string }> = [];

  const register = (map: Map<string, AnyHook>) =>
    async (name: string, callback: AnyHook) => {
      map.set(name, callback);
      return { dispose: async () => {} };
    };

  const context: Record<string, unknown> = {
    location: { directory: WORKSPACE },
    options,
    tool: { hook: register(hooks.tool) },
  };

  if (mockOptions.shell !== false) {
    context.shell = { hook: register(hooks.shell) };
  }
  if (mockOptions.permission !== false) {
    context.permission = { hook: register(hooks.permission) };
  }
  if (mockOptions.session !== false) {
    const put =
      mockOptions.put ??
      (async (input: { sessionID: string; key: string; value: string }) => {
        putCalls.push(input);
      });
    context.session = {
      hook: register(hooks.session),
      ...(mockOptions.instructions === false
        ? {}
        : { instructions: { entry: { put } } }),
    };
  }

  return { hooks, putCalls, context };
}

function baseOptions(logPath: string): Record<string, unknown> {
  return {
    mode: "log-only",
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
  };
}

async function setupPlugin(
  t: any,
  options: Record<string, unknown>,
  mockOptions: MockOptions = {},
  deps: WorkflowGateDeps = {},
) {
  const temporary = mkdtempSync(join(tmpdir(), "amos-gate-"));
  const logPath = join(temporary, "audit.jsonl");
  const mock = createMock({ ...baseOptions(logPath), ...options }, mockOptions);
  const cleanup = await createOpenCodeV2Plugin(deps).setup(mock.context as any);
  t.after(async () => {
    await cleanup();
    rmSync(temporary, { recursive: true, force: true });
  });

  const call = async (domain: keyof MockContext["hooks"], name: string, event: any) => {
    const callback = mock.hooks[domain].get(name);
    assert.ok(callback !== undefined, `${domain}.${name} hook must be registered`);
    return callback(event);
  };

  return {
    ...mock,
    logPath,
    call,
    entries() {
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    rawLog() {
      return readFileSync(logPath, "utf8");
    },
  };
}

function enabledGate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    guidance: false,
    shellGate: false,
    completionReview: false,
    ...overrides,
  };
}

function check(
  id: ChangeCheckResult["id"],
  ok: boolean,
  secret = "",
): ChangeCheckResult {
  return {
    id,
    argv: ["npm", "run", id],
    exitCode: ok ? 0 : 1,
    timedOut: false,
    outputTruncated: false,
    outputWithheld: false,
    stdout: secret,
    stderr: "",
    ok,
  };
}

function review(
  digest: string,
  checks: readonly ChangeCheckResult[] = [],
  overrides: Partial<ChangeReviewResult> = {},
): ChangeReviewResult {
  return {
    cwd: WORKSPACE,
    checks,
    egress: {
      eligible: true,
      reason: "eligible",
      diff: "diff --git a/a.ts b/a.ts",
      digest,
      truncated: false,
      omittedFiles: [],
    },
    digest,
    previousDigest: null,
    changedSinceLastCall: null,
    ...overrides,
  };
}

function fakeJev(): LoadedJevConfig {
  return {
    systemOneClient: {
      request: async () => ({ answers: {}, model: "fake" }),
    },
    config: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      defaultModel: "fake",
      models: ["fake"],
      timeoutMs: 1_000,
      assessmentRequired: false,
      policy: { reviewRisk: 0.5 },
      allowCredentialEgress: false,
    },
    assessmentProvider: {} as LoadedJevConfig["assessmentProvider"],
  } as unknown as LoadedJevConfig;
}

function passReview(): EngineeringReviewResult {
  return {
    status: "pass",
    reason: "clear",
    model: null,
    diffDigest: "d1",
    guidancePackIds: [],
    facts: null,
  };
}

test("workflow gate stays disabled by default and only audits", async (t) => {
  const plugin = await setupPlugin(t, {});
  assert.equal(plugin.hooks.shell.size, 0);
  assert.equal(plugin.hooks.permission.size, 0);
  assert.equal(plugin.hooks.session.size, 0);

  await plugin.call("tool", "execute.before", { tool: "execute", input: {} });
  assert.equal(plugin.entries().length, 1);
  assert.equal(plugin.entries()[0].coverage.reason, "unsupported_tool");
});

test("prompt guidance is stored as a keyed instruction, never echoed", async (t) => {
  const secret = "OPENCODE_PROMPT_SECRET";
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ guidance: true }),
  });

  const promptEvent = {
    sessionID: "ses_guidance",
    prompt: { text: `Please update adapters normalization ${secret}` },
  };
  await plugin.call("session", "prompt", promptEvent);

  assert.equal(plugin.putCalls.length, 1);
  assert.equal(plugin.putCalls[0].sessionID, "ses_guidance");
  assert.equal(plugin.putCalls[0].key, "amos.workflow.guidance");
  assert.match(plugin.putCalls[0].value, /Engineering guidance/);
  assert.match(plugin.putCalls[0].value, /Harness adapters/);
  assert.equal(plugin.putCalls[0].value.includes(secret), false);

  const contextEvent = { sessionID: "ses_guidance", system: [] as unknown[] };
  await plugin.call("session", "context", contextEvent);
  assert.equal(contextEvent.system.length, 0);
});

test("guidance falls back to the session-keyed context map when entry.put is unavailable", async (t) => {
  const secret = "OPENCODE_FALLBACK_SECRET";
  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ guidance: true }) },
    {
      put: async () => {
        throw new Error(secret);
      },
    },
  );

  await plugin.call("session", "prompt", {
    sessionID: "ses_fallback",
    prompt: { text: `workflow security review ${secret}` },
  });

  const contextEvent = { sessionID: "ses_fallback", system: [] as unknown[] };
  await plugin.call("session", "context", contextEvent);
  assert.equal(contextEvent.system.length, 1);
  const part = contextEvent.system[0] as { type: string; text: string };
  assert.equal(part.type, "text");
  assert.match(part.text, /Engineering guidance/);
  assert.equal(part.text.includes(secret), false);
});

test("deny shell commands throw a fixed code without leaking command text", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ shellGate: true }),
  });
  const secret = "OPENCODE_SHELL_SECRET";
  const command = `rm -rf ${WORKSPACE} ${secret}`;

  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command,
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    (error: Error) => {
      assert.equal(error.message, "amos_workflow_gate_shell_denied");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(WORKSPACE), false);
      return true;
    },
  );
});

test("confirm fails closed when no permission path exists", async (t) => {
  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ shellGate: true }) },
    { permission: false },
  );

  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command: "npm install left-pad",
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    /amos_workflow_gate_shell_confirmation_required/,
  );
});

test("cd-led opaque confirm never relies on the permission hook", async (t) => {
  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ shellGate: true }) },
    { permission: true },
  );

  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command: "cd packages && npm test",
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    /amos_workflow_gate_shell_confirmation_required/,
  );
});

test("parsed confirm fails closed and permission defense only tightens", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ shellGate: true }),
  });

  // No synchronous attributable approval exists in shell.create.before, so a
  // parsed confirm plan is still blocked rather than depending on event order.
  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command: "npm install left-pad",
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    /amos_workflow_gate_shell_confirmation_required/,
  );

  const confirmAsk = {
    action: "shell",
    resources: ["npm install left-pad"],
    effect: "allow",
  };
  await plugin.call("permission", "evaluate", confirmAsk);
  assert.equal(confirmAsk.effect, "ask");

  const existingAsk = {
    action: "shell",
    resources: ["npm install left-pad"],
    effect: "ask",
  };
  await plugin.call("permission", "evaluate", existingAsk);
  assert.equal(existingAsk.effect, "ask");

  const denyTighten = {
    action: "shell",
    resources: ["bash -c 'echo hi'"],
    effect: "allow",
  };
  await plugin.call("permission", "evaluate", denyTighten);
  assert.equal(denyTighten.effect, "deny");

  const explicitDeny = {
    action: "shell",
    resources: ["npm install left-pad"],
    effect: "deny",
  };
  await plugin.call("permission", "evaluate", explicitDeny);
  assert.equal(explicitDeny.effect, "deny");

  const safe = { action: "shell", resources: ["git status"], effect: "allow" };
  await plugin.call("permission", "evaluate", safe);
  assert.equal(safe.effect, "allow");
});

test("code-execution tools are blocked while ordinary file tools still audit", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ shellGate: true }),
  });

  await assert.rejects(
    () =>
      plugin.call("tool", "execute.before", {
        tool: "execute",
        input: { command: "OPENCODE_EXECUTE_SECRET" },
      }),
    /amos_workflow_gate_tool_blocked/,
  );

  await plugin.call("tool", "execute.before", {
    tool: "write",
    input: { path: join(WORKSPACE, "src", "example.ts"), content: "secret" },
  });

  const entries = plugin.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action.tool, "execute");
  assert.equal(entries[1].action.tool, "write");
  assert.equal(plugin.rawLog().includes("OPENCODE_EXECUTE_SECRET"), false);
});

test("completion review runs once per diff digest and reports bounded checks", async (t) => {
  let current = review("d1", [check("test", false, "OPENCODE_CHECK_SECRET")]);
  let reviewCalls = 0;
  let jevCalls = 0;
  const runChecksCalls: boolean[] = [];
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        completionReview: true,
        jevConfigPath: "decision/jev.local.json",
      }),
    },
    {},
    {
      loadJevConfig: () => fakeJev(),
      createChangeReview: async (options) => {
        reviewCalls += 1;
        runChecksCalls.push(options.runChecks === true);
        return options.runChecks === true ? current : { ...current, checks: [] };
      },
      reviewEngineeringChange: async () => {
        jevCalls += 1;
        return passReview();
      },
    },
  );

  const first = { sessionID: "ses_review", system: [] as unknown[] };
  await plugin.call("session", "context", first);
  assert.equal(first.system.length, 1);
  assert.deepEqual(runChecksCalls, [false, true]);
  const feedback = first.system[0] as { text: string };
  assert.match(feedback.text, /advisory only/);
  assert.match(feedback.text, /test=failed/);
  assert.equal(feedback.text.includes("OPENCODE_CHECK_SECRET"), false);

  const second = { sessionID: "ses_review", system: [] as unknown[] };
  await plugin.call("session", "context", second);
  assert.equal(second.system.length, 0);
  // Only digest collection runs again; checks, Jev, and feedback stay pinned to
  // the digest.
  assert.equal(reviewCalls, 3);
  assert.equal(jevCalls, 1);

  current = review("d2", [check("typecheck", true)]);
  const third = { sessionID: "ses_review", system: [] as unknown[] };
  await plugin.call("session", "context", third);
  assert.equal(third.system.length, 0);
  assert.equal(reviewCalls, 5);
  assert.equal(jevCalls, 2);
});

test("Jev failure is held as advisory feedback once per digest", async (t) => {
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        completionReview: true,
        jevConfigPath: "decision/jev.local.json",
      }),
    },
    {},
    {
      loadJevConfig: () => fakeJev(),
      createChangeReview: async () => review("d_jev"),
      reviewEngineeringChange: async () => ({
        status: "error",
        reason: "assessment_failed",
        model: null,
        diffDigest: "d_jev",
        guidancePackIds: [],
        facts: null,
      }),
    },
  );

  const first = { sessionID: "ses_jev", system: [] as unknown[] };
  await plugin.call("session", "context", first);
  assert.equal(first.system.length, 1);
  assert.match((first.system[0] as { text: string }).text, /jev: error\/assessment_failed/);

  const second = { sessionID: "ses_jev", system: [] as unknown[] };
  await plugin.call("session", "context", second);
  assert.equal(second.system.length, 0);
});

test("Jev config failure holds completion review without blocking safe shell governance", async (t) => {
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        shellGate: true,
        completionReview: true,
        jevConfigPath: "decision/jev.local.json",
      }),
    },
    {},
    {
      loadJevConfig: () => {
        throw new Error("JEV_CONFIG_SECRET");
      },
    },
  );

  // Safe shell classification does not depend on Jev availability.
  await plugin.call("shell", "create.before", {
    command: "git status",
    cwd: WORKSPACE,
    shell: "/bin/bash",
  });

  const first = { sessionID: "ses_jev_config", system: [] as unknown[] };
  await plugin.call("session", "context", first);
  assert.equal(first.system.length, 1);
  const text = (first.system[0] as { text: string }).text;
  assert.match(text, /jev_config_error/);
  assert.equal(text.includes("JEV_CONFIG_SECRET"), false);

  const second = { sessionID: "ses_jev_config", system: [] as unknown[] };
  await plugin.call("session", "context", second);
  assert.equal(second.system.length, 0);
});

test("gate configuration errors are reported safely and fail closed", async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.error = originalError;
  });

  const secret = "OPENCODE_CONFIG_SECRET";
  const plugin = await setupPlugin(t, {
    workflowGate: {
      enabled: true,
      shellGate: true,
      completionReview: false,
      unexpected: secret,
    },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /config_error/);
  assert.equal(errors[0].includes(secret), false);
  assert.equal(errors[0].includes(WORKSPACE), false);

  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command: `echo ${secret}`,
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    /amos_workflow_gate_config_error/,
  );

  await assert.rejects(
    () =>
      plugin.call("tool", "execute.before", {
        tool: "execute",
        input: { command: secret },
      }),
    /amos_workflow_gate_config_error/,
  );

  assert.equal(plugin.rawLog().includes(secret), false);
});
