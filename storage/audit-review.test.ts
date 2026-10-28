import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildReviewQueue,
  renderReviewMarkdown,
  type ReviewRuleInput,
  type ReviewSource,
} from './audit-review.ts';
import {
  parseReviewCliArgs,
  runReviewCli,
} from './audit-review-cli.ts';

const BASE_RULES: ReviewRuleInput[] = [
  { id: 'zero-a', level: 0, on_hit: 'deny' },
  { id: 'zero-b', level: 0, on_hit: 'deny' },
  { id: 'one-deny', level: 1, on_hit: 'deny' },
  { id: 'one-confirm', level: 1, on_hit: 'confirm' },
  { id: 'one-log', level: 1, on_hit: 'log' },
];

function ruleMeta(
  id: string,
  level: number,
  onHit: string | null,
): Record<string, unknown> {
  return {
    id,
    dimension: 'filesystem',
    level,
    policy_class: 'security',
    enforcement: 'runtime',
    on_hit: onHit,
  };
}

const BASE_METADATA = new Map<string, Record<string, unknown>>(
  BASE_RULES.map((rule) => [
    rule.id,
    ruleMeta(rule.id, rule.level, rule.on_hit ?? null),
  ]),
);

function metadataFor(
  ids: unknown,
  table: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.flatMap((id) => {
    if (typeof id !== 'string') {
      return [];
    }
    const meta = table.get(id);
    return meta === undefined ? [] : [meta];
  });
}

function defaultDecision(line: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(line, 'error')) {
    return 'error';
  }
  if (Array.isArray(line.matched_rule_ids) && line.matched_rule_ids.length > 0) {
    return 'matched';
  }
  return 'no_match';
}

function auditLine(overrides: Record<string, unknown> = {}): string {
  const line: Record<string, unknown> = {
    schema_version: 2,
    ts: '2026-10-24T00:00:00.000Z',
    action: {
      tool: 'read',
      operation: 'file_read',
      target: '/home/test-user/projects/project-amos/README.md',
    },
    matched_rule_ids: [],
    verdict: 'allow',
    snapshot_digest: 'sha256:test-snapshot',
    mode: 'log-only',
    latency_ms: 1,
    ...overrides,
  };

  if (!Object.prototype.hasOwnProperty.call(overrides, 'matched_rules')) {
    line.matched_rules = metadataFor(line.matched_rule_ids, BASE_METADATA);
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'decision')) {
    line.decision = defaultDecision(line);
  }

  return JSON.stringify(line);
}

function legacyAuditLine(overrides: Record<string, unknown> = {}): string {
  const line = JSON.parse(auditLine(overrides)) as Record<string, unknown>;
  delete line.matched_rules;
  delete line.decision;
  delete line.snapshot_digest;
  line.schema_version = 1;
  return JSON.stringify(line);
}

function source(name: string, lines: string[]): ReviewSource {
  return { name, lines };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'amos-audit-review-'));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

