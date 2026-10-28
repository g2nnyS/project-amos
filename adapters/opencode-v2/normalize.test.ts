import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeOpenCodeAction } from './normalize.ts';

const DIR = '/home/test-user/projects/example-app';

type Event = { tool: unknown; input?: unknown };

function event(tool: unknown, input?: unknown): Event {
  return input === undefined ? { tool } : { tool, input };
}

function normalized(eventValue: unknown, directory: string = DIR) {
  return normalizeOpenCodeAction(
    eventValue as { tool?: unknown; input?: unknown },
    directory,
  );
}

test('read maps to file_read and resolves a relative path', () => {
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('read', { path: 'src/index.ts' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(DIR, 'src/index.ts'),
      },
    },
  );
});

test('read resolves an absolute path and a directory read path', () => {
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('read', { path: '/tmp/opencode/notes.txt' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: '/tmp/opencode/notes.txt',
      },
    },
  );

  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('read', { path: '.' }), DIR),
    {
      kind: 'action',
      action: { tool: 'read', operation: 'file_read', target: DIR },
    },
  );
});

test('write and edit map to file_write', () => {
  for (const tool of ['write', 'edit']) {
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event(tool, { path: 'src/next.ts' }), DIR),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_write',
          target: resolve(DIR, 'src/next.ts'),
        },
      },
    );
  }
});

test('relative paths are resolved and dot segments are normalized', () => {
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('edit', { path: 'src/../lib/./a.ts' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'edit',
        operation: 'file_write',
        target: resolve(DIR, 'lib/a.ts'),
      },
    },
  );
});

test('read, write and edit missing or invalid path return parse_error', () => {
  for (const tool of ['read', 'write', 'edit']) {
    const expectedOperation = tool === 'read' ? 'file_read' : 'file_write';
    for (const input of [
      {},
      { path: undefined },
      { path: '' },
      { path: '   ' },
      { path: 42 },
      { path: null },
      null,
      'not-an-object',
    ]) {
      assert.deepStrictEqual(
        normalizeOpenCodeAction(event(tool, input), DIR),
        {
          kind: 'error',
          error: 'parse_error',
          action: {
            tool,
            operation: expectedOperation,
            target: 'unknown',
          },
        },
        `${tool} with input ${JSON.stringify(input)}`,
      );
    }
  }
});

test('glob and grep default to the explicit project directory', () => {
  for (const tool of ['glob', 'grep']) {
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event(tool, {}), DIR),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_search',
          target: DIR,
        },
      },
    );
    assert.deepStrictEqual(
      normalizeOpenCodeAction({ tool }, DIR),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_search',
          target: DIR,
        },
      },
    );
  }
});

test('glob and grep resolve provided relative, absolute and empty-ish paths', () => {
  for (const tool of ['glob', 'grep']) {
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event(tool, { path: 'engine' }), DIR),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_search',
          target: resolve(DIR, 'engine'),
        },
      },
    );
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event(tool, { path: '/var/tmp' }), DIR),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_search',
          target: '/var/tmp',
        },
      },
    );
  }
});

test('glob, grep and list reject a present but invalid path', () => {
  for (const tool of ['glob', 'grep', 'list']) {
    for (const input of [{ path: '' }, { path: '  ' }, { path: null }, { path: 7 }, null, []]) {
      assert.deepStrictEqual(
        normalizeOpenCodeAction(event(tool, input), DIR),
        {
          kind: 'error',
          error: 'parse_error',
          action: {
            tool,
            operation: tool === 'list' ? 'file_list' : 'file_search',
            target: 'unknown',
          },
        },
        `${tool} with input ${JSON.stringify(input)}`,
      );
    }
  }
});

test('list maps to file_list and defaults to the project directory', () => {
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('list', {}), DIR),
    {
      kind: 'action',
      action: { tool: 'list', operation: 'file_list', target: DIR },
    },
  );
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('list', { path: 'adapters' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'list',
        operation: 'file_list',
        target: resolve(DIR, 'adapters'),
      },
    },
  );
});

