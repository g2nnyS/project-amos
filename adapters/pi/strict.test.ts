import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';

import { compileAdvisorySnapshot } from '../../injector/index.ts';
import type { AdvisorySnapshot } from '../../injector/index.ts';
import { rule, snapshotInput } from '../../injector/test-support.ts';
import {
  assertExactToolSurface,
  createStrictPiSession,
} from './strict.ts';

type FakeToolCall = {
  readonly type: 'toolCall';
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

type FakeText = { readonly type: 'text'; readonly text: string };
type FakeContent = FakeToolCall | FakeText;
type FakeStopReason = 'stop' | 'toolUse' | 'aborted';

interface FakeAssistantMessage {
  readonly role: 'assistant';
  readonly content: FakeContent[];
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
    readonly cost: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    };
  };
  readonly stopReason: FakeStopReason;
  readonly timestamp: number;
}

interface FakeRequest {
  readonly context: unknown;
  readonly options: unknown;
}

interface HangStep {
  readonly hang: true;
}

type FakeStep = FakeAssistantMessage | HangStep;

function hang(): HangStep {
  return { hang: true };
}

function isHang(step: FakeStep): step is HangStep {
  return 'hang' in step;
}

function readAbortSignal(options: unknown): AbortSignal | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  const signal = options.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Wait for the host abort signal, with a deterministic test fallback. */
function waitForAbort(
  signal: AbortSignal | undefined,
  fallbackMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', done);
      resolve();
    };
    signal?.addEventListener('abort', done, { once: true });
    timer = setTimeout(done, fallbackMs);
    timer.unref?.();
  });
}

function call(
  name: string,
  args: Record<string, unknown>,
  id: string,
): FakeToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

function text(value: string): FakeText {
  return { type: 'text', text: value };
}

function assistant(
  content: FakeContent[],
  stopReason: FakeStopReason = 'stop',
): FakeAssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'fake-api',
    provider: 'fake',
    model: 'fake-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function fakeStream(message: FakeAssistantMessage): unknown {
  const events = [
    { type: 'start', partial: message },
    { type: 'done', reason: message.stopReason, message },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return message;
    },
  };
}

/**
 * Narrow structural fake of the trusted model transport. It implements only
 * the members the SDK touches on this path, and each request's scripted turn
 * is consumed once so a looping agent run fails deterministically instead of
 * hanging. This is a test-only cast; production never uses it.
 */
class ScriptedTransport {
  readonly requests: FakeRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[]) {
    this.steps = [...steps];
  }

  hasConfiguredAuth(): boolean {
    return true;
  }

  isUsingOAuth(): boolean {
    return false;
  }

  getModel(): unknown {
    return FAKE_MODEL;
  }

  getModels(): unknown[] {
    return [FAKE_MODEL];
  }

  getModelOfType(): undefined {
    return undefined;
  }

  getModelsOfType(): unknown[] {
    return [];
  }

  streamSimple(
    _model: unknown,
    context: unknown,
    options?: unknown,
  ): unknown {
    this.requests.push({ context, options });
    const signal = readAbortSignal(options);
    if (signal?.aborted === true) {
      // A real provider would abort; keep the scripted queue untouched so the
      // test observes that no further tool dispatch occurred.
      return fakeStream(assistant([], 'aborted'));
    }
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error('fake transport exhausted');
    }
    if (isHang(step)) {
      const final = assistant([text('aborted by host')]);
      return {
        async *[Symbol.asyncIterator]() {
          await waitForAbort(signal, 2_000);
          yield { type: 'start', partial: final };
          yield { type: 'done', reason: 'stop', message: final };
        },
        async result() {
          return final;
        },
      };
    }
    return fakeStream(step);
  }
}

/**
 * A valid engine table whose only rule can never match `/workspace/...`, so
 * the deterministic default (`allow`) applies to every dispatched tool.
 */
