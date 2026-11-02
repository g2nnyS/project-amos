import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type {
  JevConfigLoadOptions,
  LoadedJevConfig,
} from '../../decision/config.ts';
import { requirementFrameDigest } from '../../decision/requirement.ts';
import type {
  AssessmentAction,
  AssessmentContext,
  AssessmentFacts,
  AssessmentInput,
  AssessmentProvider,
} from '../../decision/types.ts';
import {
  createInjectorSession,
  getProjectSeedSnapshot,
  type InjectorSession,
} from '../../injector/index.ts';
import type {
  ChangeReviewOptions,
  ChangeReviewResult,
} from '../../workflow/change-review.ts';
import type {
  EngineeringReviewInput,
  EngineeringReviewResult,
} from '../../workflow/engineering-review.ts';
import type {
  AssessShellOptions,
  ShellAssessment,
} from '../../workflow/shell.ts';
import { assessShellCommand } from '../../workflow/shell.ts';

import amosPiLogOnly, {
  WORKFLOW_CONFIG_ERROR,
  WORKFLOW_GUIDANCE_SECTION,
  WORKFLOW_REVIEW_CUSTOM_TYPE,
  WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  WORKFLOW_SHELL_DENIED,
  readPiWorkflowGateState,
  type PiShellSettings,
  type PiWorkflowDependencies,
  type PiWorkflowOverrides,
} from './index.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');

type Handler = (event: unknown, ctx: unknown) => unknown;

interface SetupOptions {
  gate?: unknown;
  config?: unknown;
  hasUI?: boolean;
  confirm?: (title: string, message: string) => boolean | Promise<boolean>;
  deps?: PiWorkflowOverrides;
  settings?: PiShellSettings;
}

function baseConfig(gate?: unknown): Record<string, unknown> {
  return {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: './audit.jsonl',
    ...(gate === undefined ? {} : { workflowGate: gate }),
  };
}

function allowAssessment(reason: ShellAssessment['reason'] = 'safe_workflow_command'): ShellAssessment {
  return {
    kind: 'plan',
    verdict: 'allow',
    reason,
    operations: [],
  };
}

function confirmAssessment(): ShellAssessment {
  return {
    kind: 'opaque',
    verdict: 'confirm',
    reason: 'opaque_expansion',
    operations: [],
  };
}

/** A parsed plan that still requires confirmation (not opaque). */
function planConfirmAssessment(): ShellAssessment {
  return {
    kind: 'plan',
    verdict: 'confirm',
    reason: 'network_access',
    operations: [
      {
        program: 'curl',
        effect: 'network',
        targets: [],
        verdict: 'confirm',
        reason: 'network_access',
      },
    ],
  };
}

interface FakeJevOptions {
  assess?: AssessmentProvider['assess'];
  assessmentRequired?: boolean;
}

function fakeJevConfig(options: FakeJevOptions = {}): LoadedJevConfig {
  return {
    config: {
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      defaultModel: 'test-model',
      models: ['test-model'],
      timeoutMs: 1_000,
      assessmentRequired: options.assessmentRequired ?? true,
      policy: { reviewRisk: 0.5 },
      allowCredentialEgress: false,
    },
    systemOneClient: {
      model: 'test-model',
      models: ['test-model'],
      async request() {
        throw new Error('unexpected System One request');
      },
    },
    assessmentProvider: {
      assess:
        options.assess ??
        (async () => {
          throw new Error('unexpected assessment');
        }),
    },
  } as unknown as LoadedJevConfig;
}

function factsFor(
  requirement: AssessmentInput['requirement'],
  overrides: Partial<AssessmentFacts> = {},
): AssessmentFacts {
  return {
    intent: 'chore',
    requirementMatch: 'match',
    requirementFrameDigest: requirementFrameDigest(requirement),
    sensitiveArea: false,
    irreversible: false,
    riskScore: 0.1,
    confidence: 0.9,
    requiresReview: false,
    model: 'test-model',
    ...overrides,
  };
}

function actionAssessmentGate(
  requirementEgress: 'allowed' | 'denied' = 'allowed',
): Record<string, unknown> {
  return {
    enabled: true,
    guidance: false,
    shellGate: true,
    completionReview: false,
    actionAssessment: true,
    jevConfigPath: './jev.json',
    requirementEgress,
  };
}

interface AssessmentCall {
  readonly action: AssessmentAction;
  readonly context: AssessmentContext;
  readonly input: AssessmentInput;
}

function matchingProvider(
  calls: AssessmentCall[],
  overrides: Partial<AssessmentFacts> = {},
): AssessmentProvider {
  return {
    async assess(action, context, input) {
      calls.push({ action, context, input });
      return factsFor(input.requirement, overrides);
    },
  };
}

function assessmentRecords(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return entries
    .map((entry) => entry.assessment)
    .filter(
      (assessment): assessment is Record<string, unknown> =>
        typeof assessment === 'object' &&
        assessment !== null &&
        !Array.isArray(assessment),
    );
}