test('known non-file tools become explicit coverage gaps', () => {
  const tools = [
    'shell',
    'bash',
    'task',
    'webfetch',
    'websearch',
    'skill',
    'question',
    'execute',
    'subagent',
    'todowrite',
    'todoread',
  ];

  for (const tool of tools) {
    const input = {
      path: '/etc/passwd',
      command: 'echo COVERAGE_SECRET --token=abc',
      content: 'COVERAGE_SECRET',
      prompt: 'raw free text',
    };
    const normalized = normalizeOpenCodeAction(event(tool, input), DIR);
    assert.deepStrictEqual(
      normalized,
      {
        kind: 'coverage',
        action: { tool, operation: 'tool_input', target: 'unknown' },
        coverage: { reason: 'unsupported_tool', confirmation_eligible: false },
      },
      tool,
    );

    const serialized = JSON.stringify(normalized);
    assert.equal(serialized.includes('COVERAGE_SECRET'), false, tool);
    assert.equal(serialized.includes('/etc/passwd'), false, tool);
    assert.equal(serialized.includes('free text'), false, tool);
  }
});

test('patch and apply_patch are unknown_payload rather than skipped', () => {
  for (const tool of ['patch', 'apply_patch']) {
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event(tool, { patchText: '*** Begin Patch' }), DIR),
      {
        kind: 'error',
        error: 'unknown_payload',
        action: { tool, operation: 'unknown', target: 'unknown' },
      },
    );
  }
});

test('unknown tools are unknown_payload and never leak raw input into target', () => {
  const input = { path: '/home/test-user/.ssh/id_ed25519', prompt: 'raw free text' };
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('mystery_tool', input), DIR),
    {
      kind: 'error',
      error: 'unknown_payload',
      action: {
        tool: 'mystery_tool',
        operation: 'unknown',
        target: 'unknown',
      },
    },
  );
});

test('malformed events or tools are unknown_payload with a valid fallback action', () => {
  const malformedEvents = [
    null,
    undefined,
    'read',
    42,
    [],
    {},
    { tool: 42, input: { path: '/tmp/x' } },
    { tool: '', input: { path: '/tmp/x' } },
    { tool: '   ', input: { path: '/tmp/x' } },
  ];

  for (const malformed of malformedEvents) {
    assert.deepStrictEqual(
      normalized(malformed),
      {
        kind: 'error',
        error: 'unknown_payload',
        action: { tool: 'unknown', operation: 'unknown', target: 'unknown' },
      },
      JSON.stringify(malformed),
    );
  }
});

test('an unusable project directory is unknown_payload for file tools', () => {
  for (const directory of ['', '   ', 'relative/dir']) {
    assert.deepStrictEqual(
      normalizeOpenCodeAction(event('read', { path: '/tmp/x' }), directory),
      {
        kind: 'error',
        error: 'unknown_payload',
        action: { tool: 'read', operation: 'file_read', target: 'unknown' },
      },
    );
  }

  assert.deepStrictEqual(
    normalizeOpenCodeAction(
      event('read', { path: '/tmp/x' }),
      null as unknown as string,
    ),
    {
      kind: 'error',
      error: 'unknown_payload',
      action: { tool: 'read', operation: 'file_read', target: 'unknown' },
    },
  );
});

test('tilde paths are expanded through homedir for file tools', () => {
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('read', { path: '~/.ssh/id_ed25519' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(homedir(), '.ssh/id_ed25519'),
      },
    },
  );
  assert.deepStrictEqual(
    normalizeOpenCodeAction(event('grep', { path: '~' }), DIR),
    {
      kind: 'action',
      action: {
        tool: 'grep',
        operation: 'file_search',
        target: homedir(),
      },
    },
  );
});

test('action, coverage and error results always contain non-empty structured fields', () => {
  const results = [
    normalizeOpenCodeAction(event('read', { path: 'src/a.ts' }), DIR),
    normalizeOpenCodeAction(event('read', {}), DIR),
    normalizeOpenCodeAction(event('patch', { text: 'raw' }), DIR),
    normalizeOpenCodeAction(event('unknown', { text: 'raw' }), DIR),
    normalizeOpenCodeAction(event('shell', { command: 'raw' }), DIR),
    normalized(null),
  ];

  for (const result of results) {
    assert.notEqual(result.kind, 'skip');
    assert.ok(result.action.tool.length > 0);
    assert.ok(result.action.operation.length > 0);
    assert.ok(result.action.target.length > 0);
    assert.equal(typeof result.action.tool, 'string');
    assert.equal(typeof result.action.operation, 'string');
    assert.equal(typeof result.action.target, 'string');
  }
});