const ALLOW_POLICY: readonly Record<string, unknown>[] = [
  {
    id: 'never-match',
    dimension: 'test',
    level: 0,
    expressivity: 'deterministic',
    predicate: [{ op: 'target_glob', args: { patterns: ['/never/**'] } }],
    narrative: 'Never matches the virtual workspace.',
    probe: 'test-probe',
    on_hit: 'deny',
    scope: 'project',
    owner: 'human',
    ttl: null,
    source: {
      repo: 'test',
      rev: 'test',
      path: 'test',
      section: 'test',
      lines: '1',
      quote: 'test',
    },
    policy_class: 'engineering',
    enforcement: 'runtime',
  },
];

const FAKE_MODEL = {
  id: 'fake-model',
  name: 'Fake Model',
  api: 'fake-api',
  provider: 'fake',
  baseUrl: 'http://127.0.0.1:9',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as unknown as CreateAgentSessionOptions['model'];

function modelRuntime(
  transport: ScriptedTransport,
): CreateAgentSessionOptions['modelRuntime'] {
  return transport as unknown as CreateAgentSessionOptions['modelRuntime'];
}

function workspace(t: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), 'amos-pi-strict-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive substring search for structural assertions without a fixed shape. */
function contains(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => contains(entry, needle, seen));
  }
  return Object.values(value).some((entry) => contains(entry, needle, seen));
}

function contextMessages(context: unknown): unknown[] {
  if (isRecord(context) && Array.isArray(context.messages)) {
    return context.messages;
  }
  return [];
}

function toolResultMessages(context: unknown): unknown[] {
  return contextMessages(context).filter(
    (message) => isRecord(message) && message.role === 'toolResult',
  );
}

function firstRequest(transport: ScriptedTransport): FakeRequest {
  const request = transport.requests[0];
  assert.ok(request !== undefined, 'expected at least one model request');
  return request;
}

function secondRequest(transport: ScriptedTransport): FakeRequest {
  const request = transport.requests[1];
  assert.ok(request !== undefined, 'expected a follow-up model request');
  return request;
}

function hostileWorkspace(directory: string): void {
  writeFileSync(
    join(directory, 'AGENTS.md'),
    'HOSTILE-AGENT-CONTEXT-CANARY',
    'utf8',
  );
  writeFileSync(
    join(directory, 'CLAUDE.md'),
    'HOSTILE-CLAUDE-CONTEXT-CANARY',
    'utf8',
  );
  writeFileSync(
    join(directory, 'opencode.jsonc'),
    '{ "hostile": "HOSTILE-OPENCODE-CANARY" }',
    'utf8',
  );
  writeFileSync(join(directory, '.mcp.json'), 'HOSTILE-MCP-CANARY', 'utf8');
  mkdirSync(join(directory, '.pi'), { recursive: true });
  writeFileSync(
    join(directory, '.pi', 'amos.json'),
    JSON.stringify({ mode: 'strict', hostile: 'HOSTILE-PI-CANARY' }),
    'utf8',
  );
}

test('exact surface validator rejects native, MCP, and non-direct tools', async (t) => {
  const sdkTool = (name: string) => ({
    name,
    exposure: 'direct' as const,
    source: 'sdk' as const,
  });

  assert.doesNotThrow(() =>
    assertExactToolSurface(['amos_read'], {
      active: ['amos_read'],
      callable: ['amos_read'],
      registered: [sdkTool('amos_read')],
    }),
  );

  // A real native tool that escaped the allowlist is rejected, not merely
  // hidden from the model declaration.
  assert.throws(
    () =>
      assertExactToolSurface(['amos_read'], {
        active: ['amos_read', 'bash'],
        callable: ['amos_read', 'bash'],
        registered: [sdkTool('amos_read'), sdkTool('bash')],
      }),
    /strict_tool_registry_unavailable/,
  );

  assert.throws(
    () =>
      assertExactToolSurface(['amos_read'], {
        active: ['amos_read'],
        callable: ['amos_read', 'codemode'],
        registered: [
          sdkTool('amos_read'),
          { name: 'codemode', exposure: 'codemode', source: 'sdk' },
        ],
      }),
    /strict_tool_registry_unavailable/,
  );

  assert.throws(
    () =>
      assertExactToolSurface(['amos_read'], {
        active: ['amos_read'],
        callable: ['amos_read'],
        registered: [
          {
            name: 'amos_read',
            exposure: 'direct',
            source: 'sdk',
            namespace: { name: 'mcp__hostile' },
          },
        ],
      }),
    /strict_tool_registry_unavailable/,
  );

  // The real SDK session with only the declared custom tool passes creation
  // and the pre-prompt validator.
  const directory = workspace(t);
  const transport = new ScriptedTransport([assistant([text('ok')])]);
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-surface',
    files: {},
    tools: ['read'],
    policy: ALLOW_POLICY,
    audit: () => {},
  });
  assert.equal(await host.prompt('hello'), 'ok');
  await host.stop();
});

