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
import type {
  AssessmentFacts,
  AssessmentProvider,
  RequirementMatch,
} from "../../decision/types.ts";
import {
  requirementFrameDigest,
  type RequirementFrame,
} from "../../decision/requirement.ts";

const ROOT = process.cwd();
const RULES = join(ROOT, "constraints", "rules.yaml");
const SCHEMA = join(ROOT, "constraints", "schema.json");
const WORKSPACE = "/home/test-user/projects/project-amos";

type AnyHook = (event: any) => unknown;

type MockOptions = {
  shell?: boolean;
  permission?: boolean;
  permissionRegisterFails?: boolean;
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
    const permissionRegister = async (name: string, callback: AnyHook) => {
      if (mockOptions.permissionRegisterFails === true) {
        throw new Error("permission registration failed");
      }
      hooks.permission.set(name, callback);
      return { dispose: async () => {} };
    };
    context.permission = { hook: permissionRegister };
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

test("prompt advisory block carries policy, digest, and mode without prompt leakage", async (t) => {
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
  const value = plugin.putCalls[0].value;
  assert.match(value, /<amos-guidance[^>]*policy="1\.0\.0"/);
  assert.match(value, /digest="sha256:[0-9a-f]{64}"/);
  assert.match(value, /mode="advisory"/);
  assert.match(value, /\[adapters-/);
  assert.equal(value.includes(secret), false);
  assert.equal(value.includes(WORKSPACE), false);

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
  assert.match(part.text, /<amos-guidance/);
  assert.equal(part.text.includes(secret), false);
});

test("a later put failure still falls back after an earlier successful put", async (t) => {
  let putAttempts = 0;
  const secret = "OPENCODE_PUT_SECRET";
  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ guidance: true }) },
    {
      put: async () => {
        putAttempts += 1;
        if (putAttempts > 1) throw new Error(secret);
      },
    },
  );

  await plugin.call("session", "prompt", {
    sessionID: "ses_put_sequence",
    prompt: { text: "adapters normalization" },
  });
  const first = { sessionID: "ses_put_sequence", system: [] as unknown[] };
  await plugin.call("session", "context", first);
  assert.equal(first.system.length, 0);

  await plugin.call("session", "prompt", {
    sessionID: "ses_put_sequence",
    prompt: { text: "engine snapshot precedence" },
  });
  const second = { sessionID: "ses_put_sequence", system: [] as unknown[] };
  await plugin.call("session", "context", second);
  assert.equal(second.system.length, 1);
  assert.match((second.system[0] as { text: string }).text, /<amos-guidance/);
  assert.equal(
    (second.system[0] as { text: string }).text.includes(secret),
    false,
  );
});

test("multibyte advisory blocks are appended verbatim without generic truncation", async (t) => {
  const digest = `sha256:${"a".repeat(64)}`;
  const blockText = `<amos-guidance policy="1.0.0" digest="${digest}" mode="advisory">\nConventions are advisory, not permissions. The gate decides every action.\n- [custom-multibyte] ${"界".repeat(1500)} (custom)\n</amos-guidance>`;
  assert.ok(blockText.length <= 1_800);
  assert.ok(Buffer.byteLength(blockText, "utf8") > 2_048);

  const block = {
    text: blockText,
    ruleIds: ["custom-multibyte"],
    droppedRuleIds: [],
    policyVersion: "1.0.0",
    advisoryDigest: digest,
    channel: "prompt" as const,
    area: null,
  };
  const session = {
    selectPrompt: () => block,
    queueAction: () => false,
    selectPendingArea: () => null,
    commit: () => {},
  };

  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ guidance: true }) },
    { instructions: false },
    { createInjectorSession: () => session },
  );

  await plugin.call("session", "prompt", {
    sessionID: "ses_multibyte",
    prompt: { text: "custom" },
  });

  const context = { sessionID: "ses_multibyte", system: [] as unknown[] };
  await plugin.call("session", "context", context);
  assert.equal(context.system.length, 1);
  const part = context.system[0] as { type: string; text: string };
  assert.equal(part.text, blockText);
  assert.equal(part.text.includes("[truncated]"), false);
  assert.ok(part.text.endsWith("</amos-guidance>"));
});

