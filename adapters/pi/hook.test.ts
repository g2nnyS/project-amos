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
import { join, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import atmosPiLogOnly, { readPiConfig } from './index.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');

// The Pi adapter derives the session workspace from the explicit `ctx.cwd`
// supplied by the harness, so rule evaluation never depends on the clone
// location. This logical path is outside that workspace and exercises the
// ${SESSION_WORKSPACE} boundary without touching the host filesystem.
const OUTSIDE_WORKSPACE = '/home/test-user/projects/other-project';

type Handler = (event: unknown, ctx: unknown) => unknown;

function validConfig(): Record<string, unknown> {
  return {
    mode: 'log-only',
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: './audit.jsonl',
  };
}

function setup(
  t: { after(callback: () => void): void },
  options: { config?: unknown } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'atmos-pi-hook-'));
  // The explicit session directory is what Pi supplies as ctx.cwd. Keep it
  // separate from the temporary root so configuration and audit output stay
  // inside a workspace that the rule table can describe with
  // ${SESSION_WORKSPACE}.
  const directory = join(root, 'workspace');
  mkdirSync(directory, { recursive: true });
  const config = 'config' in options ? options.config : validConfig();
  if (config !== null) {
    mkdirSync(join(directory, '.pi'), { recursive: true });
    writeFileSync(
      join(directory, '.pi', 'atmos.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
      'utf8',
    );
  }

  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  atmosPiLogOnly(pi);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  const ctx = { cwd: directory };

  function handler(name: string): Handler {
    const registered = handlers.get(name);
    assert.ok(registered, `missing handler: ${name}`);
    return registered;
  }

  return {
    directory,
    handlers,
    sessionStart(): unknown {
      return handler('session_start')(
        { type: 'session_start', reason: 'startup' },
        ctx,
      );
    },
    toolCall(toolName: string, input?: unknown): unknown {
      return handler('tool_call')(
        {
          type: 'tool_call',
          toolCallId: 'call-1',
          toolName,
          ...(input === undefined ? {} : { input }),
        },
        ctx,
      );
    },
    userBash(command: string): unknown {
      return handler('user_bash')(
        {
          type: 'user_bash',
          command,
          excludeFromContext: false,
          cwd: directory,
        },
        ctx,
      );
    },
    rawToolCall(event: unknown): unknown {
      return handler('tool_call')(event, ctx);
    },
    rawUserBash(event: unknown): unknown {
      return handler('user_bash')(event, ctx);
    },
    logPath(): string {
      return join(directory, 'audit.jsonl');
    },
    entries(): Array<Record<string, any>> {
      const path = join(directory, 'audit.jsonl');
      if (!existsSync(path)) {
        return [];
      }
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

test('read, write, bash, unknown and user_bash are logged without blocking', async (t) => {
  const hook = setup(t);
  assert.equal(await hook.sessionStart(), undefined);

  // Targets live inside the explicit session workspace; only the session
  // directory and temporary audit output are touched.
  const readTarget = join(hook.directory, 'src/example.ts');
  const writeTarget = join(hook.directory, 'docs/generated.md');
  const secretCommand = 'TOP_SECRET_COMMAND --token=abc';
  const secretContent = 'secret-content';

  const readInput = { path: readTarget };
  assert.equal(await hook.toolCall('read', readInput), undefined);
  assert.deepEqual(readInput, { path: readTarget });

  assert.equal(
    await hook.toolCall('write', {
      path: writeTarget,
      content: secretContent,
    }),
    undefined,
  );
  assert.equal(
    await hook.toolCall('bash', { command: secretCommand }),
    undefined,
  );
  assert.equal(
    await hook.toolCall('custom_tool', {
      command: secretCommand,
      content: secretContent,
    }),
    undefined,
  );
  assert.equal(await hook.userBash(secretCommand), undefined);

  const entries = hook.entries();
  assert.equal(entries.length, 5);

  assert.equal(entries[0].verdict, 'log');
  assert.deepEqual(entries[0].matched_rule_ids, ['side_effect-1-3']);
  assert.deepEqual(entries[0].action, {
    tool: 'read',
    operation: 'file_read',
    target: readTarget,
  });

  assert.equal(entries[1].verdict, 'confirm');
  assert.deepEqual(entries[1].matched_rule_ids, ['side_effect-1-2']);
  assert.deepEqual(entries[1].action, {
    tool: 'write',
    operation: 'file_write',
    target: writeTarget,
  });

  assert.equal(entries[2].verdict, null);
  assert.equal(entries[2].decision, 'not_evaluated');
  assert.deepEqual(entries[2].action, {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  });
  assert.deepEqual(entries[2].coverage, {
    reason: 'opaque_action',
    confirmation_eligible: false,
  });

  assert.equal(entries[3].verdict, 'deny');
  assert.equal(entries[3].error, 'unknown_payload');
  assert.deepEqual(entries[3].action, {
    tool: 'custom_tool',
    operation: 'unknown',
    target: 'unknown',
  });

  assert.equal(entries[4].verdict, null);
  assert.equal(entries[4].decision, 'not_evaluated');
  assert.deepEqual(entries[4].action, {
    tool: 'user_bash',
    operation: 'shell_input',
    target: 'unknown',
  });
  assert.deepEqual(entries[4].coverage, {
    reason: 'opaque_action',
    confirmation_eligible: false,
  });

  const rawLog = readFileSync(hook.logPath(), 'utf8');
  assert.equal(rawLog.includes('TOP_SECRET_COMMAND'), false);
  assert.equal(rawLog.includes('token=abc'), false);
  assert.equal(rawLog.includes('secret-content'), false);
});

test('a tool call ensures the recorder even without session_start', async (t) => {
  const hook = setup(t);

  const readTarget = join(hook.directory, 'src/example.ts');
  const grepTarget = join(hook.directory, 'engine');
  assert.equal(
    await hook.toolCall('read', { path: readTarget }),
    undefined,
  );
  assert.equal(await hook.toolCall('grep', { path: grepTarget }), undefined);

  const entries = hook.entries();
  assert.deepEqual(entries.map((entry) => entry.verdict), ['log', 'log']);
  assert.deepEqual(entries[1].action, {
    tool: 'grep',
    operation: 'file_search',
    target: grepTarget,
  });
});

test('targets outside the explicit session workspace are denied', async (t) => {
  const hook = setup(t);
  const outsideTarget = join(OUTSIDE_WORKSPACE, 'src/example.ts');

  assert.equal(
    await hook.toolCall('read', { path: outsideTarget }),
    undefined,
  );

  const [entry] = hook.entries();
  assert.equal(entry.verdict, 'deny');
  assert.ok(entry.matched_rule_ids.includes('filesystem-0-2'));
  assert.deepEqual(entry.action, {
    tool: 'read',
    operation: 'file_read',
    target: outsideTarget,
  });
});

test('throwing payload getters are audited as engine_error without leaking values', async (t) => {
  const hook = setup(t);
  assert.equal(await hook.sessionStart(), undefined);

  const toolSecret = 'TOOL_GETTER_SECRET';
  const badToolCall = {
    type: 'tool_call',
    toolCallId: 'call-throwing-tool-name',
    input: { path: join(hook.directory, 'src/example.ts') },
  };
  Object.defineProperty(badToolCall, 'toolName', {
    enumerable: true,
    get() {
      throw new Error(toolSecret);
    },
  });
  assert.equal(await hook.rawToolCall(badToolCall), undefined);

  const bashSecret = 'USER_BASH_GETTER_SECRET';
  const badUserBash = {
    type: 'user_bash',
    excludeFromContext: false,
    cwd: hook.directory,
  };
  Object.defineProperty(badUserBash, 'command', {
    enumerable: true,
    get() {
      throw new Error(bashSecret);
    },
  });
  assert.equal(await hook.rawUserBash(badUserBash), undefined);

  const entries = hook.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      verdict: entry.verdict,
      error: entry.error,
      matched_rule_ids: entry.matched_rule_ids,
    })),
    [
      { verdict: 'deny', error: 'engine_error', matched_rule_ids: [] },
      { verdict: 'deny', error: 'engine_error', matched_rule_ids: [] },
    ],
  );
  assert.deepEqual(entries[0].action, {
    tool: 'unknown',
    operation: 'unknown',
    target: 'unknown',
  });
  assert.deepEqual(entries[1].action, {
    tool: 'user_bash',
    operation: 'unknown',
    target: 'unknown',
  });

  const rawLog = readFileSync(hook.logPath(), 'utf8');
  assert.equal(rawLog.includes(toolSecret), false);
  assert.equal(rawLog.includes(bashSecret), false);
});