test('Pi SDK host wires only allowlisted amos tools to the in-memory dispatcher', async (t) => {
  const directory = workspace(t);
  hostileWorkspace(directory);
  writeFileSync(join(directory, 'disk-sentinel.txt'), 'DISK-UNCHANGED', 'utf8');

  const transport = new ScriptedTransport([
    assistant(
      [
        call('amos_read', { path: 'disk-sentinel.txt' }, 'call-read'),
        call(
          'amos_write',
          { path: 'notes/a.txt', content: 'updated' },
          'call-write',
        ),
      ],
      'toolUse',
    ),
    assistant([text('finished')]),
  ]);

  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-integration',
    files: {
      'disk-sentinel.txt': 'MEMORY-ONLY',
      'notes/a.txt': 'initial',
    },
    tools: ['read', 'write'],
    policy: ALLOW_POLICY,
    audit: (event) => {
      audit.push(event);
    },
  });

  const answer = await host.prompt('please update notes');
  assert.equal(answer, 'finished');

  // The real workspace is a hostile, separate tree and must stay untouched.
  assert.equal(
    readFileSync(join(directory, 'disk-sentinel.txt'), 'utf8'),
    'DISK-UNCHANGED',
  );

  // The first request declares only our custom tool names. No builtin bash,
  // write, edit, read, or MCP tool can be called by name.
  const declared = JSON.stringify(firstRequest(transport).context);
  assert.match(declared, /"name":"amos_read"/);
  assert.match(declared, /"name":"amos_write"/);
  assert.doesNotMatch(declared, /"name":"bash"/);
  assert.doesNotMatch(declared, /"name":"write"/);
  assert.doesNotMatch(declared, /mcp__/);

  // The read was served from the in-memory map, not from disk.
  const followUp = JSON.stringify(toolResultMessages(secondRequest(transport).context));
  assert.match(followUp, /MEMORY-ONLY/);
  assert.doesNotMatch(followUp, /DISK-UNCHANGED/);

  // Staged changes are in memory only.
  const changes = JSON.stringify(host.changes());
  assert.match(changes, /notes\/a\.txt/);
  assert.match(changes, /updated/);

  // No hostile project resource was discovered or injected.
  for (const canary of [
    'HOSTILE-AGENT-CONTEXT-CANARY',
    'HOSTILE-CLAUDE-CONTEXT-CANARY',
    'HOSTILE-OPENCODE-CANARY',
    'HOSTILE-MCP-CANARY',
    'HOSTILE-PI-CANARY',
  ]) {
    assert.equal(contains(transport.requests, canary), false, canary);
  }

  await host.stop();
  assert.equal(typeof host.policyDigest, 'string');
});

