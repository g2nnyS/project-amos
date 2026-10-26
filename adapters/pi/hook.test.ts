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
import { join, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import atmosPiLogOnly, { readPiConfig } from './index.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');

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
  const directory = mkdtempSync(join('/tmp/opencode', 'atmos-pi-hook-'));
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

  t.after(() => rmSync(directory, { recursive: true, force: true }));

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

  // Targets live inside the real rule table's /home/<user>/projects/** path
  // whitelist; only the configuration and log live in the temporary folder.
  const readInput = { path: join(ROOT, 'src/example.ts') };
  assert.equal(await hook.toolCall('read', readInput), undefined);
  assert.deepEqual(readInput, { path: join(ROOT, 'src/example.ts') });

  assert.equal(
    await hook.toolCall('write', {
      path: join(ROOT, 'docs/generated.md'),
      content: 'secret-content',
    }),
    undefined,
  );
  assert.equal(
    await hook.toolCall('bash', { command: 'TOP_SECRET_COMMAND --token=abc' }),
    undefined,
  );
  assert.equal(
    await hook.toolCall('custom_tool', {
      command: 'TOP_SECRET_COMMAND',
      content: 'secret-content',
    }),
    undefined,
  );
  assert.equal(
    await hook.userBash('TOP_SECRET_COMMAND --token=abc'),
    undefined,
  );

  const entries = hook.entries();
  assert.equal(entries.length, 5);

  assert.equal(entries[0].verdict, 'log');
  assert.deepEqual(entries[0].matched_rule_ids, ['side_effect-1-3']);
  assert.deepEqual(entries[0].action, {
    tool: 'read',
    operation: 'file_read',
    target: join(ROOT, 'src/example.ts'),
  });

  assert.equal(entries[1].verdict, 'confirm');
  assert.deepEqual(entries[1].action, {
    tool: 'write',
    operation: 'file_write',
    target: join(ROOT, 'docs/generated.md'),
  });

  assert.equal(entries[2].verdict, 'confirm');
  assert.deepEqual(entries[2].action, {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  });

  assert.equal(entries[3].verdict, 'deny');
  assert.equal(entries[3].error, 'unknown_payload');
  assert.deepEqual(entries[3].action, {
    tool: 'custom_tool',
    operation: 'unknown',
    target: 'unknown',
  });

  assert.equal(entries[4].verdict, 'confirm');
  assert.deepEqual(entries[4].action, {
    tool: 'user_bash',
    operation: 'shell_input',
    target: 'unknown',
  });

  const rawLog = readFileSync(hook.logPath(), 'utf8');
  assert.equal(rawLog.includes('TOP_SECRET_COMMAND'), false);
  assert.equal(rawLog.includes('token=abc'), false);
  assert.equal(rawLog.includes('secret-content'), false);
});

test('a tool call ensures the recorder even without session_start', async (t) => {
  const hook = setup(t);

  assert.equal(
    await hook.toolCall('read', { path: join(ROOT, 'src/example.ts') }),
    undefined,
  );
  assert.equal(await hook.toolCall('grep', { path: join(ROOT, 'engine') }), undefined);

  const entries = hook.entries();
  assert.deepEqual(entries.map((entry) => entry.verdict), ['log', 'log']);
  assert.deepEqual(entries[1].action, {
    tool: 'grep',
    operation: 'file_search',
    target: join(ROOT, 'engine'),
  });
});

test('throwing payload getters are audited as engine_error without leaking values', async (t) => {
  const hook = setup(t);
  assert.equal(await hook.sessionStart(), undefined);

  const toolSecret = 'TOOL_GETTER_SECRET';
  const badToolCall = {
    type: 'tool_call',
    toolCallId: 'call-throwing-tool-name',
    input: { path: join(ROOT, 'src/example.ts') },
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
  const directory = mkdtempSync(join('/tmp/opencode', 'atmos-pi-config-'));
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