test("write execute.before only queues until the next context emits one area block", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ guidance: true }),
  });
  const target = join(WORKSPACE, "adapters", "opencode-v2", "index.ts");
  const contentSecret = "OPENCODE_WRITE_SECRET";

  await plugin.call("tool", "execute.before", {
    tool: "write",
    sessionID: "ses_area",
    input: { path: target, content: contentSecret },
  });

  // Queueing is separate from emission: nothing is injected during the tool
  // hook and no tool result content is ever copied into the block.
  assert.equal(plugin.putCalls.length, 0);

  const first = { sessionID: "ses_area", system: [] as unknown[] };
  await plugin.call("session", "context", first);
  assert.equal(first.system.length, 1);
  const part = first.system[0] as { type: string; text: string };
  assert.equal(part.type, "text");
  assert.match(part.text, /\[adapters-/);
  assert.equal(part.text.includes(target), false);
  assert.equal(part.text.includes(WORKSPACE), false);
  assert.equal(part.text.includes(contentSecret), false);

  // A repeated action in the same area cannot re-emit an injected block.
  await plugin.call("tool", "execute.before", {
    tool: "edit",
    sessionID: "ses_area",
    input: { path: target, content: contentSecret },
  });
  const second = { sessionID: "ses_area", system: [] as unknown[] };
  await plugin.call("session", "context", second);
  assert.equal(second.system.length, 0);
});

test("separate session IDs keep independent advisory state", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ guidance: true }),
  });
  const target = join(WORKSPACE, "adapters", "opencode-v2", "index.ts");

  await plugin.call("tool", "execute.before", {
    tool: "write",
    sessionID: "ses_a",
    input: { path: target, content: "x" },
  });

  const other = { sessionID: "ses_b", system: [] as unknown[] };
  await plugin.call("session", "context", other);
  assert.equal(other.system.length, 0);

  const original = { sessionID: "ses_a", system: [] as unknown[] };
  await plugin.call("session", "context", original);
  assert.equal(original.system.length, 1);
  assert.match((original.system[0] as { text: string }).text, /\[adapters-/);
});

test("injector exceptions leave tool outcomes, audit, and completion review intact", async (t) => {
  const secret = "OPENCODE_INJECTOR_SECRET";
  let creations = 0;
  let reviewCalls = 0;
  const throwingSession = {
    selectPrompt() {
      throw new Error(secret);
    },
    queueAction() {
      throw new Error(secret);
    },
    selectPendingArea() {
      throw new Error(secret);
    },
    commit() {
      throw new Error(secret);
    },
  };
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        guidance: true,
        completionReview: true,
        jevConfigPath: "decision/jev.local.json",
      }),
    },
    {},
    {
      createInjectorSession: () => {
        creations += 1;
        if (creations === 1) throw new Error(secret);
        return throwingSession;
      },
      loadJevConfig: () => fakeJev(),
      createChangeReview: async (options) => {
        reviewCalls += 1;
        return options.runChecks === true
          ? review("d_injector", [check("test", false)])
          : { ...review("d_injector"), checks: [] };
      },
      reviewEngineeringChange: async () => passReview(),
    },
  );

  // A factory failure is caught and never rejects prompt admission.
  await plugin.call("session", "prompt", {
    sessionID: "ses_factory_failure",
    prompt: { text: "adapters normalization" },
  });

  // A selection/queue failure never changes the tool outcome or audit record.
  await plugin.call("tool", "execute.before", {
    tool: "write",
    sessionID: "ses_throw",
    input: { path: join(WORKSPACE, "src", "example.ts"), content: secret },
  });
  const entries = plugin.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action.tool, "write");

  await plugin.call("session", "prompt", {
    sessionID: "ses_throw",
    prompt: { text: "adapters normalization" },
  });

  // Pending-area selection fails, but completion review still runs.
  const context = { sessionID: "ses_throw", system: [] as unknown[] };
  await plugin.call("session", "context", context);
  assert.equal(reviewCalls, 2);
  assert.equal(context.system.length, 1);
  const feedback = (context.system[0] as { text: string }).text;
  assert.match(feedback, /test=failed/);
  assert.equal(feedback.includes(secret), false);
  assert.equal(plugin.rawLog().includes(secret), false);
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