test('routes zero-level, non-zero deny, confirm and error records', () => {
  const queue = buildReviewQueue(
    [
      source('audit.jsonl', [
        auditLine({ matched_rule_ids: ['zero-a'], verdict: 'deny' }),
        auditLine({ matched_rule_ids: ['one-deny'], verdict: 'deny' }),
        auditLine({ matched_rule_ids: ['one-confirm'], verdict: 'confirm' }),
        auditLine({
          matched_rule_ids: [],
          verdict: 'deny',
          error: 'engine_error',
        }),
        auditLine({ verdict: 'allow' }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(
    queue.zeroLevel.map((record) => record.line),
    [1],
  );
  assert.deepEqual(
    queue.nonZeroDeny.map((record) => record.line),
    [2],
  );
  assert.equal(queue.confirm.total, 1);
  assert.deepEqual(
    queue.confirm.selected.map((record) => record.line),
    [3],
  );
  assert.deepEqual(
    queue.gaps.map((record) => record.line),
    [4],
  );
  assert.deepEqual(queue.gaps[0]?.reasons, ['engine_error']);
});

test('empty-hit legacy deny is a gap, not a non-zero rule deny', () => {
  const queue = buildReviewQueue(
    [
      source('legacy.jsonl', [
        legacyAuditLine({ matched_rule_ids: [], verdict: 'deny' }),
        auditLine({
          matched_rule_ids: [],
          verdict: 'deny',
          error: 'engine_error',
        }),
        auditLine({ matched_rule_ids: ['ghost-rule'], verdict: 'deny' }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(queue.nonZeroDeny, []);
  assert.deepEqual(
    queue.gaps.map((record) => [record.line, record.reasons]),
    [
      [1, ['rule_metadata_missing', 'legacy_fail_closed_no_ids']],
      [2, ['engine_error']],
      [3, ['unknown_rule_id']],
    ],
  );
  assert.equal(
    queue.records[0]?.reasons.includes('non_zero_rule_deny'),
    false,
  );
});

test('v2 no-match default deny is an explicit coverage gap, not a legacy record', () => {
  const queue = buildReviewQueue(
    [
      source('no-match.jsonl', [
        auditLine({ matched_rule_ids: [], verdict: 'deny' }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(queue.records[0]?.reasons, ['no_match_default_deny']);
  assert.equal(
    queue.records[0]?.reasons.includes('legacy_fail_closed_no_ids'),
    false,
  );
});

test('unknown error types, invalid verdicts, non-array matched_rule_ids and empty-match confirm/log enter gaps', () => {
  const queue = buildReviewQueue(
    [
      source('corrupted.jsonl', [
        auditLine({ matched_rule_ids: [], verdict: 'deny', error: 'weird_error' }),
        auditLine({ matched_rule_ids: [], verdict: 'deny', error: '' }),
        auditLine({ matched_rule_ids: [], verdict: 'block' }),
        auditLine({ matched_rule_ids: 'not-an-array', verdict: 'allow' }),
        auditLine({ matched_rule_ids: [], verdict: 'confirm' }),
        auditLine({ matched_rule_ids: [], verdict: 'log' }),
      ]),
    ],
    BASE_RULES,
  );

  assert.equal(queue.gaps.length, 6);
  for (const record of queue.gaps) {
    assert.equal(record.reasons.includes('unknown_payload'), true, `line ${record.line}`);
  }
});

test('v2 decision, coverage, schema version and error shapes must agree', () => {
  const queue = buildReviewQueue(
    [
      source('inconsistent.jsonl', [
        auditLine({
          matched_rule_ids: [],
          matched_rules: [],
          decision: 'matched',
          verdict: 'allow',
        }),
        auditLine({
          matched_rule_ids: ['one-log'],
          decision: 'no_match',
          verdict: 'allow',
        }),
        auditLine({ matched_rule_ids: [], decision: 'error', verdict: 'deny' }),
        auditLine({
          matched_rule_ids: [],
          decision: 'no_match',
          verdict: 'allow',
          error: 'engine_error',
        }),
        auditLine({
          matched_rule_ids: [],
          decision: 'not_evaluated',
          verdict: null,
          coverage: { reason: 'unsupported_tool' },
        }),
        auditLine({
          matched_rule_ids: [],
          decision: 'no_match',
          verdict: 'allow',
          schema_version: 99,
        }),
        auditLine({
          matched_rule_ids: [],
          decision: 'no_match',
          verdict: 'allow',
          snapshot_digest: 7,
        }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(
    queue.records.map((record) => record.reasons.includes('unknown_payload')),
    [true, true, true, true, true, true, true],
  );
});

test('malformed JSON and incomplete action enter gaps without leaking source text', () => {
  const secret = '{"token":"SUPER_SECRET_TOKEN"';
  const queue = buildReviewQueue(
    [
      source('broken.jsonl', [
        secret,
        auditLine({
          action: { tool: 'read', operation: 'file_read', target: '' },
          verdict: 'allow',
        }),
        auditLine({
          action: { tool: 'read', operation: 'file_read' },
          verdict: 'allow',
        }),
        auditLine({ action: undefined, verdict: 'allow' }),
      ]),
    ],
    BASE_RULES,
  );

  const malformed = queue.records[0];
  assert.equal(malformed?.malformed, true);
  assert.equal(malformed?.action, null);
  assert.deepEqual(malformed?.reasons, ['malformed_json']);
  assert.deepEqual(
    queue.gaps.map((record) => [record.line, record.reasons]),
    [
      [1, ['malformed_json']],
      [2, ['action_invalid']],
      [3, ['action_invalid']],
      [4, ['action_invalid']],
    ],
  );

  const markdown = renderReviewMarkdown(queue);
  assert.equal(JSON.stringify(queue).includes('SUPER_SECRET_TOKEN'), false);
  assert.equal(markdown.includes('SUPER_SECRET_TOKEN'), false);
  assert.equal(markdown.includes('原始行不是合法 JSON'), true);
});

test('unknown rule ids and category labels can overlap', () => {
  const queue = buildReviewQueue(
    [
      source('overlap.jsonl', [
        auditLine({ matched_rule_ids: ['zero-a'], verdict: 'confirm' }),
        auditLine({
          matched_rule_ids: ['zero-a', 'one-deny'],
          verdict: 'deny',
        }),
        auditLine({
          matched_rule_ids: ['one-deny', 'ghost-rule'],
          verdict: 'deny',
        }),
        auditLine({
          matched_rule_ids: ['zero-b'],
          verdict: 'deny',
          error: 'snapshot_error',
        }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(
    queue.zeroLevel.map((record) => record.line),
    [1, 2, 4],
  );
  assert.deepEqual(
    queue.nonZeroDeny.map((record) => record.line),
    [3],
  );
  assert.deepEqual(
    queue.confirm.selected.map((record) => record.line),
    [1],
  );
  assert.deepEqual(
    queue.gaps.map((record) => record.line),
    [3, 4],
  );

  assert.equal(
    queue.records[1]?.reasons.includes('non_zero_rule_deny'),
    false,
  );
  assert.equal(
    queue.records[2]?.reasons.includes('unknown_rule_id'),
    true,
  );
  assert.equal(
    queue.records[3]?.reasons.includes('snapshot_error'),
    true,
  );

  const markdown = renderReviewMarkdown(queue);
  assert.equal(markdown.includes('ghost-rule'), true);
  assert.equal(markdown.includes('未知规则'), true);
});

test('confirm selects every record at the 20-record boundary', () => {
  const lines = Array.from({ length: 20 }, (_, index) =>
    auditLine({
      action: {
        tool: 'read',
        operation: 'file_read',
        target: `/home/test-user/projects/project-amos/file-${index}.md`,
      },
      matched_rule_ids: ['one-confirm'],
      verdict: 'confirm',
    }),
  );

  const queue = buildReviewQueue([source('confirm-20.jsonl', lines)], BASE_RULES);

  assert.equal(queue.confirm.total, 20);
  assert.equal(queue.confirm.selected.length, 20);
  assert.deepEqual(
    queue.confirm.selected.map((record) => record.line),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});

test('confirm over 20 keeps exactly 20 with tool and rule coverage first', () => {
  const rules: ReviewRuleInput[] = [
    { id: 'r1', level: 1, on_hit: 'confirm' },
    { id: 'r2', level: 1, on_hit: 'confirm' },
    { id: 'r3', level: 1, on_hit: 'confirm' },
    { id: 'r4', level: 1, on_hit: 'confirm' },
  ];

  const lines: string[] = [];
  for (let index = 0; index < 18; index += 1) {
    lines.push(
      auditLine({
        action: {
          tool: 'tool-shared',
          operation: 'file_read',
          target: `/tmp/shared-${index}`,
        },
        matched_rule_ids: ['r1'],
        matched_rules: [ruleMeta('r1', 1, 'confirm')],
        verdict: 'confirm',
      }),
    );
  }
  for (const [tool, rule] of [
    ['tool-b', 'r2'],
    ['tool-c', 'r3'],
    ['tool-d', 'r4'],
  ] as const) {
    lines.push(
      auditLine({
        action: { tool, operation: 'file_read', target: `/tmp/${tool}` },
        matched_rule_ids: [rule],
        matched_rules: [ruleMeta(rule, 1, 'confirm')],
        verdict: 'confirm',
      }),
    );
  }

  const first = buildReviewQueue(
    [source('confirm-many.jsonl', lines)],
    rules,
  );
  const second = buildReviewQueue(
    [source('confirm-many.jsonl', lines)],
    rules,
  );

  assert.equal(first.confirm.total, 21);
  assert.equal(first.confirm.selected.length, 20);
  assert.deepEqual(
    first.confirm.selected.map((record) => record.line),
    second.confirm.selected.map((record) => record.line),
  );

  const selectedLines = first.confirm.selected.map((record) => record.line);
  assert.deepEqual(
    selectedLines,
    [...selectedLines].sort((a, b) => a - b),
  );
  assert.equal(selectedLines.includes(1), true);
  assert.equal(selectedLines.includes(19), true);
  assert.equal(selectedLines.includes(20), true);
  assert.equal(selectedLines.includes(21), true);

  const markdown = renderReviewMarkdown(first);
  assert.match(markdown, /确定性覆盖选择/);
  assert.equal(markdown.includes('分层抽样'), false);
  assert.equal(markdown.includes('统计推断'), true);

  const tools = new Set(
    first.confirm.selected.map((record) => record.action?.tool),
  );
  const ruleIds = new Set(
    first.confirm.selected.flatMap((record) => record.matchedRuleIds),
  );
  assert.deepEqual(
    [...tools].sort(),
    ['tool-b', 'tool-c', 'tool-d', 'tool-shared'],
  );
  assert.deepEqual([...ruleIds].sort(), ['r1', 'r2', 'r3', 'r4']);
});

test('building a queue does not modify sources or rules', () => {
  const sources: ReviewSource[] = [
    source('immutable.jsonl', [
      auditLine({ matched_rule_ids: ['zero-a'], verdict: 'deny' }),
      auditLine({ matched_rule_ids: ['one-confirm'], verdict: 'confirm' }),
    ]),
  ];
  const rules: ReviewRuleInput[] = [...BASE_RULES];
  const sourcesBefore = structuredClone(sources);
  const rulesBefore = structuredClone(rules);

  deepFreeze(sources);
  deepFreeze(rules);
  assert.doesNotThrow(() => buildReviewQueue(sources, rules));

  assert.deepEqual(sources, sourcesBefore);
  assert.deepEqual(rules, rulesBefore);
});

test('legacy entries without matched_rules fall back to current rules and record the gap', () => {
  const queue = buildReviewQueue(
    [
      source('legacy.jsonl', [
        legacyAuditLine({ matched_rule_ids: ['one-deny'], verdict: 'deny' }),
        legacyAuditLine({ matched_rule_ids: ['zero-a'], verdict: 'deny' }),
        legacyAuditLine({ matched_rule_ids: [], verdict: 'allow' }),
        legacyAuditLine({ matched_rule_ids: ['ghost-rule'], verdict: 'deny' }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(
    queue.records.map((record) => [record.line, record.reasons]),
    [
      [1, ['non_zero_rule_deny', 'rule_metadata_missing']],
      [2, ['zero_level_hit', 'rule_metadata_missing']],
      [3, ['rule_metadata_missing']],
      [4, ['unknown_rule_id', 'rule_metadata_missing']],
    ],
  );
  assert.deepEqual(queue.records[0]?.matchedRules, [
    { id: 'one-deny', level: 1, onHit: 'deny', known: true },
  ]);
  assert.equal(queue.records[0]?.snapshotDigest, null);
  assert.equal(queue.records[0]?.decision, null);
  assert.equal(queue.gapReasonCounts.rule_metadata_missing, 4);
  assert.deepEqual(
    queue.nonZeroDeny.map((record) => record.line),
    [1],
  );
  assert.deepEqual(
    queue.zeroLevel.map((record) => record.line),
    [2],
  );

  const markdown = renderReviewMarkdown(queue);
  assert.match(markdown, /rule_metadata_missing/);
  assert.match(markdown, /- snapshot: —/);
});

test('historical matched_rules metadata wins over the current rule table', () => {
  const queue = buildReviewQueue(
    [
      source('history.jsonl', [
        // Current table says zero-a is level 0 deny; the snapshot said level 2
        // log. Classification must follow the embedded snapshot metadata.
        auditLine({
          matched_rule_ids: ['zero-a'],
          matched_rules: [ruleMeta('zero-a', 2, 'log')],
          verdict: 'allow',
          decision: 'matched',
        }),
        // Current table says one-deny is level 1; the snapshot said level 0.
        auditLine({
          matched_rule_ids: ['one-deny'],
          matched_rules: [ruleMeta('one-deny', 0, 'deny')],
          verdict: 'deny',
          decision: 'matched',
        }),
        // A rule no longer present in the current table is still known from
        // the snapshot metadata; it must not become unknown_rule_id.
        auditLine({
          matched_rule_ids: ['removed-rule'],
          matched_rules: [ruleMeta('removed-rule', 0, 'deny')],
          verdict: 'deny',
          decision: 'matched',
        }),
      ]),
    ],
    BASE_RULES,
  );

  const [historical, current, removed] = queue.records;
  assert.deepEqual(historical?.matchedRules, [
    { id: 'zero-a', level: 2, onHit: 'log', known: true },
  ]);
  assert.equal(historical?.reasons.includes('zero_level_hit'), false);
  assert.equal(
    historical?.reasons.includes('rule_metadata_missing'),
    false,
  );
  assert.deepEqual(historical?.reasons, []);

  // Using the live table would have marked this as a level-1 deny.
  assert.deepEqual(current?.matchedRules, [
    { id: 'one-deny', level: 0, onHit: 'deny', known: true },
  ]);
  assert.deepEqual(current?.reasons, ['zero_level_hit']);
  assert.equal(current?.reasons.includes('non_zero_rule_deny'), false);

  assert.deepEqual(removed?.matchedRules, [
    { id: 'removed-rule', level: 0, onHit: 'deny', known: true },
  ]);
  assert.deepEqual(removed?.reasons, ['zero_level_hit']);
  assert.equal(removed?.reasons.includes('unknown_rule_id'), false);
});

test('valid not_evaluated coverage entries are coverage gaps, not unknown payload', () => {
  const queue = buildReviewQueue(
    [
      source('coverage.jsonl', [
        auditLine({
          matched_rule_ids: [],
          verdict: null,
          decision: 'not_evaluated',
          coverage: { reason: 'unsupported_tool', confirmation_eligible: true },
        }),
        auditLine({
          matched_rule_ids: [],
          verdict: null,
          decision: 'not_evaluated',
          coverage: { reason: 'opaque_action', confirmation_eligible: false },
        }),
        auditLine({
          matched_rule_ids: [],
          verdict: null,
          decision: 'not_evaluated',
          coverage: { reason: 'sampled', confirmation_eligible: false },
        }),
        auditLine({
          matched_rule_ids: [],
          verdict: null,
          decision: 'not_evaluated',
        }),
        auditLine({
          matched_rule_ids: [],
          verdict: null,
          decision: 'skipped',
        }),
        auditLine({
          matched_rule_ids: [],
          verdict: 'allow',
          decision: 'not_evaluated',
          coverage: { reason: 'unsupported_tool', confirmation_eligible: true },
        }),
      ]),
    ],
    BASE_RULES,
  );

  assert.deepEqual(
    queue.records.map((record) => [record.line, record.reasons]),
    [
      [1, ['not_evaluated']],
      [2, ['not_evaluated']],
      [3, ['unknown_payload']],
      [4, ['unknown_payload']],
      [5, ['unknown_payload']],
      [6, ['unknown_payload']],
    ],
  );
  assert.equal(queue.records[0]?.coverage?.reason, 'unsupported_tool');
  assert.equal(queue.records[0]?.coverage?.confirmationEligible, true);
  assert.equal(queue.records[1]?.coverage?.confirmationEligible, false);
  assert.equal(
    queue.records[0]?.reasons.includes('unknown_payload'),
    false,
  );
  assert.deepEqual(
    queue.gaps.map((record) => record.line),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(queue.gapReasonCounts.not_evaluated, 2);

  const markdown = renderReviewMarkdown(queue);
  assert.match(markdown, /not_evaluated/);
  assert.match(markdown, /unsupported_tool/);
  assert.match(markdown, /confirmation_eligible true/);
  assert.match(markdown, /confirmation_eligible false/);
});

test('markdown encodes adversarial untrusted fields into inert single code spans', () => {
  const evil =
    'a`b``c [x](https://evil) <img src=x onerror=alert(1)> & <script>alert(1)</script>\nline2\rline3\0nul\u2028sep';
  const evilId = 'rule`<b>&"\\';
  const evilSource = 'src`<i>&.jsonl';

  const queue = buildReviewQueue(
    [
      source(evilSource, [
        auditLine({
          ts: evil,
          action: { tool: evil, operation: evil, target: evil },
          matched_rule_ids: [evilId],
          matched_rules: [ruleMeta(evilId, 1, evil)],
          verdict: 'confirm',
          decision: 'matched',
          snapshot_digest: evil,
          error: evil,
        }),
      ]),
    ],
    BASE_RULES,
  );

  const markdown = renderReviewMarkdown(queue);

  // No raw HTML, entity or control character survives.
  assert.equal(markdown.includes('<img'), false);
  assert.equal(markdown.includes('<script'), false);
  assert.equal(markdown.toLowerCase().includes('<b>'), false);
  assert.equal(markdown.includes('&'), false);
  assert.equal(markdown.includes('\0'), false);
  assert.equal(markdown.includes('\r'), false);
  assert.equal(markdown.includes('\u2028'), false);

  // Backticks and HTML-significant characters are Unicode-escaped.
  assert.equal(markdown.includes('\\u0060'), true);
  assert.equal(markdown.includes('\\u003c'), true);
  assert.equal(markdown.includes('\\u003e'), true);
  assert.equal(markdown.includes('\\u0026'), true);

  // Values are flattened onto one line rather than injected as new lines.
  assert.equal(markdown.includes('\\n'), true);
  assert.equal(markdown.includes('\\r'), true);
  assert.equal(markdown.includes('\\u0000'), true);
  assert.equal(markdown.includes('\\u2028'), true);

  // Every rendered line keeps balanced single-backtick spans.
  for (const [index, renderedLine] of markdown.split('\n').entries()) {
    const ticks = renderedLine.match(/`/g)?.length ?? 0;
    assert.equal(
      ticks % 2,
      0,
      `line ${index + 1} has unbalanced backticks: ${renderedLine}`,
    );
  }
});

test('markdown includes summary counts and human review fields', () => {
  const queue = buildReviewQueue(
    [
      source('review.jsonl', [
        auditLine({ matched_rule_ids: ['zero-a'], verdict: 'confirm' }),
        auditLine({ matched_rule_ids: ['one-deny'], verdict: 'deny' }),
        auditLine({
          matched_rule_ids: [],
          verdict: 'deny',
          error: 'engine_error',
        }),
        '{"not":"valid json"',
      ]),
    ],
    BASE_RULES,
  );

  const markdown = renderReviewMarkdown(queue);

  assert.match(markdown, /## 0 层规则命中（全量）/);
  assert.match(markdown, /## 非 0 层规则 deny（全量）/);
  assert.match(markdown, /## 错误与覆盖缺口（全量）/);
  assert.match(markdown, /## confirm（共 1 条，选中 1 条）/);
  assert.match(markdown, /不是自动放行/);
  assert.match(markdown, /source:line: `review\.jsonl:1`/);
  assert.match(markdown, /level 0/);
  assert.match(markdown, /- decision: `matched`/);
  assert.match(markdown, /- snapshot: `sha256:test-snapshot`/);
  assert.match(markdown, /- coverage: —/);
  assert.match(markdown, /error: `engine_error`/);
  assert.match(markdown, /- \[ \] 已审核/);
  assert.match(markdown, /- 结论（人填）：/);
  assert.match(markdown, /- 说明（人填）：/);
  assert.match(markdown, /confirm 总数 \| 1 \|/);
});

test('CLI writes a new worksheet and refuses to overwrite inputs or outputs', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const rulesPath = join(dir, 'rules.yaml');
  const logPath = join(dir, 'audit.jsonl');
  const outputPath = join(dir, 'nested', 'review.md');

  const rulesText = '- id: zero-a\n  level: 0\n  on_hit: deny\n';
  const logText = `${auditLine({
    matched_rule_ids: ['zero-a'],
    verdict: 'deny',
  })}\n`;
  writeFileSync(rulesPath, rulesText, 'utf8');
  writeFileSync(logPath, logText, 'utf8');

  runReviewCli([
    '--rules',
    rulesPath,
    '--log',
    logPath,
    '--output',
    outputPath,
  ]);

  const markdown = readFileSync(outputPath, 'utf8');
  assert.match(markdown, /人工审核工作表/);
  assert.match(markdown, /zero-a/);
  assert.match(markdown, /snapshot: `sha256:test-snapshot`/);

  assert.throws(
    () =>
      runReviewCli([
        '--rules',
        rulesPath,
        '--log',
        logPath,
        '--output',
        outputPath,
      ]),
    /exists|overwrite/i,
  );
  assert.equal(readFileSync(outputPath, 'utf8'), markdown);

  assert.throws(
    () =>
      runReviewCli([
        '--rules',
        rulesPath,
        '--log',
        logPath,
        '--output',
        rulesPath,
      ]),
    /refusing to write output over the rules/i,
  );
  assert.throws(
    () =>
      runReviewCli([
        '--rules',
        rulesPath,
        '--log',
        logPath,
        '--output',
        logPath,
      ]),
    /refusing to write output over a log/i,
  );
  assert.throws(
    () => parseReviewCliArgs(['--rules', rulesPath, '--log', logPath]),
    /missing required --output/,
  );

  assert.equal(readFileSync(logPath, 'utf8'), logText);
  assert.equal(readFileSync(rulesPath, 'utf8'), rulesText);
});