function setup(t: { after(callback: () => void): void }, options: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'amos-pi-workflow-'));
  const directory = join(root, 'workspace');
  mkdirSync(directory, { recursive: true });

  const config =
    'config' in options ? options.config : baseConfig(options.gate);
  if (config !== null) {
    mkdirSync(join(directory, '.pi'), { recursive: true });
    writeFileSync(
      join(directory, '.pi', 'amos.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
      'utf8',
    );
  }

  const sessionCreations: InjectorSession[] = [];
  const shellAssessments: Array<{
    command: string;
    options: AssessShellOptions;
  }> = [];
  const changeReviewCalls: ChangeReviewOptions[] = [];
  const jevLoads: Array<{ path: string; options?: JevConfigLoadOptions }> = [];
  const engineeringCalls: EngineeringReviewInput[] = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];

  const cleanReview: ChangeReviewResult = {
    cwd: directory,
    checks: [],
    egress: {
      eligible: true,
      reason: 'eligible',
      diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
      digest: 'digest-clean',
      truncated: false,
      omittedFiles: [],
    },
    digest: 'digest-clean',
    previousDigest: null,
    changedSinceLastCall: null,
  };

  const defaults: PiWorkflowDependencies = {
    createSession() {
      const session = createInjectorSession(getProjectSeedSnapshot());
      sessionCreations.push(session);
      return session;
    },
    assessShellCommand(command, assessOptions) {
      shellAssessments.push({ command, options: assessOptions });
      return allowAssessment();
    },
    async createChangeReview(reviewOptions) {
      changeReviewCalls.push(reviewOptions);
      return cleanReview;
    },
    loadJevConfig(path, loadOptions) {
      jevLoads.push({ path, options: loadOptions });
      return fakeJevConfig();
    },
    async reviewEngineeringChange(input) {
      engineeringCalls.push(input);
      const result: EngineeringReviewResult = {
        status: 'pass',
        reason: 'clear',
        model: 'test-model',
        diffDigest: input.diff.digest ?? '',
        guidancePackIds: input.guidance.map((pack) => pack.id),
        facts: null,
      };
      return result;
    },
    getSettings() {
      return options.settings ?? {
        shellPath: '/bin/bash',
        shellCommandPrefix: '',
      };
    },
  };

  const dependencies: PiWorkflowDependencies = {
    ...defaults,
    ...(options.deps ?? {}),
  };

  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
    getSettings() {
      return options.settings ?? {
        shellPath: '/bin/bash',
        shellCommandPrefix: '',
      };
    },
  } as unknown as ExtensionAPI;

  amosPiLogOnly(pi, dependencies);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  let sessionId = 'session-test';
  const ctx = {
    cwd: directory,
    hasUI: options.hasUI ?? false,
    ui: {
      async confirm(title: string, message: string) {
        confirmCalls.push({ title, message });
        return options.confirm === undefined
          ? false
          : await options.confirm(title, message);
      },
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
    signal: undefined,
  };

  function handler(name: string): Handler {
    const registered = handlers.get(name);
    assert.ok(registered, `missing handler: ${name}`);
    return registered;
  }

  return {
    directory,
    ctx,
    sessionCreations,
    shellAssessments,
    changeReviewCalls,
    jevLoads,
    engineeringCalls,
    confirmCalls,
    setSessionId(next: string): void {
      sessionId = next;
    },
    async sessionStart(
      reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' = 'startup',
    ): Promise<unknown> {
      return await handler('session_start')(
        { type: 'session_start', reason },
        ctx,
      );
    },
    async beforeAgentStart(event: Record<string, unknown>): Promise<unknown> {
      return await handler('before_agent_start')(event, ctx);
    },
    async toolCall(
      toolName: string,
      input: unknown,
      toolCallId = 'call-1',
    ): Promise<unknown> {
      return await handler('tool_call')(
        {
          type: 'tool_call',
          toolCallId,
          toolName,
          input,
        },
        ctx,
      );
    },
    async toolResult(
      toolCallId: string,
      toolName: string,
      content: unknown[],
      extra: {
        structuredContent?: unknown;
        details?: unknown;
        isError?: boolean;
      } = {},
    ): Promise<unknown> {
      return await handler('tool_result')(
        {
          type: 'tool_result',
          toolCallId,
          toolName,
          input: {},
          content,
          isError: extra.isError ?? false,
          ...(extra.structuredContent === undefined
            ? {}
            : { structuredContent: extra.structuredContent }),
          ...(extra.details === undefined ? {} : { details: extra.details }),
        },
        ctx,
      );
    },
    async userBash(command: string): Promise<unknown> {
      return await handler('user_bash')(
        {
          type: 'user_bash',
          command,
          excludeFromContext: false,
          cwd: directory,
        },
        ctx,
      );
    },
    async beforeSettle(
      outcome: 'completed' | 'aborted' | 'error' = 'completed',
    ): Promise<unknown> {
      return await handler('agent_before_settle')(
        {
          type: 'agent_before_settle',
          outcome,
          entries: [],
          continue: false,
          context: {
            contextEntries: [],
            contextMessages: [],
            llmMessages: [],
            pendingMessages: [],
            canContinue: true,
          },
        },
        ctx,
      );
    },
    entries(): Array<Record<string, unknown>> {
      const path = join(directory, 'audit.jsonl');
      if (!existsSync(path)) {
        return [];
      }
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    rawLog(): string {
      const path = join(directory, 'audit.jsonl');
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    },
  };
}

test('guidance is injected into a namespaced prompt section without echoing the prompt', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: false,
      completionReview: false,
    },
  });

  const rawPrompt = 'RAW_PROMPT_SECRET_7f3c do secret things';
  const sections: Record<string, string> = { existing: 'keep this section' };

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: rawPrompt,
    systemPrompt: '',
    systemPromptOptions: { sections },
  });

  assert.equal(sections.existing, 'keep this section');
  const guidance = sections[WORKFLOW_GUIDANCE_SECTION];
  assert.equal(typeof guidance, 'string');
  assert.ok((guidance ?? '').length > 0);
  assert.match(guidance ?? '', /<amos-guidance /);
  assert.match(guidance ?? '', /policy="[^"]+"/);
  assert.match(guidance ?? '', /digest="[^"]+"/);
  assert.match(guidance ?? '', /mode="advisory"/);
  assert.equal(guidance?.includes(rawPrompt), false);
  assert.equal(guidance?.includes('RAW_PROMPT_SECRET_7f3c'), false);
  assert.equal(hook.sessionCreations.length, 1);

  // Runs started by custom messages have no prompt and must not gain guidance.
  const customSections: Record<string, string> = {};
  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'custom',
    message: { customType: 'x', content: 'hi' },
    systemPrompt: '',
    systemPromptOptions: { sections: customSections },
  });
  assert.equal(customSections[WORKFLOW_GUIDANCE_SECTION], undefined);
  assert.equal(hook.sessionCreations.length, 1);
});