test('configuration failure never throws and is reported once', async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  const hook = setup(t, { config: null });
  assert.equal(await hook.sessionStart(), undefined);
  assert.equal(await hook.toolCall('read', { path: 'src/example.ts' }), undefined);
  assert.equal(await hook.toolCall('write', { path: 'docs/x.md' }), undefined);
  assert.equal(await hook.userBash('TOP_SECRET_COMMAND'), undefined);

  assert.deepEqual(hook.entries(), []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /configuration error/);
  assert.equal(errors[0].includes('TOP_SECRET_COMMAND'), false);
  assert.equal(errors[0].includes(ROOT), false);
});

test('audit write failure is visible once without leaking path or payload', async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  const hook = setup(t, {
    config: { ...validConfig(), logPath: './blocker/audit.jsonl' },
  });
  writeFileSync(join(hook.directory, 'blocker'), 'not a directory', 'utf8');

  const secret = 'AUDIT_FAILURE_SECRET';
  assert.equal(
    await hook.toolCall('read', { path: join(hook.directory, secret) }),
    undefined,
  );
  assert.equal(
    await hook.toolCall('read', { path: join(hook.directory, 'second.ts') }),
    undefined,
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /audit write failed/);
  assert.equal(errors[0]?.includes(secret), false);
  assert.equal(errors[0]?.includes(hook.directory), false);
});

test('invalid mode or malformed JSON degrades to a no-op recorder', async (t) => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  for (const config of [
    { ...validConfig(), mode: 'enforce' },
    '{"mode":',
    { ...validConfig(), logPath: '' },
  ]) {
    const hook = setup(t, { config });
    assert.equal(await hook.sessionStart(), undefined);
    assert.equal(await hook.toolCall('read', { path: 'src/example.ts' }), undefined);
    assert.deepEqual(hook.entries(), []);
  }

  assert.equal(errors.length, 3);
});

test('readPiConfig resolves relative paths against the explicit session directory', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'atmos-pi-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.pi'), { recursive: true });
  writeFileSync(
    join(directory, '.pi', 'atmos.json'),
    JSON.stringify({
      mode: 'log-only',
      rulesPath: './constraints/rules.yaml',
      schemaPath: './constraints/schema.json',
      logPath: './spike/logs/pi.jsonl',
    }),
    'utf8',
  );

  assert.deepEqual(readPiConfig(directory), {
    mode: 'log-only',
    rulesPath: resolve(directory, 'constraints/rules.yaml'),
    schemaPath: resolve(directory, 'constraints/schema.json'),
    logPath: resolve(directory, 'spike/logs/pi.jsonl'),
  });

  assert.equal(readPiConfig('relative/directory'), null);
  assert.equal(readPiConfig(''), null);
});
