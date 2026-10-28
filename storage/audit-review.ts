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
  | 'not_evaluated'
  | 'engine_error'
  | 'snapshot_error'
  | 'unknown_rule_id'
  | 'rule_metadata_missing'
  | 'no_match_default_deny'
  | 'legacy_fail_closed_no_ids'
  | 'action_invalid';

export interface ActionView {
  readonly tool: string | null;
  readonly operation: string | null;
  readonly target: string | null;
}

export interface MatchedRuleRef {
  readonly id: string;
  /** Level recorded in the entry's snapshot metadata (or current rules for
   * legacy entries); never re-derived from the live rule table when the entry
   * carries its own metadata. */
  readonly level: number | null;
  readonly onHit: string | null;
  readonly known: boolean;
}

export type CoverageReason =
  | 'unsupported_tool'
  | 'opaque_action'
  | 'unstructured_tool';

export interface ReviewCoverage {
  readonly reason: CoverageReason | null;
  readonly confirmationEligible: boolean | null;
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
  readonly decision: string | null;
  readonly snapshotDigest: string | null;
  readonly coverage: ReviewCoverage | null;
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
  'not_evaluated',
  'engine_error',
  'snapshot_error',
  'unknown_rule_id',
  'rule_metadata_missing',
  'no_match_default_deny',
  'legacy_fail_closed_no_ids',
  'action_invalid',
];

const GAP_REASON_ORDER: readonly ReviewReason[] = [
  'parse_error',
  'unknown_payload',
  'not_evaluated',
  'engine_error',
  'snapshot_error',
  'malformed_json',
  'unknown_rule_id',
  'rule_metadata_missing',
  'no_match_default_deny',
  'legacy_fail_closed_no_ids',
  'action_invalid',
];