test('deny blocks a bash tool call with a fixed code and permits no command leakage', async (t) => {
  const assessments: Array<{
    command: string;
    options: AssessShellOptions;
  }> = [];
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      assessShellCommand(command, options) {
        assessments.push({ command, options });
        return assessShellCommand(command, options);
      },
    },
  });

  const command = 'rm -rf / VERY_SECRET_ARGUMENT';
  const result = await hook.toolCall('bash', { command });

  assert.deepEqual(result, {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(JSON.stringify(result).includes(command), false);
  assert.equal(hook.rawLog().includes(command), false);
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0]?.command, command);
});

test('confirm requires UI approval and blocks without UI or on decline', async (t) => {
  const command = 'echo hi > /tmp/outside';

  const noUi = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  assert.deepEqual(await noUi.toolCall('bash', { command }), {
    block: true,
    reason: WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  });
  assert.equal(noUi.confirmCalls.length, 0);
  assert.equal(noUi.rawLog().includes(command), false);

  const declined = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    hasUI: true,
    confirm: () => false,
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  assert.deepEqual(await declined.toolCall('bash', { command }), {
    block: true,
    reason: WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  });
  assert.equal(declined.confirmCalls.length, 1);
  assert.equal(declined.rawLog().includes(command), false);

  const approved = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    hasUI: true,
    confirm: () => true,
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  assert.equal(await approved.toolCall('bash', { command }), undefined);
  assert.equal(approved.confirmCalls.length, 1);
  // The command is confined to the interactive confirmation message.
  assert.equal(approved.confirmCalls[0]?.message.includes(command), true);
  assert.equal(approved.rawLog().includes(command), false);
});

test('shell calls pass cwd, dialect and Pi shell settings; non-shell tools are unchanged', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    settings: { shellPath: '/bin/sh', shellCommandPrefix: '' },
  });

  assert.equal(await hook.toolCall('bash', { command: 'git status' }), undefined);
  assert.deepEqual(hook.shellAssessments[0], {
    command: 'git status',
    options: {
      cwd: hook.directory,
      dialect: 'bash',
      shellPath: '/bin/sh',
      commandPrefix: '',
    },
  });

  assert.equal(
    await hook.toolCall('powershell', { command: 'Get-ChildItem' }),
    undefined,
  );
  assert.equal(hook.shellAssessments[1]?.options.dialect, 'powershell');

  assert.equal(
    await hook.toolCall('read', {
      path: join(hook.directory, 'src/example.ts'),
    }),
    undefined,
  );
  assert.equal(hook.shellAssessments.length, 2);
});

test('direct user_bash: hard deny stays denied and a literal confirm auto-allows without UI', async (t) => {
  const command = 'rm -rf / USER_BASH_SECRET';

  const blocked = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      assessShellCommand,
    },
  });

  await assert.rejects(
    () => blocked.userBash(command),
    (error: unknown) =>
      error instanceof Error &&
      error.message === WORKFLOW_SHELL_DENIED &&
      !error.message.includes(command),
  );
  assert.equal(blocked.rawLog().includes(command), false);

  const literal = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  assert.equal(await literal.userBash('echo literal'), undefined);
  assert.equal(literal.confirmCalls.length, 0);
  assert.equal(literal.rawLog().includes('echo literal'), false);
  const literalEntries = assessmentRecords(literal.entries());
  assert.equal(literalEntries.length, 1);
  assert.equal(literalEntries[0]?.kind, 'user_literal_grant');
  assert.equal(literalEntries[0]?.deterministic_verdict, 'confirm');
  assert.equal(literalEntries[0]?.final_verdict, 'allow');

  // A valid literal grant also needs no UI prompt when a UI is available.
  const approved = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    hasUI: true,
    confirm: () => true,
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  assert.equal(await approved.userBash('echo literal'), undefined);
  assert.equal(approved.confirmCalls.length, 0);

  // A capture/binding failure falls back to ordinary confirmation behavior.
  const unbound = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      assessShellCommand() {
        return confirmAssessment();
      },
    },
  });
  unbound.setSessionId('');
  await assert.rejects(
    () => unbound.userBash('echo unbound'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === WORKFLOW_SHELL_CONFIRMATION_REQUIRED &&
      !error.message.includes('echo unbound'),
  );
});

test('disabled workflowGate preserves the previous log-only behavior', async (t) => {
  const hook = setup(t, {
    gate: { enabled: false },
    deps: {
      assessShellCommand() {
        assert.fail('disabled gate must not assess shell commands');
      },
    },
  });

  assert.equal(
    await hook.toolCall('bash', { command: 'rm -rf / DISABLED_SECRET' }),
    undefined,
  );
  assert.equal(
    await hook.userBash('rm -rf / DISABLED_SECRET'),
    undefined,
  );

  const entries = hook.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.action),
    [
      { tool: 'bash', operation: 'shell_input', target: 'unknown' },
      { tool: 'user_bash', operation: 'shell_input', target: 'unknown' },
    ],
  );
  assert.equal(hook.rawLog().includes('DISABLED_SECRET'), false);
});

