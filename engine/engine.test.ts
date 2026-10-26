import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { evaluate, evaluateWithMatches, assertValidTable } from './engine.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

const ENGINE_ERROR = {
  verdict: 'deny',
  matched_rule_ids: [],
  error: 'engine_error',
} as const;

const SOURCE = {
  repo: 'Termcp',
  rev: '62e060057c79a8c4343ed7452471520a1bb3dcff',
  path: 'docs/api.md',
  section: 'test',
  lines: '1',
  quote: 'test quote',
};

function baseRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rule-1',
    dimension: 'filesystem',
    level: 0,
    expressivity: 'deterministic',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    narrative: 'test narrative',
    on_hit: 'deny',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: { ...SOURCE },
    probe: 'test probe',
    ...overrides,
  };
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'fs',
    operation: 'file_read',
    target: '/home/ganyu/projects/a.ts',
    ...overrides,
  };
}

function call(op: string, args: Record<string, unknown>): Record<string, unknown> {
  return { op, args };
}

function verdictFor(
  predicate: Record<string, unknown>[],
  actionValue: Record<string, unknown> = action(),
): string {
  return evaluate(actionValue, [baseRule({ predicate })], NOW);
}

test('multi-hit priority is deny > confirm > log > allow and includes overridden ids', () => {
  const table = [
    baseRule({ id: 'log-rule', on_hit: 'log' }),
    baseRule({ id: 'confirm-rule', on_hit: 'confirm' }),
    baseRule({ id: 'deny-rule', on_hit: 'deny' }),
    baseRule({ id: 'unmatched-rule', predicate: [call('op_in', { operations: ['file_write'] })] }),
  ];

  assert.deepEqual(evaluateWithMatches(action(), table, NOW), {
    verdict: 'deny',
    matched_rule_ids: ['log-rule', 'confirm-rule', 'deny-rule'],
  });
  assert.equal(evaluate(action(), table, NOW), 'deny');

  assert.deepEqual(evaluateWithMatches(action(), table.slice(0, 2), NOW), {
    verdict: 'confirm',
    matched_rule_ids: ['log-rule', 'confirm-rule'],
  });
  assert.deepEqual(evaluateWithMatches(action(), [table[0]], NOW), {
    verdict: 'log',
    matched_rule_ids: ['log-rule'],
  });
  assert.deepEqual(evaluateWithMatches(action(), [], NOW), {
    verdict: 'allow',
    matched_rule_ids: [],
  });
});

test('same-level deny conflicts stay deny and keep every deny id', () => {
  const table = [
    baseRule({ id: 'deny-a', level: 1, on_hit: 'deny' }),
    baseRule({ id: 'deny-b', level: 1, on_hit: 'deny' }),
  ];
  assert.deepEqual(evaluateWithMatches(action(), table, NOW), {
    verdict: 'deny',
    matched_rule_ids: ['deny-a', 'deny-b'],
  });
});

test('unknown extra fields on action, rule, predicate and args are ignored', () => {
  const table = [
    baseRule({
      id: 'extra-rule',
      unexpected_rule_field: { anything: true },
      predicate: [
        {
          ...call('op_in', { operations: ['file_read'], ignored_arg: 123 }),
          extra_call_field: 'ignored',
        },
      ],
    }),
  ];
  const actionValue = action({
    request_id: 'abc',
    metadata: { nested: true },
    extra: [1, 2, 3],
  });

  assert.deepEqual(evaluateWithMatches(actionValue, table, NOW), {
    verdict: 'deny',
    matched_rule_ids: ['extra-rule'],
  });
});

