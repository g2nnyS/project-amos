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
import type {
  GuidanceInput,
  GuidancePack,
  GuidanceSelection,
} from '../../guidance/types.ts';
import { renderGuidance } from '../../guidance/render.ts';
import { selectGuidance } from '../../guidance/select.ts';
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

function fakeJevConfig(): LoadedJevConfig {
  return {
    config: {
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      defaultModel: 'test-model',
      models: ['test-model'],
      timeoutMs: 1_000,
      assessmentRequired: true,
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
      async assess() {
        throw new Error('unexpected assessment');
      },
    },
  } as unknown as LoadedJevConfig;
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

  const guidanceInputs: Array<GuidanceInput | null | undefined> = [];
  const renderCalls: Array<readonly GuidancePack[]> = [];
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
    selectGuidance(input) {
      guidanceInputs.push(input);
      return selectGuidance(input);
    },
    renderGuidance(packs) {
      renderCalls.push(packs);
      return renderGuidance(packs);
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
        return 'session-test';
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
    guidanceInputs,
    renderCalls,
    shellAssessments,
    changeReviewCalls,
    jevLoads,
    engineeringCalls,
    confirmCalls,
    async beforeAgentStart(event: Record<string, unknown>): Promise<unknown> {
      return await handler('before_agent_start')(event, ctx);
    },
    async toolCall(toolName: string, input: unknown): Promise<unknown> {
      return await handler('tool_call')(
        {
          type: 'tool_call',
          toolCallId: 'call-1',
          toolName,
          input,
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
  assert.equal(guidance?.includes(rawPrompt), false);
  assert.equal(guidance?.includes('RAW_PROMPT_SECRET_7f3c'), false);
  assert.deepEqual(hook.guidanceInputs, [{ prompt: rawPrompt }]);
  assert.equal(hook.renderCalls.length, 1);

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
  assert.equal(hook.guidanceInputs.length, 1);
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

test('dangerous user_bash throws a fixed code and may pass only with UI approval', async (t) => {
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

  const noUiConfirm = setup(t, {
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
  await assert.rejects(
    () => noUiConfirm.userBash(command),
    (error: unknown) =>
      error instanceof Error &&
      error.message === WORKFLOW_SHELL_CONFIRMATION_REQUIRED,
  );
  assert.equal(noUiConfirm.rawLog().includes(command), false);

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
  assert.equal(await approved.userBash(command), undefined);
  assert.equal(approved.confirmCalls[0]?.message.includes(command), true);
  assert.equal(approved.rawLog().includes(command), false);
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