test("confirm is unavailable when no permission path exists", async (t) => {
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
    /amos_workflow_gate_shell_confirm_unavailable/,
  );
});

test("confirm is unavailable when the permission hook registration fails", async (t) => {
  const plugin = await setupPlugin(
    t,
    { workflowGate: enabledGate({ shellGate: true }) },
    { permissionRegisterFails: true },
  );

  await assert.rejects(
    () =>
      plugin.call("shell", "create.before", {
        command: "npm install left-pad",
        cwd: WORKSPACE,
        shell: "/bin/bash",
      }),
    /amos_workflow_gate_shell_confirm_unavailable/,
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
    /amos_workflow_gate_shell_confirm_unavailable/,
  );
});

test("parsed confirm defers to the native permission path and only tightens", async (t) => {
  const plugin = await setupPlugin(t, {
    workflowGate: enabledGate({ shellGate: true }),
  });

  // A parsed plan-class confirm resolves in shell.create.before so the host's
  // native permission path can run. This only shows the action is admitted to
  // that path; it does not prove a real UI prompt appears.
  await plugin.call("shell", "create.before", {
    command: "npm install left-pad",
    cwd: WORKSPACE,
    shell: "/bin/bash",
  });

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

type AssessmentCall = {
  requirement: RequirementFrame;
  action: { tool: string; operation: string; target: string };
  context: Record<string, unknown>;
};

function assessmentFacts(
  frameDigest: string,
  overrides: Partial<AssessmentFacts> = {},
): AssessmentFacts {
  return {
    intent: "feature",
    requirementMatch: "match",
    requirementFrameDigest: frameDigest,
    sensitiveArea: false,
    irreversible: false,
    riskScore: 0.2,
    confidence: 0.9,
    requiresReview: false,
    model: "fake-jev",
    ...overrides,
  };
}

type AssessmentSetupOptions = {
  assessmentRequired?: boolean;
  requirementEgress?: "allowed" | "denied";
  match?: RequirementMatch;
  facts?: Partial<AssessmentFacts>;
  fail?: boolean;
  policy?: { reviewRisk: number; denyRisk?: number; minConfidence?: number };
  mock?: MockOptions;
  deps?: WorkflowGateDeps;
};

async function setupAssessment(t: any, options: AssessmentSetupOptions = {}) {
  const state = { match: options.match ?? "match" };
  const calls: AssessmentCall[] = [];
  const successful: AssessmentCall[] = [];
  const provider: AssessmentProvider = {
    async assess(action, context, input) {
      const call = { requirement: input.requirement, action, context };
      calls.push(call);
      if (options.fail === true) {
        throw new Error("ASSESSMENT_PROVIDER_SECRET");
      }
      if (input.requirement.egress !== "allowed") {
        throw new Error("egress_denied");
      }
      successful.push(call);
      return assessmentFacts(requirementFrameDigest(input.requirement), {
        requirementMatch: state.match,
        ...options.facts,
      });
    },
  };

  const loaded = {
    systemOneClient: {
      request: async () => ({ answers: {}, model: "fake" }),
    },
    assessmentProvider: provider,
    config: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      defaultModel: "fake",
      models: ["fake"],
      timeoutMs: 1_000,
      assessmentRequired: options.assessmentRequired ?? false,
      policy: options.policy ?? { reviewRisk: 0.5 },
      allowCredentialEgress: false,
    },
  } as unknown as LoadedJevConfig;

  let loads = 0;
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        shellGate: true,
        actionAssessment: true,
        jevConfigPath: "decision/jev.local.json",
        ...(options.requirementEgress === "allowed"
          ? { requirementEgress: "allowed" }
          : {}),
      }),
    },
    options.mock ?? {},
    {
      ...options.deps,
      loadJevConfig: () => {
        loads += 1;
        return loaded;
      },
    },
  );

  return {
    plugin,
    calls,
    successful,
    state,
    loads: () => loads,
    loaded,
  };
}