test('unknown predicate op or on_hit fails closed with empty matches', () => {
  const cases: Record<string, unknown[]> = {
    'unknown predicate op': [
      baseRule({ predicate: [call('rate_exceeds', { limit: ['1'] })] }),
    ],
    'unknown on_hit': [baseRule({ on_hit: 'allow' })],
    'unknown on_hit block': [baseRule({ on_hit: 'block' })],
    'unknown on_hit in expired rule': [
      baseRule({ on_hit: 'not-a-verdict', ttl: '2000-01-01T00:00:00.000Z' }),
    ],
  };

  for (const [label, table] of Object.entries(cases)) {
    assert.deepEqual(
      evaluateWithMatches(action(), table, NOW),
      ENGINE_ERROR,
      label,
    );
  }
});

test('invalid tables fail closed as a whole', () => {
  const invalidTables: Record<string, unknown> = {
    'not an array': {},
    'null table': null,
    'rule not an object': ['not a rule'],
    'missing probe': [baseRule({ probe: undefined })],
    'blank probe': [baseRule({ probe: '   ' })],
    'missing id': [baseRule({ id: undefined })],
    'empty id': [baseRule({ id: '' })],
    'blank id': [baseRule({ id: '   ' })],
    'blank dimension': [baseRule({ dimension: '   ' })],
    'duplicate rule id': [baseRule({ id: 'dup' }), baseRule({ id: 'dup' })],
    'negative level': [baseRule({ level: -1 })],
    'fractional level': [baseRule({ level: 1.5 })],
    'missing narrative': [baseRule({ narrative: undefined })],
    'blank narrative': [baseRule({ narrative: '   ' })],
    'bad scope': [baseRule({ scope: 'global' })],
    'bad owner': [baseRule({ owner: 'robot' })],
    'bad expressivity': [baseRule({ expressivity: 'sometimes' })],
    'missing source field': [
      baseRule({ source: { repo: 'r', rev: 'v', path: 'p', section: 's', lines: '1' } }),
    ],
    'null source': [baseRule({ source: null })],
    'empty deterministic predicate': [baseRule({ predicate: [] })],
    'non-array deterministic predicate': [baseRule({ predicate: null })],
    'advisory with predicate': [
      baseRule({
        expressivity: 'advisory_only',
        predicate: [call('op_in', { operations: ['file_read'] })],
      }),
    ],
    'unknown op in non-matching rule': [
      baseRule({ predicate: [call('mystery_op', { values: ['x'] })] }),
    ],
    'empty operations list': [
      baseRule({ predicate: [call('op_in', { operations: [] })] }),
    ],
    'blank operation item': [
      baseRule({ predicate: [call('op_in', { operations: ['   '] })] }),
    ],
    'empty pattern item': [
      baseRule({ predicate: [call('target_glob', { patterns: [''] })] }),
    ],
    'non-string pattern': [
      baseRule({ predicate: [call('target_glob', { patterns: [1] })] }),
    ],
    'missing args field': [
      baseRule({ predicate: [call('url_query_key_in', { wrong: ['token'] })] }),
    ],
    'invalid ttl text': [baseRule({ ttl: 'not-a-date' })],
    'non-ISO ttl text': [baseRule({ ttl: 'October 24, 2026' })],
    'non-canonical ISO ttl': [baseRule({ ttl: '2026-10-25T00:00:00Z' })],
    'impossible date-only ttl': [baseRule({ ttl: '2026-02-30' })],
    'impossible canonical ttl': [baseRule({ ttl: '2026-02-30T00:00:00.000Z' })],
    'numeric ttl': [baseRule({ ttl: 123 })],
    'empty ttl': [baseRule({ ttl: '' })],
  };

  for (const [label, table] of Object.entries(invalidTables)) {
    assert.deepEqual(
      evaluateWithMatches(action(), table, NOW),
      ENGINE_ERROR,
      label,
    );
    assert.throws(() => assertValidTable(table), Error, label);
  }
});

test('assertValidTable accepts valid rule tables and rejects invalid ones', () => {
  assert.doesNotThrow(() => assertValidTable([]));
  assert.doesNotThrow(() => assertValidTable([baseRule()]));
  assert.doesNotThrow(() =>
    assertValidTable([
      baseRule({
        id: 'advisory',
        expressivity: 'advisory_only',
        predicate: null,
        on_hit: 'confirm',
      }),
    ]),
  );
  assert.throws(() => assertValidTable(null), Error);
  assert.throws(() => assertValidTable([baseRule({ id: '' })]), Error);
});