test('completion feedback requests exactly one continuation per session, even if the digest changes', async (t) => {
  const changeReviewCalls: ChangeReviewOptions[] = [];
  let reviewCount = 0;
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: true,
      jevConfigPath: './jev.json',
    },
    deps: {
      async createChangeReview(options) {
        changeReviewCalls.push(options);
        reviewCount += 1;
        const digest = `digest-${reviewCount}`;
        const review = {
          cwd: ROOT,
          checks: [
            {
              id: 'typecheck' as const,
              argv: ['npm', 'run', 'typecheck'],
              exitCode: 1,
              timedOut: false,
              outputTruncated: false,
              outputWithheld: false,
              stdout: 'DO_NOT_LEAK',
              stderr: 'DO_NOT_LEAK',
              ok: false,
            },
          ],
          egress: {
            eligible: true,
            reason: 'eligible' as const,
            diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
            digest,
            truncated: false,
            omittedFiles: [],
          },
          digest,
          previousDigest: null,
          changedSinceLastCall: null,
        };
        return review;
      },
      async reviewEngineeringChange() {
        assert.fail('checks failed, engineering review should not run');
      },
    },
  });

  const first = await hook.beforeSettle();
  assert.ok(first !== null && typeof first === 'object');
  const firstResult = first as {
    continue?: boolean;
    entries?: Array<{
      type: string;
      customType?: string;
      content?: unknown;
      display?: boolean;
    }>;
  };
  assert.equal(firstResult.continue, true);
  assert.equal(firstResult.entries?.length, 1);
  assert.equal(firstResult.entries?.[0]?.type, 'custom_message');
  assert.equal(firstResult.entries?.[0]?.customType, WORKFLOW_REVIEW_CUSTOM_TYPE);
  assert.equal(firstResult.entries?.[0]?.display, false);
  const feedback = String(firstResult.entries?.[0]?.content ?? '');
  assert.match(feedback, /local_check_failed: typecheck/);
  assert.equal(feedback.includes('DO_NOT_LEAK'), false);

  assert.equal(await hook.beforeSettle(), undefined);
  assert.equal(changeReviewCalls.length, 2);
});

test('clean completion and no-change completion do not loop or call Jev', async (t) => {
  const changeReviewCalls: ChangeReviewOptions[] = [];
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: true,
      jevConfigPath: './jev.json',
    },
    deps: {
      async createChangeReview(options) {
        changeReviewCalls.push(options);
        return {
          cwd: ROOT,
          checks: [],
          egress: {
            eligible: true,
            reason: 'eligible',
            diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
            digest: 'digest-clean',
            truncated: false,
            omittedFiles: [],
          },
          digest: 'digest-clean',
          previousDigest: null,
          changedSinceLastCall: null,
        };
      },
    },
  });

  assert.equal(await hook.beforeSettle(), undefined);
  assert.equal(hook.engineeringCalls.length, 1);
  assert.equal(hook.jevLoads.length, 1);

  const noChangeCalls: ChangeReviewOptions[] = [];
  const noChange = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: true,
      jevConfigPath: './jev.json',
    },
    deps: {
      async createChangeReview(options) {
        noChangeCalls.push(options);
        return {
          cwd: ROOT,
          checks: [],
          egress: {
            eligible: false,
            reason: 'no_changes',
            digest: 'digest-empty',
            truncated: false,
            omittedFiles: [],
          },
          digest: 'digest-empty',
          previousDigest: null,
          changedSinceLastCall: null,
        };
      },
      loadJevConfig() {
        assert.fail('no-change review must not load Jev');
      },
    },
  });

  assert.equal(await noChange.beforeSettle(), undefined);
  assert.equal(noChange.jevLoads.length, 0);
  assert.equal(changeReviewCalls.length, 1);
  assert.equal(noChangeCalls.length, 1);
});

test('Jev config load failure holds for review instead of passing', async (t) => {
  const changeReviewCalls: ChangeReviewOptions[] = [];
  let jevLoadCalls = 0;
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: true,
      jevConfigPath: './jev.json',
    },
    deps: {
      async createChangeReview(options) {
        changeReviewCalls.push(options);
        return {
          cwd: ROOT,
          checks: [],
          egress: {
            eligible: true,
            reason: 'eligible',
            diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
            digest: 'digest-jev',
            truncated: false,
            omittedFiles: [],
          },
          digest: 'digest-jev',
          previousDigest: null,
          changedSinceLastCall: null,
        };
      },
      loadJevConfig() {
        jevLoadCalls += 1;
        throw new Error('JEV_CONFIG_SECRET');
      },
      async reviewEngineeringChange() {
        assert.fail('engineering review must not run after a config load failure');
      },
    },
  });

  const first = await hook.beforeSettle();
  assert.ok(first !== null && typeof first === 'object');
  const feedback = String(
    (first as { entries?: Array<{ content?: unknown }> }).entries?.[0]
      ?.content ?? '',
  );
  assert.match(feedback, /engineering_review_error: config/);
  assert.equal(feedback.includes('JEV_CONFIG_SECRET'), false);

  assert.equal(await hook.beforeSettle(), undefined);
  assert.equal(changeReviewCalls.length, 2);
  assert.equal(jevLoadCalls, 1);
});

test('engineering uncertainty holds once and never auto-approves', async (t) => {
  const changeReviewCalls: ChangeReviewOptions[] = [];
  let engineeringReviewCalls = 0;
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: true,
      jevConfigPath: './jev.json',
    },
    deps: {
      async createChangeReview(options) {
        changeReviewCalls.push(options);
        return {
          cwd: ROOT,
          checks: [],
          egress: {
            eligible: true,
            reason: 'eligible',
            diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
            digest: 'digest-unknown',
            truncated: false,
            omittedFiles: [],
          },
          digest: 'digest-unknown',
          previousDigest: null,
          changedSinceLastCall: null,
        };
      },
      async reviewEngineeringChange() {
        engineeringReviewCalls += 1;
        return {
          status: 'unknown',
          reason: 'ambiguous',
          model: 'test-model',
          diffDigest: 'digest-unknown',
          guidancePackIds: [],
          facts: null,
        };
      },
    },
  });

  const first = await hook.beforeSettle();
  assert.ok(first !== null && typeof first === 'object');
  const result = first as { continue?: boolean; entries?: Array<{ content?: unknown }> };
  assert.equal(result.continue, true);
  assert.match(
    String(result.entries?.[0]?.content ?? ''),
    /engineering_review_unknown: ambiguous/,
  );
  assert.equal(await hook.beforeSettle(), undefined);
  assert.equal(changeReviewCalls.length, 2);
  assert.equal(engineeringReviewCalls, 1);
});

