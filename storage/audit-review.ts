/**
 * Read-only audit review queue for the G0 spike logs.
 *
 * This module deliberately does not evaluate rules or make go/no-go decisions.
 * It only routes already-recorded audit lines into the human review categories
 * agreed for phase A. The source logs and rules are never modified.
 */

export interface ReviewSource {
  readonly name: string;
  readonly lines: readonly string[];
}

export interface ReviewRuleInput {
  readonly id: string;
  readonly level: number;
  readonly on_hit?: string;
}

export type ReviewReason =
  | 'zero_level_hit'
  | 'non_zero_rule_deny'
  | 'confirm'
  | 'malformed_json'
  | 'parse_error'
  | 'unknown_payload'
  | 'engine_error'
  | 'snapshot_error'
  | 'unknown_rule_id'
  | 'legacy_fail_closed_no_ids'
  | 'action_invalid';

export interface ActionView {
  readonly tool: string | null;
  readonly operation: string | null;
  readonly target: string | null;
}

export interface MatchedRuleRef {
  readonly id: string;
  readonly level: number | null;
  readonly onHit: string | null;
  readonly known: boolean;
}

export interface ReviewRecord {
  readonly source: string;
  /** 1-based line number in the original source. */
  readonly line: number;
  readonly ts: string | null;
  readonly action: ActionView | null;
  readonly matchedRuleIds: readonly string[];
  readonly matchedRules: readonly MatchedRuleRef[];
  readonly verdict: string | null;
  readonly error: string | null;
  readonly reasons: readonly ReviewReason[];
  /** True only when the raw line was not valid JSON. */
  readonly malformed: boolean;
}

export interface ReviewQueue {
  /** All parsed records, sorted by source and original line. */
  readonly records: readonly ReviewRecord[];
  readonly zeroLevel: readonly ReviewRecord[];
  readonly nonZeroDeny: readonly ReviewRecord[];
  readonly confirm: {
    readonly total: number;
    readonly selected: readonly ReviewRecord[];
  };
  /** Records with at least one coverage-gap reason, sorted by source and line. */
  readonly gaps: readonly ReviewRecord[];
  readonly gapReasonCounts: Readonly<Partial<Record<ReviewReason, number>>>;
}

const CONFIRM_LIMIT = 20;

const REASON_ORDER: readonly ReviewReason[] = [
  'zero_level_hit',
  'non_zero_rule_deny',
  'confirm',
  'malformed_json',
  'parse_error',
  'unknown_payload',
  'engine_error',
  'snapshot_error',
  'unknown_rule_id',
  'legacy_fail_closed_no_ids',
  'action_invalid',
];

const GAP_REASON_ORDER: readonly ReviewReason[] = [
  'parse_error',
  'unknown_payload',
  'engine_error',
  'snapshot_error',
  'malformed_json',
  'unknown_rule_id',
  'legacy_fail_closed_no_ids',
  'action_invalid',
];

const GAP_REASONS = new Set<ReviewReason>([
  'parse_error',
  'unknown_payload',
  'engine_error',
  'snapshot_error',
  'malformed_json',
  'unknown_rule_id',
  'legacy_fail_closed_no_ids',
  'action_invalid',
]);

const AUDIT_ERROR_REASONS = new Set<ReviewReason>([
  'parse_error',
  'unknown_payload',
  'engine_error',
  'snapshot_error',
]);

const KNOWN_VERDICTS = new Set<string>(['allow', 'deny', 'confirm', 'log']);

