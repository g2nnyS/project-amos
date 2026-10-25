import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function auditLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-10-24T00:00:00.000Z',
    action: {
      tool: 'read',
      operation: 'file_read',
      target: '/home/ganyu/projects/project-atmos/README.md',
    },
    matched_rule_ids: [],
    verdict: 'allow',
    latency_ms: 1,
    ...overrides,
  });
}

function source(name: string, lines: string[]): ReviewSource {
  return { name, lines };
}

function makeTempDir(): string {
  mkdirSync('/tmp/opencode', { recursive: true });
  return mkdtempSync(join('/tmp/opencode', 'atmos-audit-review-'));
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
        auditLine({ matched_rule_ids: [], verdict: 'deny' }),
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
      [1, ['legacy_fail_closed_no_ids']],
      [2, ['engine_error']],
      [3, ['unknown_rule_id']],
    ],
  );
  assert.equal(
    queue.records[0]?.reasons.includes('non_zero_rule_deny'),
    false,
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
        target: `/home/ganyu/projects/project-atmos/file-${index}.md`,
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