test('a malformed existing config cannot silently disable the workflow gate', async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  const hook = setup(t, { config: '{"mode":' });
  const command = 'TOP_SECRET_MALFORMED_CONFIG';

  assert.deepEqual(await hook.toolCall('bash', { command }), {
    block: true,
    reason: WORKFLOW_CONFIG_ERROR,
  });
  await assert.rejects(
    () => hook.userBash(command),
    (error: unknown) =>
      error instanceof Error && error.message === WORKFLOW_CONFIG_ERROR,
  );

  assert.equal(errors.length, 2);
  assert.ok(errors.every((message) => !message.includes(command)));
  assert.ok(errors.every((message) => !message.includes(hook.directory)));
});

test('gate configuration errors fail closed and are reported without paths or secrets', async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  const hook = setup(t, {
    gate: { enabled: true },
    deps: {
      assessShellCommand() {
        assert.fail('malformed gate must not assess commands');
      },
    },
  });

  assert.equal(readPiWorkflowGateState(hook.directory).status, 'error');

  const command = 'TOP_SECRET_WORKFLOW_COMMAND';
  assert.deepEqual(await hook.toolCall('bash', { command }), {
    block: true,
    reason: WORKFLOW_CONFIG_ERROR,
  });
  await assert.rejects(
    () => hook.userBash(command),
    (error: unknown) =>
      error instanceof Error && error.message === WORKFLOW_CONFIG_ERROR,
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /workflow gate configuration error/);
  assert.equal(errors[0]?.includes(hook.directory), false);
  assert.equal(errors[0]?.includes(command), false);
  assert.equal(hook.rawLog().includes(command), false);
});

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  details?: unknown;
  isError?: unknown;
  usage?: unknown;
}

test('write and edit calls append exactly one independent advisory area block without leaking the target path', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: false,
      completionReview: false,
    },
  });

  const engineTarget = join(hook.directory, 'engine', 'engine.ts');
  const adaptersTarget = join(hook.directory, 'adapters', 'pi', 'index.ts');

  assert.equal(
    await hook.toolCall('write', { path: engineTarget }, 'call-write'),
    undefined,
  );

  const originalText = { type: 'text', text: 'original write result' };
  const originalImage = { type: 'image', data: 'base64', mimeType: 'image/png' };
  const structuredContent = { ok: true, files: ['engine.ts'] };
  const writeResult = (await hook.toolResult(
    'call-write',
    'write',
    [originalText, originalImage],
    { structuredContent },
  )) as ToolResultLike;

  assert.ok(Array.isArray(writeResult.content));
  assert.equal(writeResult.content?.length, 3);
  // Existing content blocks are preserved by reference and by value.
  assert.equal(writeResult.content?.[0], originalText);
  assert.equal(writeResult.content?.[1], originalImage);
  const writeBlock = writeResult.content?.[2];
  assert.equal(writeBlock?.type, 'text');
  assert.match(writeBlock?.text ?? '', /^<amos-guidance /);
  assert.match(writeBlock?.text ?? '', /\[engine-pure\]/);
  assert.equal(writeBlock?.text?.includes(hook.directory), false);
  assert.equal(writeBlock?.text?.includes('engine.ts'), false);
  assert.deepEqual(writeResult.structuredContent, structuredContent);
  assert.equal('details' in writeResult, false);
  assert.equal('isError' in writeResult, false);
  assert.equal('usage' in writeResult, false);

  assert.equal(
    await hook.toolCall('edit', { path: adaptersTarget }, 'call-edit'),
    undefined,
  );
  const editResult = (await hook.toolResult(
    'call-edit',
    'edit',
    [{ type: 'text', text: 'original edit result' }],
  )) as ToolResultLike;
  assert.equal(editResult.content?.length, 2);
  assert.equal(editResult.content?.[0]?.text, 'original edit result');
  assert.match(editResult.content?.[1]?.text ?? '', /\[adapters-own-normalization\]/);
  assert.equal(editResult.content?.[1]?.text?.includes(hook.directory), false);

  // The same area is never injected twice in one session.
  assert.equal(
    await hook.toolCall(
      'write',
      { path: join(hook.directory, 'engine', 'other.ts') },
      'call-repeat',
    ),
    undefined,
  );
  assert.equal(
    await hook.toolResult('call-repeat', 'write', [
      { type: 'text', text: 'repeat result' },
    ]),
    undefined,
  );

  // Both write and edit remain ordinary audit records.
  const entries = hook.entries();
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.action),
    [
      { tool: 'write', operation: 'file_write', target: engineTarget },
      { tool: 'edit', operation: 'file_write', target: adaptersTarget },
      {
        tool: 'write',
        operation: 'file_write',
        target: join(hook.directory, 'engine', 'other.ts'),
      },
    ],
  );
  assert.equal(hook.rawLog().includes('repeat result'), false);
});

test('prompt injections do not repeat rules in one session and a new session starts fresh', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: false,
      completionReview: false,
    },
  });

  const prompt = 'please work on the typescript engine';

  async function promptScore(): Promise<string | undefined> {
    const sections: Record<string, string> = {};
    await hook.beforeAgentStart({
      type: 'before_agent_start',
      messageType: 'user',
      prompt,
      systemPrompt: '',
      systemPromptOptions: { sections },
    });
    return sections[WORKFLOW_GUIDANCE_SECTION];
  }

  const first = await promptScore();
  assert.ok((first ?? '').length > 0);
  const repeated = await promptScore();
  assert.notEqual(repeated, first);
  assert.equal(repeated?.includes(first ?? 'impossible'), false);

  // A genuinely new session ID gets a fresh injector state.
  hook.setSessionId('session-next');
  await hook.sessionStart('new');
  const fresh = await promptScore();
  assert.equal(fresh, first);
  assert.equal(hook.sessionCreations.length, 2);
});