export function buildReviewQueue(
  sources: readonly ReviewSource[],
  rules: readonly ReviewRuleInput[],
): ReviewQueue {
  const ruleMap = new Map<string, ReviewRuleInput>();
  for (const rule of rules) {
    const existing = ruleMap.get(rule.id);
    if (existing === undefined) {
      ruleMap.set(rule.id, rule);
    } else if (rule.level < existing.level) {
      ruleMap.set(rule.id, rule);
    }
  }

  const records: ReviewRecord[] = [];
  for (const source of sources) {
    let lineNumber = 0;
    for (const rawLine of source.lines) {
      lineNumber += 1;
      // A trailing newline yields a final empty element. Blank lines are not
      // audit records and are not coverage gaps.
      if (rawLine.trim().length === 0) {
        continue;
      }
      records.push(parseRecord(source.name, lineNumber, rawLine, ruleMap));
    }
  }

  // Confirm selection uses the input scan order so equal-gain ties fall back to
  // the earliest original line. Output is sorted by source+line below.
  const confirmAll = records.filter((record) =>
    record.reasons.includes('confirm'),
  );
  const selectedConfirm = selectConfirm(confirmAll).sort(compareRecords);

  records.sort(compareRecords);

  const gaps = records.filter((record) =>
    record.reasons.some((reason) => GAP_REASONS.has(reason)),
  );

  const gapReasonCounts: Partial<Record<ReviewReason, number>> = {};
  for (const record of gaps) {
    for (const reason of record.reasons) {
      if (GAP_REASONS.has(reason)) {
        gapReasonCounts[reason] = (gapReasonCounts[reason] ?? 0) + 1;
      }
    }
  }

  return {
    records,
    zeroLevel: records.filter((record) =>
      record.reasons.includes('zero_level_hit'),
    ),
    nonZeroDeny: records.filter((record) =>
      record.reasons.includes('non_zero_rule_deny'),
    ),
    confirm: {
      total: confirmAll.length,
      selected: selectedConfirm,
    },
    gaps,
    gapReasonCounts,
  };
}

function parseRecord(
  source: string,
  line: number,
  rawLine: string,
  ruleMap: ReadonlyMap<string, ReviewRuleInput>,
): ReviewRecord {
  const reasons = new Set<ReviewReason>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    // Never retain or render the raw malformed line: it may contain payload
    // contents that must not leak through the review surface.
    reasons.add('malformed_json');
    return makeRecord(source, line, reasons, true);
  }

  if (!isRecord(parsed)) {
    reasons.add('unknown_payload');
    return makeRecord(source, line, reasons, false);
  }

  const ts = typeof parsed.ts === 'string' ? parsed.ts : null;

  let action: ActionView | null = null;
  const rawAction = parsed.action;
  if (isRecord(rawAction)) {
    const tool = typeof rawAction.tool === 'string' ? rawAction.tool : null;
    const operation =
      typeof rawAction.operation === 'string' ? rawAction.operation : null;
    const target =
      typeof rawAction.target === 'string' ? rawAction.target : null;
    action = { tool, operation, target };
    if (
      tool === null ||
      operation === null ||
      target === null ||
      tool.trim().length === 0 ||
      operation.trim().length === 0 ||
      target.trim().length === 0
    ) {
      reasons.add('action_invalid');
    }
  } else {
    // Missing or non-object action is still reviewed as a parse/coverage gap.
    reasons.add('action_invalid');
  }

  const rawMatchedIds = parsed.matched_rule_ids;
  if (
    !Array.isArray(rawMatchedIds) ||
    !rawMatchedIds.every(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    )
  ) {
    reasons.add('unknown_payload');
  }

  const matchedRuleIds = Array.isArray(rawMatchedIds)
    ? rawMatchedIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      )
    : [];

  const matchedRules = matchedRuleIds.map((id): MatchedRuleRef => {
    const rule = ruleMap.get(id);
    if (rule === undefined) {
      return { id, level: null, onHit: null, known: false };
    }
    return {
      id,
      level: rule.level,
      onHit: rule.on_hit ?? null,
      known: true,
    };
  });

  if (matchedRules.some((rule) => !rule.known)) {
    reasons.add('unknown_rule_id');
  }

  const hasZeroLevelHit = matchedRules.some(
    (rule) => rule.known && rule.level === 0,
  );
  if (hasZeroLevelHit) {
    reasons.add('zero_level_hit');
  }

  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
  if (verdict === null || !KNOWN_VERDICTS.has(verdict)) {
    reasons.add('unknown_payload');
  }
  if (verdict === 'confirm') {
    reasons.add('confirm');
  }

  const hasOwnError = Object.prototype.hasOwnProperty.call(parsed, 'error');
  const error =
    typeof parsed.error === 'string' && parsed.error.length > 0
      ? parsed.error
      : null;

  if (hasOwnError) {
    if (error !== null && AUDIT_ERROR_REASONS.has(error as ReviewReason)) {
      reasons.add(error as ReviewReason);
    } else {
      reasons.add('unknown_payload');
    }
  }

  if (
    !hasOwnError &&
    (verdict === 'confirm' || verdict === 'log') &&
    matchedRuleIds.length === 0
  ) {
    reasons.add('unknown_payload');
  }

  // A legacy record has no `error` field at all. Records that explicitly say
  // `engine_error` (or any other error) must not be relabelled as legacy.
  if (
    !hasOwnError &&
    verdict === 'deny' &&
    matchedRuleIds.length === 0
  ) {
    reasons.add('legacy_fail_closed_no_ids');
  }

  // Non-zero rule deny requires at least one known matched rule, no zero-level
  // hit, and at least one non-zero known rule. deny + empty ids is never this
  // category.
  if (
    verdict === 'deny' &&
    matchedRuleIds.length > 0 &&
    !hasZeroLevelHit &&
    matchedRules.some((rule) => rule.known && rule.level !== 0)
  ) {
    reasons.add('non_zero_rule_deny');
  }

  return {
    source,
    line,
    ts,
    action,
    matchedRuleIds,
    matchedRules,
    verdict,
    error,
    reasons: orderReasons(reasons),
    malformed: false,
  };
}