test('denied builtin, MCP, protected, and traversal calls never stage or leak', async (t) => {
  const directory = workspace(t);
  writeFileSync(join(directory, 'disk-sentinel.txt'), 'DISK-UNCHANGED', 'utf8');

  const transport = new ScriptedTransport([
    assistant(
      [
        call('bash', { command: 'touch pwned' }, 'call-bash'),
        call('mcp__hostile__tool', { input: 'x' }, 'call-mcp'),
        call(
          'amos_write',
          { path: 'policy.json', content: 'LEAK-CANARY' },
          'call-policy',
        ),
        call(
          'amos_write',
          { path: `../escape-${process.pid}.txt`, content: 'LEAK-CANARY' },
          'call-traversal',
        ),
        call('amos_delete', { path: 'notes/a.txt' }, 'call-delete'),
      ],
      'toolUse',
    ),
    assistant([text('finished')]),
  ]);

  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-denials',
    files: { 'notes/a.txt': 'keep' },
    tools: ['read', 'write'],
    policy: ALLOW_POLICY,
    protectedPaths: ['policy.json'],
    audit: (event) => {
      audit.push(event);
    },
  });

  const answer = await host.prompt('try forbidden operations');
  assert.equal(answer, 'finished');

  const toolResults = toolResultMessages(
    secondRequest(transport).context,
  ).filter(isRecord);
  const resultFor = (toolName: string): Record<string, unknown> | undefined =>
    toolResults.find((message) => message.toolName === toolName);

  // Unregistered native and MCP names are rejected by Pi itself as unknown
  // tools. This is intentionally not reported as a strict-dispatcher denial.
  for (const toolName of ['bash', 'mcp__hostile__tool', 'amos_delete']) {
    const result = resultFor(toolName);
    assert.ok(result !== undefined, toolName);
    assert.match(JSON.stringify(result), /not found/i, toolName);
  }
  assert.match(
    JSON.stringify(resultFor('amos_write')),
    /protected_path|invalid_request/,
  );

  assert.equal(host.changes().length, 0);
  assert.equal(
    readFileSync(join(directory, 'disk-sentinel.txt'), 'utf8'),
    'DISK-UNCHANGED',
  );
  // The core never touches the host filesystem, so traversal cannot create a
  // file next to the workspace either.
  assert.equal(
    (() => {
      try {
        readFileSync(join(directory, '..', `escape-${process.pid}.txt`), 'utf8');
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );

  // Denied tool results carry fixed error text, never the submitted content.
  const deniedResults = JSON.stringify(
    toolResultMessages(secondRequest(transport).context),
  );
  assert.doesNotMatch(deniedResults, /LEAK-CANARY/);
  assert.match(deniedResults, /strict_denied|denied/);

  // The audit trail records the denial but not the raw denied content.
  assert.equal(contains(audit, 'LEAK-CANARY'), false);
  assert.equal(audit.length, 2);
  for (const event of audit) {
    assert.equal(isRecord(event) ? event.tool : undefined, 'write');
  }

  await host.stop();
});

test('facade is frozen and exposes no raw session or bypass methods', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([assistant([text('done')])]);
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-facade',
    files: {},
    tools: [],
    policy: ALLOW_POLICY,
    audit: () => {},
  });

  assert.deepEqual(Object.keys(host).sort(), [
    'changes',
    'policyDigest',
    'prompt',
    'stop',
  ]);
  assert.equal(Object.isFrozen(host), true);
  for (const forbidden of [
    'session',
    'agent',
    'executeBash',
    'abortBash',
    'getAllTools',
    'setActiveToolsByName',
    'resourceLoader',
    'settingsManager',
    'sessionManager',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(host, forbidden),
      false,
      forbidden,
    );
  }

  await assert.rejects(() => host.prompt('   '), /strict_invalid_prompt/);
  assert.equal(transport.requests.length, 0);

  const answer = await host.prompt('hello');
  assert.equal(answer, 'done');
  await host.stop();
  await assert.rejects(() => host.prompt('after stop'), /strict_host_stopped/);
});