test('the same toolCallId in two sessions keeps each queued area independent', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: false,
      completionReview: false,
    },
  });

  const engineTarget = join(hook.directory, 'engine', 'engine.ts');
  const adaptersTarget = join(hook.directory, 'adapters', 'pi', 'index.ts');

  assert.equal(
    await hook.toolCall('write', { path: engineTarget }, 'call-1'),
    undefined,
  );

  // Pi call IDs are only unique per session, so the second session reuses it.
  hook.setSessionId('session-other');
  await hook.sessionStart('new');
  assert.equal(
    await hook.toolCall('write', { path: adaptersTarget }, 'call-1'),
    undefined,
  );

  // The second session only consumes its own queued area.
  const otherResult = (await hook.toolResult('call-1', 'write', [
    { type: 'text', text: 'other result' },
  ])) as ToolResultLike;
  assert.equal(otherResult.content?.length, 2);
  assert.equal(otherResult.content?.[0]?.text, 'other result');
  assert.match(
    otherResult.content?.[1]?.text ?? '',
    /\[adapters-own-normalization\]/,
  );
  assert.equal(
    otherResult.content?.[1]?.text?.includes('[engine-pure]'),
    false,
  );

  // Switching back still finds the first session's queued call.
  hook.setSessionId('session-test');
  const firstResult = (await hook.toolResult('call-1', 'write', [
    { type: 'text', text: 'first result' },
  ])) as ToolResultLike;
  assert.equal(firstResult.content?.length, 2);
  assert.equal(firstResult.content?.[0]?.text, 'first result');
  assert.match(firstResult.content?.[1]?.text ?? '', /\[engine-pure\]/);
  assert.equal(
    firstResult.content?.[1]?.text?.includes('[adapters-own-normalization]'),
    false,
  );

  // Both calls were retired; neither block is emitted a second time.
  assert.equal(
    await hook.toolResult('call-1', 'write', [
      { type: 'text', text: 'again' },
    ]),
    undefined,
  );
});

test('injector factory, selection and queue exceptions never change tool call outcomes or audit records', async (t) => {
  // Factory failure: prompts and advisory queueing are inert, recording and
  // the shell gate keep working.
  const factoryFailure = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      createSession() {
        throw new Error('SESSION_FACTORY_SECRET');
      },
      assessShellCommand,
    },
  });

  const sections: Record<string, string> = { existing: 'keep this section' };
  assert.equal(
    await factoryFailure.beforeAgentStart({
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'typescript engine',
      systemPrompt: '',
      systemPromptOptions: { sections },
    }),
    undefined,
  );
  assert.deepEqual(sections, { existing: 'keep this section' });

  const writeTarget = join(factoryFailure.directory, 'engine', 'engine.ts');
  assert.equal(
    await factoryFailure.toolCall('write', { path: writeTarget }),
    undefined,
  );
  assert.equal(
    await factoryFailure.toolResult('call-1', 'write', [
      { type: 'text', text: 'unchanged' },
    ]),
    undefined,
  );
  assert.deepEqual(
    await factoryFailure.toolCall('bash', { command: 'rm -rf / SECRET' }),
    { block: true, reason: WORKFLOW_SHELL_DENIED },
  );

  const factoryEntries = factoryFailure.entries();
  assert.equal(factoryEntries.length, 2);
  assert.deepEqual(factoryEntries[0]?.action, {
    tool: 'write',
    operation: 'file_write',
    target: writeTarget,
  });
  assert.equal(
    (factoryEntries[1]?.action as { tool?: string } | undefined)?.tool,
    'bash',
  );
  assert.equal(factoryFailure.rawLog().includes('SECRET'), false);

  // A session whose selection/queue/area calls throw stays advisory.
  const throwingSession: InjectorSession = {
    selectPrompt() {
      throw new Error('SELECT_SECRET');
    },
    queueAction() {
      throw new Error('QUEUE_SECRET');
    },
    selectPendingArea() {
      throw new Error('AREA_SECRET');
    },
    commit() {
      throw new Error('COMMIT_SECRET');
    },
  };
  const selectionFailure = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: true,
      completionReview: false,
    },
    deps: {
      createSession() {
        return throwingSession;
      },
      assessShellCommand,
    },
  });

  const throwingSections: Record<string, string> = { existing: 'keep this section' };
  assert.equal(
    await selectionFailure.beforeAgentStart({
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'typescript engine',
      systemPrompt: '',
      systemPromptOptions: { sections: throwingSections },
    }),
    undefined,
  );
  assert.deepEqual(throwingSections, { existing: 'keep this section' });

  const selectionTarget = join(selectionFailure.directory, 'engine', 'engine.ts');
  assert.equal(
    await selectionFailure.toolCall('write', { path: selectionTarget }),
    undefined,
  );
  assert.equal(
    await selectionFailure.toolResult('call-1', 'write', [
      { type: 'text', text: 'unchanged' },
    ]),
    undefined,
  );
  assert.deepEqual(
    await selectionFailure.toolCall('bash', { command: 'rm -rf / SECRET' }),
    { block: true, reason: WORKFLOW_SHELL_DENIED },
  );

  const selectionEntries = selectionFailure.entries();
  assert.equal(selectionEntries.length, 2);
  assert.deepEqual(selectionEntries[0]?.action, {
    tool: 'write',
    operation: 'file_write',
    target: selectionTarget,
  });
  assert.equal(
    (selectionEntries[1]?.action as { tool?: string } | undefined)?.tool,
    'bash',
  );
});