test('invalid actions and clock values fail closed', () => {
  const invalidActions: Array<[string, unknown]> = [
    ['null action', null],
    ['array action', []],
    ['missing operation', { tool: 'fs', target: '/home/ganyu/projects/a.ts' }],
    ['non-string operation', { tool: 'fs', operation: 7, target: '/x' }],
    ['non-string tool', { tool: 7, operation: 'file_read', target: '/x' }],
    ['non-string target', { tool: 'fs', operation: 'file_read', target: null }],
    ['empty tool', { tool: '', operation: 'file_read', target: '/x' }],
    ['empty operation', { tool: 'fs', operation: '', target: '/x' }],
    ['empty target', { tool: 'fs', operation: 'file_read', target: '' }],
    ['blank tool', { tool: ' \t ', operation: 'file_read', target: '/x' }],
    ['blank operation', { tool: 'fs', operation: '\n ', target: '/x' }],
    ['blank target', { tool: 'fs', operation: 'file_read', target: '   ' }],
  ];

  for (const [label, invalidAction] of invalidActions) {
    assert.deepEqual(
      evaluateWithMatches(invalidAction, [baseRule()], NOW),
      ENGINE_ERROR,
      label,
    );
  }

  for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(evaluateWithMatches(action(), [baseRule()], invalidNow), ENGINE_ERROR);
  }
});

test('empty or whitespace action fields always fail closed with empty matches', () => {
  const tables: unknown[] = [[], [baseRule()], [baseRule({ on_hit: 'confirm' })]];

  for (const field of ['tool', 'operation', 'target']) {
    for (const blank of ['', ' ', '   ', '\t', '\n']) {
      for (const table of tables) {
        assert.deepEqual(
          evaluateWithMatches(action({ [field]: blank }), table, NOW),
          ENGINE_ERROR,
          `${field}=${JSON.stringify(blank)}`,
        );
      }
    }
  }

  assert.deepEqual(
    evaluateWithMatches(
      { tool: 'fs', operation: 'file_read', target: '' },
      [],
      NOW,
    ),
    ENGINE_ERROR,
  );
});

test('source required fields must be non-blank strings', () => {
  for (const field of ['repo', 'rev', 'path', 'section', 'lines', 'quote']) {
    for (const blank of ['', '   ', '\t\n']) {
      assert.deepEqual(
        evaluateWithMatches(
          action(),
          [baseRule({ source: { ...SOURCE, [field]: blank } })],
          NOW,
        ),
        ENGINE_ERROR,
        `${field}=${JSON.stringify(blank)}`,
      );
    }
  }
});

