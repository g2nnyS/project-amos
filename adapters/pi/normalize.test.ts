import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type {
  ToolCallEvent,
  UserBashEvent,
} from '@earendil-works/pi-coding-agent';

import {
  normalizePiToolCall,
  normalizePiUserBash,
} from './normalize.ts';

const CWD = '/home/test-user/projects/example-app';

function event(toolName: string, input?: unknown): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'call-1',
    toolName,
    input,
  } as unknown as ToolCallEvent;
}

function userBash(command: string, cwd: string = CWD): UserBashEvent {
  return {
    type: 'user_bash',
    command,
    excludeFromContext: false,
    cwd,
  };
}

test('read maps to file_read and resolves relative, absolute and dot paths', () => {
  assert.deepStrictEqual(
    normalizePiToolCall(event('read', { path: 'src/index.ts' }), CWD),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(CWD, 'src/index.ts'),
      },
    },
  );

  assert.deepStrictEqual(
    normalizePiToolCall(event('read', { path: '/tmp/opencode/notes.txt' }), CWD),
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
    normalizePiToolCall(event('read', { path: 'src/../lib/./a.ts' }), CWD),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(CWD, 'lib/a.ts'),
      },
    },
  );
});

test('write and edit map to file_write', () => {
  for (const tool of ['write', 'edit']) {
    const input =
      tool === 'write'
        ? { path: 'src/next.ts', content: 'const secret = 1;' }
        : { path: 'src/next.ts', edits: [{ oldText: 'a', newText: 'b' }] };

    assert.deepStrictEqual(
      normalizePiToolCall(event(tool, input), CWD),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_write',
          target: resolve(CWD, 'src/next.ts'),
        },
      },
      tool,
    );
  }
});