const GAP_REASONS = new Set<ReviewReason>([
  'parse_error',
  'unknown_payload',
  'not_evaluated',
  'engine_error',
  'snapshot_error',
  'malformed_json',
  'unknown_rule_id',
  'rule_metadata_missing',
  'no_match_default_deny',
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

const KNOWN_DECISIONS = new Set<string>([
  'matched',
  'no_match',
  'error',
  'not_evaluated',
]);

const KNOWN_COVERAGE_REASONS = new Set<string>([
  'unsupported_tool',
  'opaque_action',
  'unstructured_tool',
]);

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

  // Rule provenance comes from the metadata embedded in the log entry. The
  // live rule table is only a fallback for legacy entries that predate it, and
  // those entries are recorded as a coverage gap rather than silently trusting
  // today's rules.
  const metadata = parseMatchedRuleMetadata(parsed.matched_rules);
  if (metadata.malformed) {
    reasons.add('unknown_payload');
  }
  if (!metadata.present) {
    reasons.add('rule_metadata_missing');
  }

  const matchedRules = matchedRuleIds.map((id): MatchedRuleRef => {
    if (metadata.present) {
      const rule = metadata.byId.get(id);
      if (rule === undefined) {
        // The entry carries snapshot metadata but it does not describe this
        // id: do not borrow level/on_hit from the current rule table.
        return { id, level: null, onHit: null, known: false };
      }
      return {
        id,
        level: rule.level,
        onHit: rule.onHit,
        known: true,
      };
    }

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

  const hasCoverage =
    Object.prototype.hasOwnProperty.call(parsed, 'coverage') &&
    parsed.coverage !== null;
  const coverage = parseCoverage(parsed.coverage);
  if (hasCoverage && !coverage.valid) {
    reasons.add('unknown_payload');
  }

  const decision =
    typeof parsed.decision === 'string' ? parsed.decision : null;
  const hasDecision = Object.prototype.hasOwnProperty.call(
    parsed,
    'decision',
  );
  if (hasDecision && (decision === null || !KNOWN_DECISIONS.has(decision))) {
    reasons.add('unknown_payload');
  }

  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(
    parsed,
    'schema_version',
  );
  if (
    hasSchemaVersion &&
    parsed.schema_version !== 1 &&
    parsed.schema_version !== 2
  ) {
    reasons.add('unknown_payload');
  }

  const hasSnapshotDigest = Object.prototype.hasOwnProperty.call(
    parsed,
    'snapshot_digest',
  );
  if (
    hasSnapshotDigest &&
    parsed.snapshot_digest !== null &&
    typeof parsed.snapshot_digest !== 'string'
  ) {
    reasons.add('unknown_payload');
  }

  if (
    Object.prototype.hasOwnProperty.call(parsed, 'mode') &&
    parsed.mode !== 'log-only'
  ) {
    reasons.add('unknown_payload');
  }

  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
  if (decision === 'not_evaluated') {
    // A not-evaluated record is identifiable by `verdict: null` plus a valid
    // coverage annotation. It is a coverage gap in its own right, not a
    // malformed payload.
    if (verdict === null && coverage.valid) {
      reasons.add('not_evaluated');
    } else {
      reasons.add('unknown_payload');
    }
  } else if (verdict === null || !KNOWN_VERDICTS.has(verdict)) {
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
    hasDecision &&
    ((decision === 'matched' && matchedRuleIds.length === 0) ||
      (decision === 'no_match' && matchedRuleIds.length > 0) ||
      (decision === 'error' && !hasOwnError) ||
      (decision !== 'error' && hasOwnError))
  ) {
    reasons.add('unknown_payload');
  }

  if (
    !hasOwnError &&
    (verdict === 'confirm' || verdict === 'log') &&
    matchedRuleIds.length === 0
  ) {
    reasons.add('unknown_payload');
  }

  // A new no_match record uses the recorder's explicit default-deny policy.
  // It is a coverage gap, not the legacy shape that predates decision kinds.
  if (
    hasDecision &&
    decision === 'no_match' &&
    verdict === 'deny' &&
    matchedRuleIds.length === 0
  ) {
    reasons.add('no_match_default_deny');
  }

  // A legacy record has no `error` field or decision kind at all. Records that
  // explicitly say `engine_error` (or any other error) must not be relabelled
  // as legacy.
  if (
    !hasOwnError &&
    !hasDecision &&
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
    decision,
    snapshotDigest:
      typeof parsed.snapshot_digest === 'string'
        ? parsed.snapshot_digest
        : null,
    coverage: coverage.view,
    error,
    reasons: orderReasons(reasons),
    malformed: false,
  };
}

interface ParsedRuleMetadata {
  readonly id: string;
  readonly level: number;
  readonly onHit: string | null;
}

interface MatchedRuleMetadata {
  /** True when the entry has a `matched_rules` field at all. */
  readonly present: boolean;
  /** True when `matched_rules` is present but is not a valid metadata array. */
  readonly malformed: boolean;
  readonly byId: ReadonlyMap<string, ParsedRuleMetadata>;
}

function parseMatchedRuleMetadata(raw: unknown): MatchedRuleMetadata {
  if (raw === undefined || raw === null) {
    return { present: false, malformed: false, byId: new Map() };
  }
  if (!Array.isArray(raw)) {
    return { present: true, malformed: true, byId: new Map() };
  }

  const byId = new Map<string, ParsedRuleMetadata>();
  let malformed = false;
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      entry.id.trim().length === 0 ||
      typeof entry.dimension !== 'string' ||
      entry.dimension.trim().length === 0 ||
      typeof entry.level !== 'number' ||
      !Number.isInteger(entry.level) ||
      entry.level < 0 ||
      (entry.policy_class !== 'security' &&
        entry.policy_class !== 'engineering') ||
      (entry.enforcement !== 'runtime' &&
        entry.enforcement !== 'ci' &&
        entry.enforcement !== 'server' &&
        entry.enforcement !== 'advisory')
    ) {
      malformed = true;
      continue;
    }
    if (!byId.has(entry.id)) {
      byId.set(entry.id, {
        id: entry.id,
        level: entry.level,
        onHit: typeof entry.on_hit === 'string' ? entry.on_hit : null,
      });
    }
  }

  return { present: true, malformed, byId };
}

interface ParsedCoverage {
  /** True only when the reason and confirmation_eligible are both valid. */
  readonly valid: boolean;
  readonly view: ReviewCoverage | null;
}

function parseCoverage(raw: unknown): ParsedCoverage {
  if (raw === undefined || raw === null) {
    return { valid: false, view: null };
  }
  if (!isRecord(raw)) {
    return {
      valid: false,
      view: { reason: null, confirmationEligible: null },
    };
  }

  const reason =
    typeof raw.reason === 'string' && KNOWN_COVERAGE_REASONS.has(raw.reason)
      ? (raw.reason as CoverageReason)
      : null;
  const confirmationEligible =
    typeof raw.confirmation_eligible === 'boolean'
      ? raw.confirmation_eligible
      : null;

  return {
    valid: reason !== null && confirmationEligible !== null,
    view: { reason, confirmationEligible },
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
    decision: null,
    snapshotDigest: null,
    coverage: null,
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
    '# Amos 阶段 A 人工审核工作表',
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
      ? '> confirm 超过 20 条：采用“确定性覆盖选择”，按不同 action.tool 与 matched rule id 优先覆盖，等覆盖增益时取原始行更早者，最终按 source+line 排序；这不是随机或统计抽样，也不构成任何统计推断。\n\n'
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
    `- decision: ${record.decision === null ? '—' : code(record.decision)}`,
    `- snapshot: ${
      record.snapshotDigest === null ? '—' : code(record.snapshotDigest)
    }`,
    `- coverage: ${renderCoverage(record.coverage)}`,
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

function renderCoverage(coverage: ReviewCoverage | null): string {
  if (coverage === null) {
    return '—';
  }
  const reason =
    coverage.reason === null ? '（缺失/无效）' : code(coverage.reason);
  const eligible =
    coverage.confirmationEligible === null
      ? '（缺失/无效）'
      : coverage.confirmationEligible
        ? 'true'
        : 'false';
  return `${reason}（confirmation_eligible ${eligible}）`;
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

/**
 * Encode an untrusted value so it is inert inside a single-backtick Markdown
 * code span.
 *
 * `JSON.stringify` handles quotes, backslashes, and every control character
 * (newline, CR, NUL, ...), which keeps the value on one line. We then
 * Unicode-escape the characters that could terminate the code span or open
 * raw HTML/Markdown: backtick, `<`, `>`, and `&`.
 */
function code(value: string): string {
  const json = JSON.stringify(value);
  const inner = json.slice(1, -1);
  const encoded = inner
    // JSON.stringify escapes C0 controls but not DEL, C1 controls, or the
    // Unicode line/paragraph separators; flatten those too so a value can
    // never introduce a line break.
    .replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .replace(/`/g, '\\u0060')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `\`${encoded}\``;
}