function makeRecord(
  source: string,
  line: number,
  reasons: Set<ReviewReason>,
  malformed: boolean,
): ReviewRecord {
  return {
    source,
    line,
    ts: null,
    action: null,
    matchedRuleIds: [],
    matchedRules: [],
    verdict: null,
    error: null,
    reasons: orderReasons(reasons),
    malformed,
  };
}

function orderReasons(reasons: Set<ReviewReason>): ReviewReason[] {
  return REASON_ORDER.filter((reason) => reasons.has(reason));
}

function selectConfirm(records: readonly ReviewRecord[]): ReviewRecord[] {
  if (records.length <= CONFIRM_LIMIT) {
    return [...records];
  }

  const remaining = [...records];
  const selected: ReviewRecord[] = [];
  const seen = new Set<string>();

  while (selected.length < CONFIRM_LIMIT && remaining.length > 0) {
    let bestIndex = 0;
    let bestGain = -1;

    for (let index = 0; index < remaining.length; index += 1) {
      const record = remaining[index]!;
      let gain = 0;
      for (const key of coverageKeys(record)) {
        if (!seen.has(key)) {
          gain += 1;
        }
      }
      // Strictly greater: equal gain keeps the earlier original line.
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = index;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    if (picked === undefined) {
      break;
    }
    selected.push(picked);
    for (const key of coverageKeys(picked)) {
      seen.add(key);
    }
  }

  return selected;
}

function coverageKeys(record: ReviewRecord): string[] {
  const keys: string[] = [];
  const tool = record.action?.tool;
  if (typeof tool === 'string' && tool.trim().length > 0) {
    keys.push(`tool:${tool}`);
  }
  for (const id of record.matchedRuleIds) {
    keys.push(`rule:${id}`);
  }
  return keys;
}

function compareRecords(a: ReviewRecord, b: ReviewRecord): number {
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.line - b.line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function renderReviewMarkdown(queue: ReviewQueue): string {
  const gapBreakdown =
    GAP_REASON_ORDER.filter(
      (reason) => (queue.gapReasonCounts[reason] ?? 0) > 0,
    )
      .map(
        (reason) =>
          `${code(reason)} ${queue.gapReasonCounts[reason] ?? 0} 条`,
      )
      .join('、') || '（无）';

  const sections = [
    renderSection('0 层规则命中（全量）', queue.zeroLevel),
    renderSection('非 0 层规则 deny（全量）', queue.nonZeroDeny),
    renderSection('错误与覆盖缺口（全量）', queue.gaps),
    renderConfirmSection(queue),
  ];

  return [
    '# Atmos 阶段 A 人工审核工作表',
    '',
    '> **这是从原始 JSONL 派生的人审工作表，不是自动审核结论，也不是自动放行。**',
    '> 所有“结论”和“说明”必须由人填写；生成器只读事实源，不会修改日志或规则。',
    '',
    '## 汇总',
    '',
    '| 项目 | 数量 |',
    '| --- | --- |',
    `| 日志记录总数 | ${queue.records.length} |`,
    `| 0 层规则命中（全量） | ${queue.zeroLevel.length} |`,
    `| 非 0 层规则 deny（全量） | ${queue.nonZeroDeny.length} |`,
    `| 错误/覆盖缺口（全量、去重） | ${queue.gaps.length} |`,
    `| confirm 总数 | ${queue.confirm.total} |`,
    `| confirm 选中 | ${queue.confirm.selected.length} |`,
    '',
    `覆盖缺口分类：${gapBreakdown}`,
    '',
    ...sections,
  ].join('\n');
}

function renderConfirmSection(queue: ReviewQueue): string {
  const note =
    queue.confirm.total > queue.confirm.selected.length
      ? '> confirm 超过 20 条：按不同 action.tool 与 matched rule id 做确定性覆盖优先选择，等覆盖增益时取原始行更早者，最终按 source+line 排序。\n\n'
      : '';
  return `${note}${renderSection(
    `confirm（共 ${queue.confirm.total} 条，选中 ${queue.confirm.selected.length} 条）`,
    queue.confirm.selected,
  )}`;
}

function renderSection(
  title: string,
  records: readonly ReviewRecord[],
): string {
  const body =
    records.length === 0
      ? '_（无）_'
      : records.map((record) => renderRecord(record)).join('\n\n');
  return `## ${title}\n\n${body}\n`;
}

function renderRecord(record: ReviewRecord): string {
  const location = `${record.source}:${record.line}`;
  const lines = [
    `### ${code(location)}`,
    '',
    `- source:line: ${code(location)}`,
    `- ts: ${record.ts === null ? '—' : code(record.ts)}`,
    `- action: ${renderAction(record.action)}`,
    `- matched: ${renderMatched(record.matchedRules)}`,
    `- verdict: ${record.verdict === null ? '—' : code(record.verdict)}`,
    `- error: ${record.error === null ? '—' : code(record.error)}`,
    `- 原因: ${
      record.reasons.length === 0
        ? '—'
        : record.reasons.map((reason) => code(reason)).join('、')
    }`,
  ];

  if (record.malformed) {
    lines.push(
      '- 说明: 原始行不是合法 JSON；为避免泄露原文，生成器不回显该行内容。',
    );
  }

  lines.push(
    '',
    '- [ ] 已审核',
    '- 结论（人填）：',
    '- 说明（人填）：',
  );

  return lines.join('\n');
}

function renderAction(action: ActionView | null): string {
  if (action === null) {
    return '（无 action）';
  }
  return `${renderActionField(action.tool)} / ${renderActionField(
    action.operation,
  )} → ${renderActionField(action.target)}`;
}

function renderActionField(value: string | null): string {
  if (value === null) {
    return '（缺失）';
  }
  if (value.trim().length === 0) {
    return '（空）';
  }
  return code(value);
}

function renderMatched(rules: readonly MatchedRuleRef[]): string {
  if (rules.length === 0) {
    return '（无命中规则）';
  }
  return rules
    .map((rule) => {
      if (!rule.known) {
        return `${code(rule.id)}（未知规则）`;
      }
      return `${code(rule.id)}（level ${rule.level}，on_hit ${code(
        rule.onHit ?? 'unknown',
      )}）`;
    })
    .join('、');
}

function code(value: string): string {
  const singleLine = value.replace(/\r?\n/g, '\\n').replace(/`/g, '\\`');
  return `\`${singleLine}\``;
}