test('optional advisory snapshot feeds prompt and post-write area blocks', async (t) => {
  const directory = workspace(t);
  const compiled = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({
          id: 'prompt-rule',
          narrative: 'PROMPT-ADVISORY-CANARY',
          keywords: ['engine'],
        }),
        rule({
          id: 'area-rule',
          narrative: 'AREA-ADVISORY-CANARY',
          areas: ['engine'],
          pathHints: ['engine'],
        }),
      ],
    }),
  );
  // A mutable caller copy proves the host pins its own validated snapshot.
  const provided = structuredClone(compiled);

  const transport = new ScriptedTransport([
    assistant(
      [
        call(
          'amos_write',
          { path: 'engine/file.ts', content: 'x' },
          'call-write',
        ),
      ],
      'toolUse',
    ),
    assistant([text('done')]),
  ]);

  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-advisory',
    files: { 'engine/file.ts': 'before' },
    tools: ['write'],
    policy: ALLOW_POLICY,
    audit: (event) => {
      audit.push(event);
    },
    advisorySnapshot: provided as unknown as AdvisorySnapshot,
  });

  // Mutating the caller's object after creation must not change emitted text
  // or the pinned digest.
  const mutableRules = provided.rules as unknown as Array<{
    narrative: string;
  }>;
  mutableRules[0]!.narrative = 'MUTATED-PROMPT-CANARY';
  mutableRules[1]!.narrative = 'MUTATED-AREA-CANARY';

  assert.equal(await host.prompt('engine guidance'), 'done');

  // The pinned digest is passed to the core provenance instead of a
  // caller-chosen or absent value.
  assert.ok(audit.length > 0);
  for (const event of audit) {
    assert.equal(
      isRecord(event) ? event.advisoryDigest : undefined,
      compiled.advisoryDigest,
    );
  }

  const promptRequest = JSON.stringify(firstRequest(transport).context);
  assert.match(promptRequest, /PROMPT-ADVISORY-CANARY/);
  assert.doesNotMatch(promptRequest, /MUTATED-PROMPT-CANARY/);
  assert.doesNotMatch(promptRequest, /AREA-ADVISORY-CANARY/);

  const followUp = JSON.stringify(toolResultMessages(secondRequest(transport).context));
  assert.match(followUp, /AREA-ADVISORY-CANARY/);
  assert.doesNotMatch(followUp, /MUTATED-AREA-CANARY/);

  await host.stop();
});

test('poisoned strict core aborts the run before a second model request', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([
    assistant(
      [
        call(
          'amos_write',
          { path: 'poison.txt', content: 'x' },
          'call-write',
        ),
      ],
      'toolUse',
    ),
    assistant([text('must not be requested')]),
  ]);
  let auditCalls = 0;
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-poisoned-audit',
    files: {},
    tools: ['write'],
    policy: ALLOW_POLICY,
    audit: () => {
      auditCalls += 1;
      throw new Error('audit sink unavailable');
    },
    promptTimeoutMs: 1_000,
  });

  await assert.rejects(
    () => host.prompt('write once'),
    /strict_audit_unavailable/,
  );
  assert.equal(auditCalls, 1);
  assert.equal(transport.requests.length, 1);
  assert.equal(host.changes().length, 0);
  await assert.rejects(() => host.prompt('again'), /strict_host_stopped/);
  await host.stop();
});

test('prompt returns only this run and rejects after an explicit stop', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([
    assistant([text('A')]),
    assistant([]),
    hang(),
  ]);
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-run-boundary',
    files: {},
    tools: [],
    policy: ALLOW_POLICY,
    audit: () => {},
    promptTimeoutMs: 1_000,
  });

  assert.equal(await host.prompt('first'), 'A');
  // An empty completed response from the next run must not fall back to A.
  assert.equal(await host.prompt('second'), '');

  const pending = host.prompt('wait');
  const rejected = assert.rejects(pending, /strict_host_stopped/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await host.stop();
  await rejected;
});

test('extra model input fields are rejected instead of stripped', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([
    assistant(
      [
        call(
          'amos_write',
          {
            path: 'safe.txt',
            content: 'x',
            sessionId: 'spoofed-session',
            approval: true,
            area: 'engine',
            policy: 'allow',
          },
          'call-spoof',
        ),
      ],
      'toolUse',
    ),
    assistant([text('finished')]),
  ]);
  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-spoof-input',
    files: {},
    tools: ['write'],
    policy: ALLOW_POLICY,
    audit: (event) => {
      audit.push(event);
    },
    promptTimeoutMs: 1_000,
  });

  assert.equal(await host.prompt('spoof'), 'finished');
  assert.equal(host.changes().length, 0);
  assert.equal(audit.length, 0);
  await host.stop();
});