test('internal exceptions from getters and proxies fail closed', () => {
  const actionWithThrowingGetter = {
    tool: 'fs',
    target: '/home/ganyu/projects/a.ts',
    get operation(): string {
      throw new Error('action getter boom');
    },
  };
  assert.deepEqual(
    evaluateWithMatches(actionWithThrowingGetter, [baseRule()], NOW),
    ENGINE_ERROR,
  );

  const hostileRule = new Proxy(baseRule(), {
    get(target, property, receiver) {
      if (property === 'predicate') {
        throw new Error('rule proxy boom');
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(
    evaluateWithMatches(action(), [hostileRule], NOW),
    ENGINE_ERROR,
  );

  assert.deepEqual(evaluateWithMatches(action(), [baseRule()], NOW), {
    verdict: 'deny',
    matched_rule_ids: ['rule-1'],
  });
});

test('ttl expiry boundary skips the rule, null ttl is permanent', () => {
  const ttl = '2026-10-25T00:00:00.000Z';
  const expiresAt = Date.parse(ttl);
  const expiring = baseRule({ ttl });

  assert.equal(evaluate(action(), [expiring], expiresAt - 1), 'deny');
  assert.equal(evaluate(action(), [expiring], expiresAt), 'allow');
  assert.equal(evaluate(action(), [expiring], expiresAt + 1), 'allow');
  assert.deepEqual(evaluateWithMatches(action(), [expiring], expiresAt), {
    verdict: 'allow',
    matched_rule_ids: [],
  });

  assert.equal(evaluate(action(), [baseRule({ ttl: null })], expiresAt + 10_000), 'deny');
  assert.equal(
    evaluate(action(), [baseRule({ ttl: '2026-10-24T11:59:59.000Z' })], NOW),
    'allow',
  );

  const dateOnlyExpiry = Date.parse('2026-10-25');
  assert.equal(
    evaluate(action(), [baseRule({ ttl: '2026-10-25' })], dateOnlyExpiry - 1),
    'deny',
  );
  assert.equal(
    evaluate(action(), [baseRule({ ttl: '2026-10-25' })], dateOnlyExpiry),
    'allow',
  );
});

test('ttl accepts only date-only or canonical UTC ISO strings with real dates', () => {
  const valid: Array<[string, number]> = [
    ['2026-10-24', Date.parse('2026-10-23T23:59:59.999Z')],
    ['2024-02-29', Date.parse('2024-02-28T23:59:59.999Z')],
    ['2024-02-29T00:00:00.000Z', Date.parse('2024-02-28T23:59:59.999Z')],
    ['2026-10-25T00:00:00.000Z', Date.parse('2026-10-24T23:59:59.999Z')],
  ];
  for (const [ttl, now] of valid) {
    assert.equal(evaluate(action(), [baseRule({ ttl })], now), 'deny', ttl);
  }

  const invalid = [
    '2026-10-25T00:00:00Z',
    '2026-10-25T00:00:00.000+08:00',
    '2026-10-25T00:00:00.000z',
    '2026-10-25 00:00:00.000Z',
    'October 24, 2026',
    '2026/10/25',
    '2026-02-30',
    '2026-02-29',
    '2024-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    '2026-01-1',
    ' 2026-01-01',
    '2026-01-01 ',
  ];
  for (const ttl of invalid) {
    assert.deepEqual(
      evaluateWithMatches(action(), [baseRule({ ttl })], NOW),
      ENGINE_ERROR,
      ttl,
    );
  }
});

test('advisory_only rules never match', () => {
  const advisory = baseRule({
    id: 'advisory',
    expressivity: 'advisory_only',
    predicate: null,
    on_hit: 'deny',
  });
  assert.deepEqual(evaluateWithMatches(action(), [advisory], NOW), {
    verdict: 'allow',
    matched_rule_ids: [],
  });

  const logRule = baseRule({ id: 'log-rule', on_hit: 'log' });
  assert.deepEqual(evaluateWithMatches(action(), [advisory, logRule], NOW), {
    verdict: 'log',
    matched_rule_ids: ['log-rule'],
  });
});

test('op_in matches operation exactly', () => {
  assert.equal(
    verdictFor([call('op_in', { operations: ['file_read', 'file_stat'] })]),
    'deny',
  );
  assert.equal(verdictFor([call('op_in', { operations: ['file_write'] })]), 'allow');
  assert.equal(
    verdictFor([call('op_in', { operations: ['FILE_READ'] })]),
    'allow',
  );
});

test('target_glob matches absolute file paths with the frozen glob options', () => {
  const predicate = [
    call('target_glob', { patterns: ['/home/*/.ssh/id_*', '/**/*.pem'] }),
  ];

  assert.equal(
    verdictFor(predicate, action({ target: '/home/alice/.ssh/id_ed25519' })),
    'deny',
  );
  assert.equal(
    verdictFor(predicate, action({ target: '/srv/certs/server.pem' })),
    'deny',
  );
  assert.equal(
    verdictFor(predicate, action({ target: '/home/alice/notes.txt' })),
    'allow',
  );
});

test('target_outside_glob matches only paths outside every pattern', () => {
  const predicate = [call('target_outside_glob', { patterns: ['/home/ganyu/projects/**'] })];

  assert.equal(
    verdictFor(predicate, action({ target: '/tmp/opencode/incoming.patch' })),
    'deny',
  );
  assert.equal(
    verdictFor(predicate, action({ target: '/home/ganyu/projects/nested/a.ts' })),
    'allow',
  );
});

test('url_query_key_in checks keys case-insensitively and ignores values', () => {
  const predicate = [call('url_query_key_in', { keys: ['token', 'x-termcp-password'] })];
  const httpAction = (target: string) =>
    action({ tool: 'http', operation: 'http_request', target });

  assert.equal(
    verdictFor(predicate, httpAction('https://example.test/api?Token=secret&x=1')),
    'deny',
  );
  assert.equal(
    verdictFor(predicate, httpAction('https://example.test/api?tOkEn')),
    'deny',
  );
  assert.equal(
    verdictFor(predicate, httpAction('https://example.test/api?tokenized=secret')),
    'allow',
  );
  assert.equal(
    verdictFor(predicate, httpAction('https://example.test/api?to=secret')),
    'allow',
  );
});

test('target_scheme_in compares normalized schemes for URL-like targets', () => {
  assert.equal(
    verdictFor(
      [call('target_scheme_in', { schemes: ['dynamic'] })],
      action({ tool: 'forward', operation: 'forward_open', target: 'dynamic://192.168.1.20:1080' }),
    ),
    'deny',
  );
  assert.equal(
    verdictFor(
      [call('target_scheme_in', { schemes: ['dynamic:'] })],
      action({ tool: 'forward', operation: 'forward_open', target: 'DYNAMIC://host:1080' }),
    ),
    'deny',
  );
  assert.equal(
    verdictFor(
      [call('target_scheme_in', { schemes: ['dynamic'] })],
      action({ tool: 'forward', operation: 'forward_open', target: 'local://localhost:8080' }),
    ),
    'allow',
  );
});

test('target_host_in normalizes case and IPv6 brackets', () => {
  const hosts = [call('target_host_in', { hosts: ['0.0.0.0', '::'] })];
  const forwardAction = (target: string) =>
    action({ tool: 'forward', operation: 'forward_open', target });

  assert.equal(verdictFor(hosts, forwardAction('dynamic://[::]:1080')), 'deny');
  assert.equal(verdictFor(hosts, forwardAction('local://0.0.0.0:8080')), 'deny');
  assert.equal(verdictFor(hosts, forwardAction('dynamic://192.168.1.20:1080')), 'allow');

  assert.equal(
    verdictFor(
      [call('target_host_in', { hosts: ['example.com'] })],
      forwardAction('remote://Example.COM:22'),
    ),
    'deny',
  );
});

test('target_host_not_in is an exact negated host set', () => {
  const hosts = [call('target_host_not_in', { hosts: ['localhost'] })];
  const forwardAction = (target: string) =>
    action({ tool: 'forward', operation: 'forward_open', target });

  assert.equal(verdictFor(hosts, forwardAction('dynamic://192.168.1.20:1080')), 'deny');
  assert.equal(verdictFor(hosts, forwardAction('local://localhost:8080')), 'allow');
  assert.equal(verdictFor(hosts, forwardAction('local://[::]:8080')), 'deny');

  assert.equal(
    verdictFor(
      [call('target_host_not_in', { hosts: ['localhost', '::'] })],
      forwardAction('local://[::]:8080'),
    ),
    'allow',
  );
});

test('predicate calls inside one rule are ANDed and short-circuit earlier false results', () => {
  const predicate = [
    call('op_in', { operations: ['http_request'] }),
    call('url_query_key_in', { keys: ['token'] }),
  ];

  // file_read does not match op_in, so the URL predicate is not reached and the file target stays valid.
  assert.deepEqual(evaluateWithMatches(action(), [baseRule({ predicate })], NOW), {
    verdict: 'allow',
    matched_rule_ids: [],
  });

  assert.equal(
    evaluate(
      action({ tool: 'http', operation: 'http_request', target: 'https://example.test/?token=x' }),
      [baseRule({ predicate })],
      NOW,
    ),
    'deny',
  );
  assert.equal(
    evaluate(
      action({ tool: 'http', operation: 'http_request', target: 'https://example.test/?other=x' }),
      [baseRule({ predicate })],
      NOW,
    ),
    'allow',
  );
});

test('malformed URLs fail closed with empty matches', () => {
  const httpRule = (predicate: Record<string, unknown>[]) =>
    baseRule({
      predicate: [call('op_in', { operations: ['http_request'] }), ...predicate],
    });
  const httpAction = (target: string) =>
    action({ tool: 'http', operation: 'http_request', target });

  assert.deepEqual(
    evaluateWithMatches(httpAction('not a url'), [httpRule([call('url_query_key_in', { keys: ['token'] })])], NOW),
    ENGINE_ERROR,
  );
  assert.deepEqual(
    evaluateWithMatches(httpAction(''), [httpRule([call('target_scheme_in', { schemes: ['https'] })])], NOW),
    ENGINE_ERROR,
  );
  assert.deepEqual(
    evaluateWithMatches(
      action({ tool: 'forward', operation: 'forward_open', target: 'local:///0.0.0.0:8080' }),
      [baseRule({ predicate: [call('target_host_in', { hosts: ['0.0.0.0', '::'] })] })],
      NOW,
    ),
    ENGINE_ERROR,
  );
});

test('non-canonical file targets fail closed instead of bypassing target_glob', () => {
  const globRule = baseRule({
    predicate: [call('target_glob', { patterns: ['/**/sessions/*/*/log.bin'] })],
  });
  for (const target of [
    '/var/lib/termcp/sessions/s/1//log.bin',
    '/var/lib/termcp/sessions/s/1/./log.bin',
    '/var/lib/termcp/sessions/s/1/../1/log.bin',
    '/var/lib/termcp/sessions/s/1/log.bin/',
  ]) {
    assert.deepEqual(
      evaluateWithMatches(action({ target }), [globRule], NOW),
      ENGINE_ERROR,
      target,
    );
  }
});

test('real constraints/rules.yaml matches the frozen G0 vocabulary and smoke results', () => {
  const rulesPath = join(process.cwd(), 'constraints', 'rules.yaml');
  const rules = parseYaml(readFileSync(rulesPath, 'utf8')) as Array<Record<string, unknown>>;

  assert.ok(Array.isArray(rules));
  assert.equal(rules.length, 15);

  for (const rule of rules) {
    for (const field of [
      'id',
      'dimension',
      'level',
      'expressivity',
      'predicate',
      'narrative',
      'on_hit',
      'scope',
      'ttl',
      'owner',
      'source',
      'probe',
    ]) {
      assert.ok(field in rule, `${String(rule.id)} is missing ${field}`);
    }

    const source = rule.source as Record<string, unknown>;
    assert.equal(typeof source, 'object');
    assert.ok(source !== null);
    for (const field of ['repo', 'rev', 'path', 'section', 'lines', 'quote']) {
      assert.equal(typeof source[field], 'string', `${String(rule.id)} source.${field}`);
    }
    assert.equal(typeof rule.probe, 'string');
    assert.ok((rule.probe as string).trim().length > 0);
  }

  const deterministic = rules.filter((rule) => rule.expressivity === 'deterministic');
  const advisory = rules.filter((rule) => rule.expressivity === 'advisory_only');
  assert.equal(deterministic.length, 10);
  assert.equal(advisory.length, 5);

  for (const rule of deterministic) {
    assert.ok(Array.isArray(rule.predicate));
    assert.ok((rule.predicate as unknown[]).length > 0);
  }
  for (const rule of advisory) {
    assert.equal(rule.predicate, null);
  }

  const actualOps = new Set<string>();
  for (const rule of deterministic) {
    for (const predicate of rule.predicate as Array<Record<string, unknown>>) {
      actualOps.add(predicate.op as string);
    }
  }
  const frozenOps = [
    'op_in',
    'target_glob',
    'target_outside_glob',
    'url_query_key_in',
    'target_scheme_in',
    'target_host_in',
    'target_host_not_in',
  ];
  assert.deepEqual([...actualOps].sort(), [...frozenOps].sort());

  const smoke: Array<[string, Record<string, unknown>, string]> = [
    [
      'credential secret path read',
      action({ tool: 'fs', operation: 'file_read', target: '/home/alice/.ssh/id_ed25519' }),
      'deny',
    ],
    [
      'credential secret path search via grep',
      action({ tool: 'grep', operation: 'file_search', target: '/home/ganyu/projects/app/server.key' }),
      'deny',
    ],
    [
      'credential root ssh key read',
      action({ tool: 'fs', operation: 'file_read', target: '/root/.ssh/id_ed25519' }),
      'deny',
    ],
    [
      'credential token in query',
      action({
        tool: 'http',
        operation: 'http_request',
        target: 'https://127.0.0.1:18765/api/connections/batch?token=SECRET',
      }),
      'deny',
    ],
    [
      'credential plaintext export',
      action({ tool: 'termcp', operation: 'profile_export_plaintext', target: 'profiles.toml' }),
      'deny',
    ],
    [
      'filesystem ssh config write',
      action({ tool: 'fs', operation: 'file_write', target: '/home/alice/.ssh/config' }),
      'deny',
    ],
    [
      'filesystem outside whitelist read',
      action({ tool: 'fs', operation: 'file_read', target: '/tmp/opencode/incoming.patch' }),
      'deny',
    ],
    [
      'filesystem log.bin truncate',
      action({
        tool: 'fs',
        operation: 'file_truncate',
        target: '/var/lib/termcp/sessions/s/1/log.bin',
      }),
      'deny',
    ],
    [
      'network dynamic forward to non-loopback host',
      action({ tool: 'forward', operation: 'forward_open', target: 'dynamic://192.168.1.20:1080' }),
      'deny',
    ],
    [
      'network forward bound to all interfaces',
      action({ tool: 'forward', operation: 'forward_open', target: 'local://0.0.0.0:8080' }),
      'confirm',
    ],
    [
      'side effect project write',
      action({ tool: 'fs', operation: 'file_write', target: '/home/ganyu/projects/a.ts' }),
      'confirm',
    ],
    [
      'side effect project read is log only',
      action({ tool: 'fs', operation: 'file_read', target: '/home/ganyu/projects/a.ts' }),
      'log',
    ],
    [
      'benign http request allows',
      action({ tool: 'http', operation: 'http_request', target: 'https://example.test/ok' }),
      'allow',
    ],
    [
      'advisory-only resource rule never fires',
      action({ tool: 'termcp', operation: 'bulk_import', target: '/whatever' }),
      'allow',
    ],
  ];

  for (const [label, actionValue, expected] of smoke) {
    assert.equal(evaluate(actionValue, rules, NOW), expected, label);
  }

  const secretRead = evaluateWithMatches(
    action({ tool: 'fs', operation: 'file_read', target: '/home/alice/.ssh/id_ed25519' }),
    rules,
    NOW,
  );
  assert.equal(secretRead.verdict, 'deny');
  assert.ok(secretRead.matched_rule_ids.includes('credential-0-1'));
  assert.ok(secretRead.matched_rule_ids.includes('side_effect-1-3'));

  const whitelistedRead = evaluateWithMatches(
    action({ tool: 'fs', operation: 'file_read', target: '/home/ganyu/projects/a.ts' }),
    rules,
    NOW,
  );
  assert.deepEqual(whitelistedRead, {
    verdict: 'log',
    matched_rule_ids: ['side_effect-1-3'],
  });
});