test('requirement frames come only from user prompts and are session scoped and stale-cleared', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({ assess: matchingProvider(calls).assess });
      },
    },
  });

  const userTurn = (prompt: string) => ({
    type: 'before_agent_start',
    messageType: 'user',
    prompt,
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  // Tool results are not a capture channel either.
  assert.equal(
    await hook.toolResult('call-none', 'bash', [
      { type: 'text', text: 'TOOL_RESULT_SECRET' },
    ]),
    undefined,
  );

  // Custom-message runs never create a requirement frame.
  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'custom',
    message: { customType: 'x', content: 'CUSTOM_SECRET' },
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });
  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 0);

  // A real user prompt captures the frame for that session only.
  await hook.beforeAgentStart(userTurn('run git status'));
  assert.equal(await hook.toolCall('bash', { command: 'git status' }), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.requirement.text, 'run git status');

  hook.setSessionId('session-other');
  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 1);

  // A genuinely new session start clears that session's frame.
  hook.setSessionId('session-test');
  await hook.sessionStart('new');
  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 1);

  // An invalid/oversized turn clears the old frame instead of reusing it.
  await hook.beforeAgentStart(userTurn('x'.repeat(5_000)));
  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 1);

  // A later valid user turn captures again.
  await hook.beforeAgentStart(userTurn('run git status safely'));
  assert.equal(await hook.toolCall('bash', { command: 'git status' }), undefined);
  assert.equal(calls.length, 2);
});

test('model action match preserves baseline allow and audits only safe metadata', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({ assess: matchingProvider(calls).assess });
      },
    },
  });

  const prompt = 'please run git status SCOPE_SECRET';
  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt,
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  const command = 'git status';
  assert.equal(await hook.toolCall('bash', { command }), undefined);
  assert.equal(hook.confirmCalls.length, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.action, {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  });
  assert.deepEqual(calls[0]?.context, {
    assessment: { kind: 'plan', reason: 'safe_workflow_command' },
    operation: { program: 'unknown', effect: 'unknown' },
    operations: [],
  });
  assert.equal(calls[0]?.input.requirement.text, prompt);

  const digest = requirementFrameDigest(calls[0]!.input.requirement);
  const audits = assessmentRecords(hook.entries());
  assert.equal(audits.length, 1);
  const audit = audits[0]!;
  assert.equal(audit.kind, 'jev_assessment');
  assert.equal(audit.deterministic_verdict, 'allow');
  assert.equal(audit.final_verdict, 'allow');
  assert.equal(audit.requirementMatch, 'match');
  assert.equal(audit.model, 'test-model');
  assert.deepEqual(audit.requirement, {
    frame_digest: digest,
    source: 'user_message',
    actor: 'user',
    root_frame_id: calls[0]!.input.requirement.root_frame_id,
  });

  const raw = hook.rawLog();
  assert.equal(raw.includes(command), false);
  assert.equal(raw.includes(prompt), false);
  assert.equal(raw.includes('SCOPE_SECRET'), false);
});

test('compound command assessment sends every bounded operation descriptor without targets or arguments', async (t) => {
  const calls: AssessmentCall[] = [];
  const compound: ShellAssessment = {
    kind: 'plan',
    verdict: 'confirm',
    reason: 'network_access',
    operations: [
      {
        program: 'git',
        effect: 'read',
        targets: [],
        verdict: 'allow',
        reason: 'safe_workflow_command',
      },
      {
        program: 'curl',
        effect: 'network',
        targets: ['/tmp/OPAQUE_TARGET'],
        verdict: 'confirm',
        reason: 'network_access',
      },
    ],
  };

  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      assessShellCommand() {
        return compound;
      },
      loadJevConfig() {
        return fakeJevConfig({ assess: matchingProvider(calls).assess });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'inspect then fetch',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  const command = 'git status && curl ARG_SECRET /tmp/OPAQUE_TARGET';
  assert.deepEqual(await hook.toolCall('bash', { command }), {
    block: true,
    reason: WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  });
  assert.equal(calls.length, 1);

  const context = calls[0]!.context;
  assert.deepEqual(context.operations, [
    {
      program: 'git',
      effect: 'read',
      reason: 'safe_workflow_command',
    },
    {
      program: 'curl',
      effect: 'network',
      reason: 'network_access',
    },
  ]);
  // The summary remains the strictest bounded operation.
  assert.deepEqual(context.operation, {
    program: 'curl',
    effect: 'network',
  });

  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('ARG_SECRET'), false);
  assert.equal(serialized.includes('/tmp/OPAQUE_TARGET'), false);
  assert.equal(serialized.includes(command), false);
});

test('requirement mismatch denies even when the deterministic verdict allows', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assess: matchingProvider(calls, { requirementMatch: 'mismatch' }).assess,
        });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'only inspect the repository',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 1);
  const audit = assessmentRecords(hook.entries())[0];
  assert.equal(audit?.deterministic_verdict, 'allow');
  assert.equal(audit?.final_verdict, 'deny');
  assert.equal(audit?.requirementMatch, 'mismatch');
});

test('partial requirement match turns baseline allow into confirmation', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assess: matchingProvider(calls, { requirementMatch: 'partial' }).assess,
        });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'inspect the repository',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    assessmentRecords(hook.entries())[0]?.final_verdict,
    'confirm',
  );

  // With an approving UI the same tightened verdict remains confirm.
  const approved = setup(t, {
    gate: actionAssessmentGate(),
    hasUI: true,
    confirm: () => true,
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assess: matchingProvider([], { requirementMatch: 'partial' }).assess,
        });
      },
    },
  });
  await approved.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'inspect the repository',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });
  assert.equal(
    await approved.toolCall('bash', { command: 'git status' }),
    undefined,
  );
  assert.equal(approved.confirmCalls.length, 1);
});

test('a matching assessment never relaxes a deterministic confirm', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      assessShellCommand() {
        return planConfirmAssessment();
      },
      loadJevConfig() {
        return fakeJevConfig({ assess: matchingProvider(calls).assess });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'fetch the project page',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  assert.deepEqual(await hook.toolCall('bash', { command: 'curl example.com' }), {
    block: true,
    reason: WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  });
  assert.equal(calls.length, 1);
  const audit = assessmentRecords(hook.entries())[0];
  assert.equal(audit?.deterministic_verdict, 'confirm');
  assert.equal(audit?.final_verdict, 'confirm');
  assert.equal(audit?.requirementMatch, 'match');
});