function runShell(
  plugin: { call: (domain: any, name: string, event: any) => Promise<unknown> },
  sessionID?: string,
  command = "git status",
) {
  return plugin.call("shell", "create.before", {
    command,
    cwd: WORKSPACE,
    shell: "/bin/bash",
    ...(sessionID === undefined ? {} : { sessionID }),
  });
}

test("action assessment captures the prompt before guidance and isolates sessions", async (t) => {
  const { plugin, calls } = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
  });
  const secretA = "ASSESSMENT_PROMPT_SECRET_A";
  const secretB = "ASSESSMENT_PROMPT_SECRET_B";

  await plugin.call("session", "prompt", {
    sessionID: "ses_req_a",
    prompt: { text: `Update adapters ${secretA}` },
  });
  await runShell(plugin, "ses_req_a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requirement.session_id, "ses_req_a");
  assert.equal(calls[0].requirement.text.includes(secretA), true);
  const digestA = requirementFrameDigest(calls[0].requirement);

  await plugin.call("session", "prompt", {
    sessionID: "ses_req_b",
    prompt: { text: `Fix engine ${secretB}` },
  });
  await runShell(plugin, "ses_req_b");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].requirement.session_id, "ses_req_b");
  assert.notEqual(requirementFrameDigest(calls[1].requirement), digestA);

  // A new but invalid/oversized turn clears the stale frame: a required
  // assessment then fails closed without a provider call.
  await plugin.call("session", "prompt", {
    sessionID: "ses_req_a",
    prompt: { text: "" },
  });
  await assert.rejects(
    () => runShell(plugin, "ses_req_a"),
    /amos_workflow_gate_shell_denied/,
  );
  assert.equal(calls.length, 2);
});

test("tool events cannot create a requirement frame", async (t) => {
  const { plugin, calls } = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
  });

  await plugin.call("tool", "execute.before", {
    tool: "write",
    sessionID: "ses_tool_only",
    input: {
      path: join(WORKSPACE, "src", "example.ts"),
      content: "TOOL_CONTENT_SECRET",
    },
  });

  await assert.rejects(
    () => runShell(plugin, "ses_tool_only"),
    /amos_workflow_gate_shell_denied/,
  );
  assert.equal(calls.length, 0);
  const assessment = plugin.entries().at(-1).assessment;
  assert.equal(assessment.kind, "jev_assessment");
  assert.equal(assessment.error, "requirement_unavailable");
});

test("a matching plan-aware assessment keeps the deterministic allow and audits safely", async (t) => {
  const { plugin, calls } = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
    match: "match",
  });
  const promptSecret = "ASSESSMENT_REQUIREMENT_SECRET";
  const commandSecret = "ASSESSMENT_COMMAND_SECRET";

  await plugin.call("session", "prompt", {
    sessionID: "ses_match",
    prompt: { text: `Check the tree ${promptSecret}` },
  });
  await runShell(plugin, "ses_match", `git status ${commandSecret}`);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].action, {
    tool: "shell",
    operation: "shell_input",
    target: "unknown",
  });
  assert.deepEqual(Object.keys(calls[0].context).sort(), [
    "assessment",
    "operation",
  ]);
  const assessmentContext = calls[0].context.assessment as Record<string, unknown>;
  assert.deepEqual(Object.keys(assessmentContext).sort(), ["kind", "reason"]);
  const operationContext = calls[0].context.operation as Record<string, unknown>;
  assert.deepEqual(Object.keys(operationContext).sort(), ["effect", "program"]);

  const audit = plugin.entries().at(-1).assessment;
  assert.equal(audit.kind, "jev_assessment");
  assert.equal(audit.deterministic_verdict, "allow");
  assert.equal(audit.final_verdict, "allow");
  assert.equal(audit.requirementMatch, "match");
  assert.equal(audit.assessmentRequired, true);
  assert.deepEqual(Object.keys(audit.requirement).sort(), [
    "actor",
    "frame_digest",
    "root_frame_id",
    "source",
  ]);
  assert.equal(
    audit.requirement.frame_digest,
    requirementFrameDigest(calls[0].requirement),
  );
  const raw = plugin.rawLog();
  assert.equal(raw.includes(promptSecret), false);
  assert.equal(raw.includes(commandSecret), false);
  assert.equal(raw.includes("git status"), false);
});

