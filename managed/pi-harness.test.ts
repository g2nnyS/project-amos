import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';

import { createProjectActivationCompiler } from '../activation/compiler.ts';
import {
  entry,
  options as compilerOptions,
  project as projectInput,
} from '../activation/test-support.ts';
import type { VersionedRule } from '../activation/types.ts';
import {
  localReviewFacts,
  type LocalReviewPolicy,
} from '../review/local-provider.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');
const ADAPTER = join(ROOT, 'dist', 'adapters', 'pi', 'index.js');
const KEY_ENV = 'AMOS_PI_HARNESS_TEST_KEY';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly auditDir: string;
  readonly managedAudit: string;
  readonly faux: ReturnType<typeof createFauxCore>;
}

interface ManagedReviewConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly policy: Record<string, unknown>;
  readonly calibration: Record<string, unknown>;
  readonly ceilingDigest: string;
}

function digest(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function rule(
  id: string,
  onHit: 'deny' | 'confirm' | 'log',
  target: string,
): VersionedRule {
  return entry(id, {
    level: 1,
    on_hit: onHit,
    predicate: [
      { op: 'op_in', args: { operations: ['file_write'] } },
      {
        op: 'target_glob',
        args: { patterns: [`\${SESSION_WORKSPACE}/${target}`] },
      },
    ],
  });
}

function createFixture(
  rules: readonly VersionedRule[],
  options: {
    readonly review?: ManagedReviewConfig | null;
    readonly auditInsideWorkspace?: boolean;
    readonly malformedManaged?: boolean;
  } = {},
): Fixture {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync(join('/tmp/opencode', 'amos-pi-harness-'));
  roots.push(root);
  const project = realpathSync(root);
  const workspace = join(project, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, '.pi', 'extensions'), { recursive: true });
  const auditDir = join(project, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const agentDir = join(project, 'agent');
  mkdirSync(agentDir, { recursive: true });

  const base = compilerOptions();
  const compiler = createProjectActivationCompiler({
    ...base,
    rules: [...base.rules, ...rules],
  });
  const snapshot = compiler.compile(
    projectInput({
      projectId: 'harness-project',
      workspace,
      selectedRuleRefs: rules.map(({ id, version }) => ({ id, version })),
    }),
  );
  writeFileSync(
    join(workspace, '.pi', 'activation.json'),
    JSON.stringify(snapshot),
    'utf8',
  );
  writeFileSync(
    join(workspace, '.pi', 'extensions', 'amos.js'),
    `export { default } from ${JSON.stringify(ADAPTER)};\n`,
    'utf8',
  );

  const managedAudit = join(auditDir, 'managed.jsonl');
  const config: Record<string, unknown> = {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(auditDir, 'shadow.jsonl'),
    activation: { snapshotPath: '.pi/activation.json', projectId: 'harness-project' },
    managed: options.malformedManaged
      ? { enabled: 'yes', auditPath: 42 }
      : {
          enabled: true,
          auditPath: options.auditInsideWorkspace
            ? join(workspace, 'managed.jsonl')
            : managedAudit,
          ...(options.review === undefined || options.review === null
            ? {}
            : { review: options.review }),
        },
  };
  writeFileSync(
    join(workspace, '.pi', 'amos.json'),
    JSON.stringify(config),
    'utf8',
  );

  return {
    root: project,
    project: workspace,
    auditDir,
    managedAudit,
    faux: createFauxCore({}),
  };
}

async function runPrompt(
  fixture: Fixture,
  prompt: string,
  responses: readonly unknown[],
): Promise<{
  readonly session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  readonly systemSections: Record<string, string>;
}> {
  const agentDir = join(fixture.root, 'agent');
  const model = fixture.faux.models[0];
  const settings = SettingsManager.create(fixture.project, agentDir);
  const created = await createAgentSession({
    cwd: fixture.project,
    agentDir,
    model,
    sessionManager: SessionManager.inMemory(fixture.project),
    settingsManager: settings,
    tools: ['write'],
  });
  const session = created.session;
  session.agent.streamFunction = fixture.faux.streamSimple as never;
  const runtime = session.modelRuntime as unknown as {
    hasConfiguredAuth: () => boolean;
    checkAuth: () => Promise<unknown>;
    isUsingOAuth: () => boolean;
  };
  runtime.hasConfiguredAuth = () => true;
  runtime.checkAuth = async () => ({ type: 'api_key' });
  runtime.isUsingOAuth = () => false;
  fixture.faux.setResponses(responses as never);
  await session.prompt(prompt);
  const system = session.agent.state.messages[0] as unknown as {
    sections?: Record<string, string>;
  };
  return { session, systemSections: system.sections ?? {} };
}

function runtimeReport(fixture: Fixture): Record<string, unknown> | null {
  const path = join(fixture.project, '.pi', 'runtime.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function journal(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolResult(session: unknown): Record<string, unknown> {
  const messages = (
    session as {
      agent: { state: { messages: Array<Record<string, unknown>> } };
    }
  ).agent.state.messages;
  const result = messages.find((message) => message.role === 'toolResult');
  assert.ok(result, 'expected a real harness toolResult');
  return result;
}

async function reviewerServer(
  policy: LocalReviewPolicy,
): Promise<{
  readonly endpoint: string;
  readonly requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.setHeader('content-type', 'application/json');
    try {
      const parsed = JSON.parse(body) as {
        projection: Parameters<typeof localReviewFacts>[1];
      };
      res.end(JSON.stringify(localReviewFacts(policy, parsed.projection)));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'invalid_projection' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/review`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function localPolicy(allowedTargets: readonly string[]): LocalReviewPolicy {
  return {
    allowedTools: ['write'],
    allowedOperations: ['file_write'],
    allowedTargets,
    deniedTargets: [],
    risk: 0.1,
    confidence: 0.9,
  };
}

function reviewConfig(endpoint: string): ManagedReviewConfig {
  const now = Date.now();
  const policyDigest = digest('d');
  return {
    endpoint,
    model: 'local-reviewer',
    apiKeyEnv: KEY_ENV,
    policy: {
      id: 'policy_1',
      model: 'local-reviewer',
      questionVersion: 'questions/v1',
      minConfidence: 0.7,
      maxRisk: 0.5,
      timeoutMs: 2_000,
      maxAttempts: 1,
      requirementEgress: 'denied',
      targetEgress: 'workspace-relative',
      minimumCases: 2,
      maximumFalseAllowRate: 0,
      expiresAt: now + 3_600_000,
      policyDigest,
    },
    calibration: {
      format: 'amos-review-calibration',
      version: 1,
      model: 'local-reviewer',
      questionVersion: 'questions/v1',
      policyDigest,
      caseSetDigest: digest('f'),
      cases: 10,
      unsafeCases: 4,
      falseAllows: 0,
      evaluatedAt: now - 1_000,
      expiresAt: now + 3_600_000,
    },
    ceilingDigest: digest('e'),
  };
}

function writeCall(fixture: Fixture, name: string, content: string) {
  return fauxAssistantMessage([
    fauxToolCall('write', {
      path: join(fixture.project, 'src', name),
      content,
    }),
  ]);
}

describe('real Pi harness managed interception', () => {
  it('blocks a deterministic deny before the real write tool runs', async () => {
    const fixture = createFixture([rule('deny-write', 'deny', 'src/deny.ts')]);
    const { session } = await runPrompt(fixture, 'write deny', [
      writeCall(fixture, 'deny.ts', 'MUST_NOT_EXIST'),
      fauxAssistantMessage('done'),
    ]);

    assert.equal(existsSync(join(fixture.project, 'src', 'deny.ts')), false);
    const result = toolResult(session);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /amos_managed_denied/);

    const entries = journal(fixture.managedAudit);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'authorization');
    assert.equal(entries[0].decision, 'deny');
    assert.deepEqual(entries[0].matchedRuleIds, ['deny-write']);
    assert.equal(
      (entries[0].action as Record<string, unknown>).target,
      'src/deny.ts',
    );
    assert.equal(entries[1].event, 'result');
    assert.equal(entries[1].status, 'stopped');
    session.dispose();
  });

  it('allows a log rule and records the real write result', async () => {
    const fixture = createFixture([rule('log-write', 'log', 'src/allowed.ts')]);
    const { session } = await runPrompt(fixture, 'write allowed', [
      writeCall(fixture, 'allowed.ts', 'REAL_CONTENT'),
      fauxAssistantMessage('done'),
    ]);

    assert.equal(
      readFileSync(join(fixture.project, 'src', 'allowed.ts'), 'utf8'),
      'REAL_CONTENT',
    );
    const result = toolResult(session);
    assert.equal(result.isError, false);
    const entries = journal(fixture.managedAudit);
    assert.equal(entries[0].decision, 'allow');
    assert.equal(entries[1].status, 'executed');
    assert.equal(
      (entries[0].action as Record<string, unknown>).target,
      'src/allowed.ts',
    );
    session.dispose();
  });

  it('stops a confirm when no independent review channel exists', async () => {
    const fixture = createFixture([
      rule('confirm-write', 'confirm', 'src/confirm.ts'),
    ]);
    const { session } = await runPrompt(fixture, 'write confirm', [
      writeCall(fixture, 'confirm.ts', 'MUST_NOT_EXIST'),
      fauxAssistantMessage('done'),
    ]);

    assert.equal(existsSync(join(fixture.project, 'src', 'confirm.ts')), false);
    const result = toolResult(session);
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /amos_managed_review_unavailable/,
    );
    const entries = journal(fixture.managedAudit);
    assert.equal(entries[0].decision, 'confirm_required');
    assert.equal(entries[1].status, 'stopped');
    session.dispose();
  });

  it('reviews through real loopback HTTP and executes the approved write once', async () => {
    const reviewer = await reviewerServer(localPolicy(['src/confirm.ts']));
    const previous = process.env[KEY_ENV];
    process.env[KEY_ENV] = 'test-key';
    try {
      const fixture = createFixture(
        [rule('confirm-write', 'confirm', 'src/confirm.ts')],
        { review: reviewConfig(reviewer.endpoint) },
      );
      const { session } = await runPrompt(fixture, 'write confirm', [
        writeCall(fixture, 'confirm.ts', 'APPROVED_ONCE'),
        fauxAssistantMessage('done'),
      ]);

      assert.equal(
        readFileSync(join(fixture.project, 'src', 'confirm.ts'), 'utf8'),
        'APPROVED_ONCE',
      );
      const result = toolResult(session);
      assert.equal(result.isError, false);
      assert.equal(reviewer.requests.length, 1);
      const sent = reviewer.requests[0];
      assert.match(sent, /"target":"src\/confirm\.ts"/);
      assert.doesNotMatch(sent, /APPROVED_ONCE/);
      assert.doesNotMatch(sent, new RegExp(fixture.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(sent, /requirementText/);

      const entries = journal(fixture.managedAudit);
      assert.equal(entries[0].decision, 'allow');
      assert.equal(
        (entries[0].matchedRuleIds as readonly string[])[0],
        'confirm-write',
      );
      assert.equal(entries[1].status, 'executed');
      assert.equal(
        entries.filter((entry) => entry.event === 'authorization').length,
        1,
      );
      session.dispose();
    } finally {
      if (previous === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = previous;
      await reviewer.close();
    }
  });

  it('blocks when the independent reviewer returns mismatch', async () => {
    const reviewer = await reviewerServer(localPolicy(['src/other.ts']));
    const previous = process.env[KEY_ENV];
    process.env[KEY_ENV] = 'test-key';
    try {
      const fixture = createFixture(
        [rule('confirm-write', 'confirm', 'src/confirm.ts')],
        { review: reviewConfig(reviewer.endpoint) },
      );
      const { session } = await runPrompt(fixture, 'write confirm', [
        writeCall(fixture, 'confirm.ts', 'MUST_NOT_EXIST'),
        fauxAssistantMessage('done'),
      ]);

      assert.equal(existsSync(join(fixture.project, 'src', 'confirm.ts')), false);
      const result = toolResult(session);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /amos_managed_review_denied/);
      const entries = journal(fixture.managedAudit);
      assert.equal(entries[0].decision, 'confirm_required');
      assert.equal(entries[1].status, 'stopped');
      session.dispose();
    } finally {
      if (previous === undefined) delete process.env[KEY_ENV];
      else process.env[KEY_ENV] = previous;
      await reviewer.close();
    }
  });

  it('injects only the active activation narrative into the real system prompt', async () => {
    const fixture = createFixture([rule('ts-advice', 'log', 'src/*.ts')]);
    const { session, systemSections } = await runPrompt(
      fixture,
      'please work on typescript',
      [fauxAssistantMessage('ok')],
    );
    const guidance = systemSections['amos-workflow-guidance'];
    assert.ok(guidance, 'expected the managed activation advisory section');
    assert.match(guidance, /amos-guidance/);
    assert.match(guidance, /ts-advice/);
    assert.doesNotMatch(guidance, /python/);
    const report = runtimeReport(fixture);
    assert.ok(report, 'expected the real harness runtime report');
    assert.equal(report.format, 'amos-harness-runtime');
    assert.equal(report.projectId, 'harness-project');
    assert.equal(report.policyVersion, 'policy-1');
    assert.equal(report.mode, 'enforcing');
    assert.match(String(report.activationDigest), /^sha256:[a-f0-9]{64}$/);
    // The injected section and the runtime report must name the same snapshot.
    assert.ok(guidance.includes(String(report.activationDigest)));
    assert.deepEqual(report.capabilities, {
      enforcedTools: ['read', 'write', 'edit', 'ls', 'find', 'grep'],
      blockedUnsupportedTools: ['bash', 'powershell', 'custom'],
      preCallStop: true,
      injection: 'system-prompt-and-tool-result',
      singleUseReview: true,
    });
    session.dispose();
  });

  it('fails closed when the managed audit path is inside the workspace', async () => {
    const fixture = createFixture(
      [rule('log-write', 'log', 'src/allowed.ts')],
      { auditInsideWorkspace: true },
    );
    const { session } = await runPrompt(fixture, 'write allowed', [
      writeCall(fixture, 'allowed.ts', 'MUST_NOT_EXIST'),
      fauxAssistantMessage('done'),
    ]);
    assert.equal(existsSync(join(fixture.project, 'src', 'allowed.ts')), false);
    const result = toolResult(session);
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /amos_managed_config_error/,
    );
    session.dispose();
  });
});