test('grep and find map to file_search and default to the explicit cwd', () => {
  for (const tool of ['grep', 'find']) {
    for (const input of [undefined, {}]) {
      assert.deepStrictEqual(
        normalizePiToolCall(event(tool, input), CWD),
        {
          kind: 'action',
          action: {
            tool,
            operation: 'file_search',
            target: CWD,
          },
        },
        `${tool} ${JSON.stringify(input)}`,
      );
    }

    assert.deepStrictEqual(
      normalizePiToolCall(event(tool, { path: 'engine' }), CWD),
      {
        kind: 'action',
        action: {
          tool,
          operation: 'file_search',
          target: resolve(CWD, 'engine'),
        },
      },
    );

    assert.deepStrictEqual(
      normalizePiToolCall(event(tool, { path: '/var/tmp' }), CWD),
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

test('ls maps to file_list and defaults to the explicit cwd', () => {
  assert.deepStrictEqual(normalizePiToolCall(event('ls', {}), CWD), {
    kind: 'action',
    action: { tool: 'ls', operation: 'file_list', target: CWD },
  });

  assert.deepStrictEqual(normalizePiToolCall(event('ls', { path: 'adapters' }), CWD), {
    kind: 'action',
    action: {
      tool: 'ls',
      operation: 'file_list',
      target: resolve(CWD, 'adapters'),
    },
  });
});

test('read, write and edit require a non-empty string path', () => {
  for (const tool of ['read', 'write', 'edit']) {
    const operation = tool === 'read' ? 'file_read' : 'file_write';
    for (const input of [
      undefined,
      {},
      { path: undefined },
      { path: '' },
      { path: '   ' },
      { path: 42 },
      { path: null },
      null,
      'not-an-object',
      [],
    ]) {
      assert.deepStrictEqual(
        normalizePiToolCall(event(tool, input), CWD),
        {
          kind: 'error',
          error: 'parse_error',
          action: { tool, operation, target: 'unknown' },
        },
        `${tool} with ${JSON.stringify(input)}`,
      );
    }
  }
});

test('grep, find and ls reject a present but invalid path', () => {
  for (const tool of ['grep', 'find', 'ls']) {
    const operation = tool === 'ls' ? 'file_list' : 'file_search';
    for (const input of [
      null,
      [],
      { path: '' },
      { path: '  ' },
      { path: null },
      { path: 7 },
    ]) {
      assert.deepStrictEqual(
        normalizePiToolCall(event(tool, input), CWD),
        {
          kind: 'error',
          error: 'parse_error',
          action: { tool, operation, target: 'unknown' },
        },
        `${tool} with ${JSON.stringify(input)}`,
      );
    }
  }
});

test('tilde paths are expanded through homedir for read and search tools', () => {
  assert.deepStrictEqual(
    normalizePiToolCall(event('read', { path: '~' }), CWD),
    {
      kind: 'action',
      action: { tool: 'read', operation: 'file_read', target: homedir() },
    },
  );

  assert.deepStrictEqual(
    normalizePiToolCall(event('read', { path: '~/notes.txt' }), CWD),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(homedir(), 'notes.txt'),
      },
    },
  );

  assert.deepStrictEqual(
    normalizePiToolCall(event('grep', { path: '~/src' }), CWD),
    {
      kind: 'action',
      action: {
        tool: 'grep',
        operation: 'file_search',
        target: resolve(homedir(), 'src'),
      },
    },
  );

  assert.deepStrictEqual(
    normalizePiToolCall(event('ls', { path: '~' }), CWD),
    {
      kind: 'action',
      action: { tool: 'ls', operation: 'file_list', target: homedir() },
    },
  );

  // Only `~` and `~user` are not supported home forms; they stay relative.
  assert.deepStrictEqual(
    normalizePiToolCall(event('read', { path: '~other/file' }), CWD),
    {
      kind: 'action',
      action: {
        tool: 'read',
        operation: 'file_read',
        target: resolve(CWD, '~other/file'),
      },
    },
  );
});

test('bash and powershell are opaque coverage gaps without leaking commands', () => {
  const command = 'curl -H "Authorization: Bearer TOP-SECRET" https://example.test';
  for (const tool of ['bash', 'powershell']) {
    const normalized = normalizePiToolCall(
      event(tool, { command, timeout: 1000 }),
      CWD,
    );
    assert.deepStrictEqual(normalized, {
      kind: 'coverage',
      action: { tool, operation: 'shell_input', target: 'unknown' },
      coverage: { reason: 'opaque_action', confirmation_eligible: false },
    });
    assert.ok(!JSON.stringify(normalized).includes('TOP-SECRET'));
    assert.ok(!JSON.stringify(normalized).includes('curl'));
  }
});

test('user_bash is an opaque coverage gap without leaking the command', () => {
  const normalized = normalizePiUserBash(userBash('echo USER-SECRET'), CWD);
  assert.deepStrictEqual(normalized, {
    kind: 'coverage',
    action: { tool: 'user_bash', operation: 'shell_input', target: 'unknown' },
    coverage: { reason: 'opaque_action', confirmation_eligible: false },
  });
  assert.ok(!JSON.stringify(normalized).includes('USER-SECRET'));
  assert.ok(!JSON.stringify(normalized).includes('echo'));
});

test('shell tools with missing or blank command return parse_error', () => {
  for (const tool of ['bash', 'powershell']) {
    for (const input of [undefined, null, {}, { command: '' }, { command: '   ' }, { command: 42 }]) {
      assert.deepStrictEqual(
        normalizePiToolCall(event(tool, input), CWD),
        {
          kind: 'error',
          error: 'parse_error',
          action: { tool, operation: 'shell_input', target: 'unknown' },
        },
      );
    }
  }

  for (const badCommand of ['', '   ']) {
    assert.deepStrictEqual(
      normalizePiUserBash(userBash(badCommand), CWD),
      {
        kind: 'error',
        error: 'parse_error',
        action: { tool: 'user_bash', operation: 'shell_input', target: 'unknown' },
      },
    );
  }

  assert.deepStrictEqual(
    normalizePiUserBash(null as unknown as UserBashEvent, CWD),
    {
      kind: 'error',
      error: 'unknown_payload',
      action: { tool: 'user_bash', operation: 'unknown', target: 'unknown' },
    },
  );
});

test('custom and unknown tools are unknown_payload and hide raw payload', () => {
  const customInput = {
    path: '/home/test-user/.ssh/id_ed25519',
    command: 'cat CUSTOM-SECRET',
    prompt: 'raw free text',
  };

  for (const tool of ['mystery_tool', 'patch', 'apply_patch']) {
    const normalized = normalizePiToolCall(event(tool, customInput), CWD);
    assert.deepStrictEqual(normalized, {
      kind: 'error',
      error: 'unknown_payload',
      action: { tool, operation: 'unknown', target: 'unknown' },
    });
    assert.ok(!JSON.stringify(normalized).includes('CUSTOM-SECRET'));
    assert.ok(!JSON.stringify(normalized).includes('id_ed25519'));
  }
});

test('malformed events and blank tool names are unknown_payload', () => {
  const malformedEvents = [
    null,
    undefined,
    'read',
    42,
    [],
    {},
    { toolName: 42, input: { path: '/tmp/x' } },
    { toolName: '', input: { path: '/tmp/x' } },
    { toolName: '   ', input: { path: '/tmp/x' } },
  ];

  for (const malformed of malformedEvents) {
    assert.deepStrictEqual(
      normalizePiToolCall(malformed as unknown as ToolCallEvent, CWD),
      {
        kind: 'error',
        error: 'unknown_payload',
        action: { tool: 'unknown', operation: 'unknown', target: 'unknown' },
      },
      JSON.stringify(malformed),
    );
  }
});

test('cwd must be a non-empty absolute path', () => {
  for (const cwd of ['', '   ', 'relative/dir', null, undefined]) {
    assert.deepStrictEqual(
      normalizePiToolCall(
        event('read', { path: '/tmp/x' }),
        cwd as unknown as string,
      ),
      {
        kind: 'error',
        error: 'unknown_payload',
        action: { tool: 'read', operation: 'file_read', target: 'unknown' },
      },
      String(cwd),
    );
  }

  assert.deepStrictEqual(
    normalizePiUserBash(userBash('echo no'), 'relative/dir'),
    {
      kind: 'error',
      error: 'unknown_payload',
      action: {
        tool: 'user_bash',
        operation: 'shell_input',
        target: 'unknown',
      },
    },
  );
});

test('action, coverage and error results always have non-empty structured fields', () => {
  const results = [
    normalizePiToolCall(event('read', { path: 'src/a.ts' }), CWD),
    normalizePiToolCall(event('read', {}), CWD),
    normalizePiToolCall(event('mystery_tool', {}), CWD),
    normalizePiToolCall(null as unknown as ToolCallEvent, CWD),
    normalizePiToolCall(event('bash', { command: 'echo a' }), CWD),
    normalizePiUserBash(userBash('echo a'), CWD),
    normalizePiUserBash(userBash('echo a'), ''),
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