test('tool-call budget stops a denied tool loop before further dispatch', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([
    assistant(
      [
        call('amos_read', { path: 'missing-a' }, 'call-a'),
        call('amos_read', { path: 'missing-b' }, 'call-b'),
      ],
      'toolUse',
    ),
    assistant(
      [call('amos_read', { path: 'missing-c' }, 'call-c')],
      'toolUse',
    ),
    assistant([text('unreachable')]),
  ]);
  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-tool-budget',
    files: {},
    tools: ['read'],
    policy: ALLOW_POLICY,
    audit: (event) => {
      audit.push(event);
    },
    maxToolCalls: 2,
    maxTurns: 10,
    promptTimeoutMs: 1_000,
  });

  await assert.rejects(
    () => host.prompt('keep trying denied reads'),
    /strict_tool_budget_exceeded/,
  );

  // Two denied calls were dispatched and audited; the over-budget third call
  // was refused before reaching the strict core.
  assert.equal(audit.length, 2);
  await host.stop();
  await assert.rejects(() => host.prompt('after budget'), /strict_host_stopped/);
});

test('turn budget stops a tool loop even when tool calls remain under budget', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([
    assistant(
      [call('amos_read', { path: 'missing-a' }, 'turn-a')],
      'toolUse',
    ),
    assistant(
      [call('amos_read', { path: 'missing-b' }, 'turn-b')],
      'toolUse',
    ),
    assistant([text('unreachable')]),
  ]);
  const audit: unknown[] = [];
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-turn-budget',
    files: {},
    tools: ['read'],
    policy: ALLOW_POLICY,
    audit: (event) => {
      audit.push(event);
    },
    maxToolCalls: 10,
    maxTurns: 1,
    promptTimeoutMs: 1_000,
  });

  await assert.rejects(
    () => host.prompt('loop turns'),
    /strict_turn_budget_exceeded/,
  );
  assert.equal(audit.length, 2);
  await host.stop();
});

test('prompt timeout aborts the run and clears its timer', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([hang()]);
  const started = Date.now();
  const host = await createStrictPiSession({
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-timeout',
    files: {},
    tools: [],
    policy: ALLOW_POLICY,
    audit: () => {},
    promptTimeoutMs: 40,
  });

  await assert.rejects(() => host.prompt('wait forever'), /strict_prompt_timeout/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `timeout took too long: ${elapsed}ms`);
  assert.equal(transport.requests.length, 1);

  await host.stop();
  await assert.rejects(() => host.prompt('after timeout'), /strict_host_stopped/);
});

test('extraneous host resources are rejected before the session starts', async (t) => {
  const directory = workspace(t);
  const transport = new ScriptedTransport([assistant([text('never')])]);
  const base = {
    model: FAKE_MODEL,
    modelRuntime: modelRuntime(transport),
    cwd: directory,
    sessionId: 'strict-unsafe',
    files: {},
    tools: [] as const,
    policy: ALLOW_POLICY,
    audit: () => {},
  };

  for (const key of [
    'customTools',
    'resourceLoader',
    'settingsManager',
    'sessionManager',
    'extensionFactories',
  ]) {
    await assert.rejects(
      () =>
        createStrictPiSession({
          ...base,
          [key]: {},
        } as never),
      /strict_unsafe_host_option/,
      key,
    );
  }

  for (const [key, value] of [
    ['maxToolCalls', 0],
    ['maxToolCalls', 1.5],
    ['maxToolCalls', 2_000],
    ['maxTurns', -1],
    ['maxTurns', Number.NaN],
    ['promptTimeoutMs', 0],
    ['promptTimeoutMs', Number.POSITIVE_INFINITY],
    ['promptTimeoutMs', '100'],
  ] as const) {
    await assert.rejects(
      () =>
        createStrictPiSession({
          ...base,
          [key]: value,
        } as never),
      /strict_invalid_budget/,
      `${key}:${String(value)}`,
    );
  }

  await assert.rejects(
    () =>
      createStrictPiSession({
        ...base,
        requirementEgress: 'maybe',
      } as never),
    /strict_invalid_requirement_egress/,
  );

  const invalidSnapshot = {
    ...snapshotInput({
      rules: [rule({ id: 'snapshot-rule', narrative: 'Snapshot.' })],
    }),
    advisoryDigest: `sha256:${'0'.repeat(64)}`,
  };
  await assert.rejects(
    () =>
      createStrictPiSession({
        ...base,
        advisorySnapshot: invalidSnapshot,
      } as never),
    /strict_invalid_advisory_snapshot/,
  );
});