test("a requirement mismatch denies even when the deterministic baseline allows", async (t) => {
  const { plugin } = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
    match: "mismatch",
  });

  await plugin.call("session", "prompt", {
    sessionID: "ses_mismatch",
    prompt: { text: "Only update documentation" },
  });
  await assert.rejects(
    () => runShell(plugin, "ses_mismatch"),
    /amos_workflow_gate_shell_denied/,
  );

  const audit = plugin.entries().at(-1).assessment;
  assert.equal(audit.deterministic_verdict, "allow");
  assert.equal(audit.final_verdict, "deny");
  assert.equal(audit.requirementMatch, "mismatch");
});

test("a partial requirement match confirms and a match cannot relax a confirm", async (t) => {
  // The permission hook exists here, yet a semantic tighten of a deterministic
  // allow must still fail closed because no native permission evaluation will
  // independently produce a confirm for it.
  const partial = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
    match: "partial",
  });
  assert.ok(partial.plugin.hooks.permission.has("evaluate"));
  await partial.plugin.call("session", "prompt", {
    sessionID: "ses_partial",
    prompt: { text: "Update normalization carefully" },
  });
  await assert.rejects(
    () => runShell(partial.plugin, "ses_partial"),
    /amos_workflow_gate_shell_confirm_unavailable/,
  );
  const partialAudit = partial.plugin.entries().at(-1).assessment;
  assert.equal(partialAudit.deterministic_verdict, "allow");
  assert.equal(partialAudit.final_verdict, "confirm");

  const matching = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
    match: "match",
  });
  await matching.plugin.call("session", "prompt", {
    sessionID: "ses_confirm",
    prompt: { text: "Install the dependency" },
  });
  // Deterministic confirm is handed to the native permission path; the clean
  // assessment cannot relax it back to allow.
  await runShell(matching.plugin, "ses_confirm", "npm install left-pad");
  const confirmAudit = matching.plugin.entries().at(-1).assessment;
  assert.equal(confirmAudit.deterministic_verdict, "confirm");
  assert.equal(confirmAudit.final_verdict, "confirm");
  assert.equal(confirmAudit.requirementMatch, "match");

  // The host permission path still runs for the baseline confirm.
  const ask = {
    action: "shell",
    resources: ["npm install left-pad"],
    effect: "allow",
  };
  await matching.plugin.call("permission", "evaluate", ask);
  assert.equal(ask.effect, "ask");
});

test("a required assessment without a captured frame denies without a provider call", async (t) => {
  const { plugin, calls } = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
  });

  await assert.rejects(
    () => runShell(plugin, "ses_missing_frame"),
    /amos_workflow_gate_shell_denied/,
  );
  assert.equal(calls.length, 0);

  const audit = plugin.entries().at(-1).assessment;
  assert.equal(audit.error, "requirement_unavailable");
  assert.equal(audit.final_verdict, "deny");
  assert.equal(audit.requirement, null);
});