test('required assessment failures deny and optional failures keep the baseline', async (t) => {
  // Missing frame with a required assessment.
  const missing = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assess: matchingProvider([]).assess,
        });
      },
    },
  });
  assert.deepEqual(await missing.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  const missingAudit = assessmentRecords(missing.entries())[0];
  assert.equal(missingAudit?.error, 'requirement_unavailable');
  assert.equal(missingAudit?.final_verdict, 'deny');

  // Provider failure with a required assessment.
  const failed = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assess: async () => {
            throw new Error('PROVIDER_SECRET');
          },
        });
      },
    },
  });
  await failed.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'inspect the repository',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });
  assert.deepEqual(await failed.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  const failedAudit = assessmentRecords(failed.entries())[0];
  assert.equal(failedAudit?.error, 'assessment_failed');
  assert.equal(failedAudit?.final_verdict, 'deny');
  assert.equal(failed.rawLog().includes('PROVIDER_SECRET'), false);

  // Provider failure with an optional assessment preserves baseline allow.
  const optional = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({
          assessmentRequired: false,
          assess: async () => {
            throw new Error('optional failure');
          },
        });
      },
    },
  });
  await optional.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'inspect the repository',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });
  assert.equal(await optional.toolCall('bash', { command: 'git status' }), undefined);
  const optionalAudit = assessmentRecords(optional.entries())[0];
  assert.equal(optionalAudit?.error, 'assessment_failed');
  assert.equal(optionalAudit?.final_verdict, 'allow');
});

test('denied requirement egress cannot produce a successful assessment', async (t) => {
  const calls: AssessmentCall[] = [];
  const provider: AssessmentProvider = {
    async assess(action, context, input) {
      calls.push({ action, context, input });
      if (input.requirement.egress !== 'allowed') {
        // Mirrors the real provider's egress enforcement.
        throw new Error('egress_denied');
      }
      return factsFor(input.requirement);
    },
  };
  const hook = setup(t, {
    gate: actionAssessmentGate('denied'),
    deps: {
      loadJevConfig() {
        return fakeJevConfig({ assess: provider.assess, assessmentRequired: true });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'REQUIREMENT_EGRESS_SECRET',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.requirement.egress, 'denied');
  const audit = assessmentRecords(hook.entries())[0];
  assert.equal(audit?.error, 'assessment_failed');
  assert.equal(audit?.final_verdict, 'deny');
  assert.equal(hook.rawLog().includes('REQUIREMENT_EGRESS_SECRET'), false);
});

test('a model tool call cannot use the direct-user literal grant path', async (t) => {
  const hook = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: true,
      completionReview: false,
    },
    hasUI: true,
    confirm: () => true,
    deps: {
      assessShellCommand() {
        return planConfirmAssessment();
      },
    },
  });

  const command = 'echo hi > /tmp/outside';
  assert.equal(await hook.toolCall('bash', { command }), undefined);
  assert.equal(hook.confirmCalls.length, 1);

  // The same command typed by the human auto-allows with no extra UI.
  assert.equal(await hook.userBash(command), undefined);
  assert.equal(hook.confirmCalls.length, 1);
});

test('a failed direct literal capture clears the previous requirement frame', async (t) => {
  const calls: AssessmentCall[] = [];
  const hook = setup(t, {
    gate: actionAssessmentGate(),
    deps: {
      assessShellCommand() {
        return allowAssessment();
      },
      loadJevConfig() {
        return fakeJevConfig({ assess: matchingProvider(calls).assess });
      },
    },
  });

  await hook.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'STALE_REQUIREMENT_SECRET',
    systemPrompt: '',
    systemPromptOptions: { sections: {} },
  });

  // Oversized direct literals cannot be captured; the old prompt must go too.
  const oversized = 'x'.repeat(5_000);
  assert.equal(await hook.userBash(oversized), undefined);

  assert.deepEqual(await hook.toolCall('bash', { command: 'git status' }), {
    block: true,
    reason: WORKFLOW_SHELL_DENIED,
  });
  assert.equal(calls.length, 0);
  const audits = assessmentRecords(hook.entries()).filter(
    (audit) => audit.kind === 'jev_assessment',
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.error, 'requirement_unavailable');
  assert.equal(hook.rawLog().includes('STALE_REQUIREMENT_SECRET'), false);
});

test('stale namespaced guidance is removed while custom sections are untouched', async (t) => {
  const disabled = setup(t, {
    gate: {
      enabled: true,
      guidance: false,
      shellGate: false,
      completionReview: false,
    },
  });

  const disabledSections: Record<string, string> = {
    [WORKFLOW_GUIDANCE_SECTION]: 'stale guidance',
    existing: 'keep this section',
  };
  await disabled.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'anything',
    systemPrompt: '',
    systemPromptOptions: { sections: disabledSections },
  });
  assert.deepEqual(disabledSections, { existing: 'keep this section' });

  // An empty selection (all useful rules already present) removes only our
  // stale section and commits nothing.
  const emptyBlock = {
    text: '',
    ruleIds: [] as string[],
    droppedRuleIds: [] as string[],
    policyVersion: '1.0.0',
    advisoryDigest: 'digest',
    channel: 'prompt' as const,
    area: null,
  };
  const emptySession: InjectorSession = {
    selectPrompt() {
      return emptyBlock;
    },
    queueAction() {
      return false;
    },
    selectPendingArea() {
      return null;
    },
    commit() {
      assert.fail('an empty selection must not commit');
    },
  };
  const empty = setup(t, {
    gate: {
      enabled: true,
      guidance: true,
      shellGate: false,
      completionReview: false,
    },
    deps: {
      createSession() {
        return emptySession;
      },
    },
  });

  const emptySections: Record<string, string> = {
    [WORKFLOW_GUIDANCE_SECTION]: 'stale guidance',
    existing: 'keep this section',
  };
  await empty.beforeAgentStart({
    type: 'before_agent_start',
    messageType: 'user',
    prompt: 'anything',
    systemPrompt: '',
    systemPromptOptions: { sections: emptySections },
  });
  assert.deepEqual(emptySections, { existing: 'keep this section' });
});