test("required provider failure denies and optional failure preserves the baseline", async (t) => {
  const required = await setupAssessment(t, {
    assessmentRequired: true,
    requirementEgress: "allowed",
    fail: true,
  });
  await required.plugin.call("session", "prompt", {
    sessionID: "ses_required_failure",
    prompt: { text: "Update the adapter" },
  });
  await assert.rejects(
    () => runShell(required.plugin, "ses_required_failure"),
    /amos_workflow_gate_shell_denied/,
  );
  const requiredAudit = required.plugin.entries().at(-1).assessment;
  assert.equal(requiredAudit.error, "assessment_failed");
  assert.equal(requiredAudit.final_verdict, "deny");
  assert.equal(requiredAudit.requirementMatch, undefined);

  const optional = await setupAssessment(t, {
    assessmentRequired: false,
    requirementEgress: "allowed",
    fail: true,
  });
  await optional.plugin.call("session", "prompt", {
    sessionID: "ses_optional_failure",
    prompt: { text: "Update the adapter" },
  });
  await runShell(optional.plugin, "ses_optional_failure");
  const optionalAudit = optional.plugin.entries().at(-1).assessment;
  assert.equal(optionalAudit.error, "assessment_failed");
  assert.equal(optionalAudit.deterministic_verdict, "allow");
  assert.equal(optionalAudit.final_verdict, "allow");

  const optionalMissing = await setupAssessment(t, {
    assessmentRequired: false,
    requirementEgress: "allowed",
  });
  await runShell(optionalMissing.plugin, "ses_optional_missing");
  const missingAudit = optionalMissing.plugin.entries().at(-1).assessment;
  assert.equal(missingAudit.error, "requirement_unavailable");
  assert.equal(missingAudit.final_verdict, "allow");
});

test("a denied requirement egress cannot produce a successful provider call", async (t) => {
  const { plugin, calls, successful } = await setupAssessment(t, {
    assessmentRequired: false,
  });
  const promptSecret = "ASSESSMENT_EGRESS_SECRET";

  await plugin.call("session", "prompt", {
    sessionID: "ses_egress",
    prompt: { text: `Update adapter ${promptSecret}` },
  });
  await runShell(plugin, "ses_egress");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].requirement.egress, "denied");
  assert.equal(successful.length, 0);
  const audit = plugin.entries().at(-1).assessment;
  assert.equal(audit.error, "assessment_failed");
  assert.equal(audit.requirementMatch, undefined);
  assert.equal(audit.final_verdict, "allow");
  assert.equal(plugin.rawLog().includes(promptSecret), false);
});

test("action assessment loads Jev once even when completion review is off", async (t) => {
  const { plugin, loads } = await setupAssessment(t, {
    assessmentRequired: false,
    requirementEgress: "allowed",
  });

  assert.equal(loads(), 1);
  await plugin.call("session", "prompt", {
    sessionID: "ses_load_once",
    prompt: { text: "Update adapter" },
  });
  await runShell(plugin, "ses_load_once");
  await runShell(plugin, "ses_load_once", "npm install left-pad");
  assert.equal(loads(), 1);
});

test("an action-assessment config failure makes gated shell actions fail closed", async (t) => {
  const secret = "ACTION_ASSESSMENT_CONFIG_SECRET";
  const plugin = await setupPlugin(
    t,
    {
      workflowGate: enabledGate({
        shellGate: true,
        actionAssessment: true,
        jevConfigPath: "decision/jev.local.json",
      }),
    },
    {},
    {
      loadJevConfig: () => {
        throw new Error(secret);
      },
    },
  );

  await assert.rejects(
    () => runShell(plugin, "ses_config_failure"),
    (error: Error) => {
      assert.equal(error.message, "amos_workflow_gate_config_error");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );

  // Deterministic deny is unchanged and never becomes a config error.
  await assert.rejects(
    () => runShell(plugin, "ses_config_failure", "rm -rf /tmp/whatever"),
    /amos_workflow_gate_shell_denied/,
  );

  const audit = plugin.entries().at(-1).assessment;
  assert.equal(audit.error, "assessment_failed");
  assert.equal(plugin.rawLog().includes(secret), false);
});
