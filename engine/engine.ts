import picomatch from 'picomatch';

export type Verdict = 'allow' | 'deny' | 'confirm' | 'log';

export interface EvaluationResult {
  verdict: Verdict;
  matched_rule_ids: string[];
  error?: 'engine_error';
}

type HitVerdict = 'deny' | 'confirm' | 'log';

interface Action {
  tool: string;
  operation: string;
  target: string;
}

type Predicate =
  | { op: 'op_in'; operations: string[] }
  | { op: 'target_glob'; patterns: string[] }
  | { op: 'target_outside_glob'; patterns: string[] }
  | { op: 'url_query_key_in'; keys: string[] }
  | { op: 'target_scheme_in'; schemes: string[] }
  | { op: 'target_host_in'; hosts: string[] }
  | { op: 'target_host_not_in'; hosts: string[] };

interface Rule {
  id: string;
  on_hit: HitVerdict;
  expires_at: number | null;
  predicate: Predicate[] | null;
}

const GLOB_OPTIONS = {
  dot: true,
  noext: true,
  nobrace: true,
  nonegate: true,
} as const;

const VERDICT_RANK: Record<Verdict, number> = {
  allow: 0,
  log: 1,
  confirm: 2,
  deny: 3,
};

export function evaluate(action: unknown, table: unknown, now: number): Verdict {
  return evaluateInternal(action, table, now).verdict;
}

export function evaluateWithMatches(
  action: unknown,
  table: unknown,
  now: number,
): EvaluationResult {
  return evaluateInternal(action, table, now);
}

export function assertValidTable(table: unknown): void {
  validateTable(table);
}

function evaluateInternal(
  action: unknown,
  table: unknown,
  now: number,
): EvaluationResult {
  try {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new Error('now must be a finite number');
    }

    const parsedAction = validateAction(action);
    const rules = validateTable(table);

    const matched_rule_ids: string[] = [];
    let verdict: Verdict = 'allow';

    for (const rule of rules) {
      if (rule.expires_at !== null && now >= rule.expires_at) {
        continue;
      }
      if (rule.predicate === null) {
        continue;
      }
      if (rule.predicate.every((call) => evaluatePredicate(call, parsedAction))) {
        matched_rule_ids.push(rule.id);
        if (VERDICT_RANK[rule.on_hit] > VERDICT_RANK[verdict]) {
          verdict = rule.on_hit;
        }
      }
    }

    return { verdict, matched_rule_ids };
  } catch {
    return { verdict: 'deny', matched_rule_ids: [], error: 'engine_error' };
  }
}

function validateTable(value: unknown): Rule[] {
  if (!Array.isArray(value)) {
    throw new Error('table must be an array');
  }
  return value.map(validateRule);
}

function validateAction(value: unknown): Action {
  if (!isRecord(value)) {
    throw new Error('action must be an object');
  }
  const tool = value.tool;
  const operation = value.operation;
  const target = value.target;
  if (
    !isNonBlankString(tool) ||
    !isNonBlankString(operation) ||
    !isNonBlankString(target)
  ) {
    throw new Error('action fields must be non-empty strings');
  }
  return { tool, operation, target };
}

function validateRule(value: unknown): Rule {
  if (!isRecord(value)) {
    throw new Error('rule must be an object');
  }

  const id = readNonEmptyString(value, 'id');
  readNonEmptyString(value, 'dimension');

  const level = value.level;
  if (
    typeof level !== 'number' ||
    !Number.isInteger(level) ||
    level < 0
  ) {
    throw new Error('level must be a non-negative integer');
  }

  const expressivity = value.expressivity;
  let predicate: Predicate[] | null;
  if (expressivity === 'deterministic') {
    if (!Array.isArray(value.predicate) || value.predicate.length === 0) {
      throw new Error('deterministic predicate must be a non-empty array');
    }
    predicate = value.predicate.map(validatePredicate);
  } else if (expressivity === 'advisory_only') {
    if (value.predicate !== null) {
      throw new Error('advisory_only predicate must be null');
    }
    predicate = null;
  } else {
    throw new Error('unknown expressivity');
  }

  if (typeof value.narrative !== 'string') {
    throw new Error('narrative must be a string');
  }

  const onHit = value.on_hit;
  if (onHit !== 'deny' && onHit !== 'confirm' && onHit !== 'log') {
    throw new Error('unknown on_hit');
  }

  const scope = value.scope;
  if (scope !== 'project' && scope !== 'session') {
    throw new Error('unknown scope');
  }

  const owner = value.owner;
  if (owner !== 'human' && owner !== 'agent') {
    throw new Error('unknown owner');
  }

  const expiresAt = validateTtl(value.ttl);
  validateSource(value.source);

  const probe = value.probe;
  if (typeof probe !== 'string' || probe.trim().length === 0) {
    throw new Error('probe must be non-empty');
  }

  return {
    id,
    on_hit: onHit,
    expires_at: expiresAt,
    predicate,
  };
}

function validatePredicate(value: unknown): Predicate {
  if (!isRecord(value)) {
    throw new Error('predicate call must be an object');
  }
  const op = value.op;
  if (typeof op !== 'string') {
    throw new Error('predicate op must be a string');
  }
  if (!isRecord(value.args)) {
    throw new Error('predicate args must be an object');
  }
  const args = value.args;

  switch (op) {
    case 'op_in':
      return { op, operations: readStringArray(args, 'operations') };
    case 'target_glob':
      return { op, patterns: readStringArray(args, 'patterns') };
    case 'target_outside_glob':
      return { op, patterns: readStringArray(args, 'patterns') };
    case 'url_query_key_in':
      return { op, keys: readStringArray(args, 'keys') };
    case 'target_scheme_in':
      return { op, schemes: readStringArray(args, 'schemes') };
    case 'target_host_in':
      return { op, hosts: readStringArray(args, 'hosts') };
    case 'target_host_not_in':
      return { op, hosts: readStringArray(args, 'hosts') };
    default:
      throw new Error('unknown predicate op');
  }
}

function validateTtl(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('invalid ttl');
  }

  const dateOnly = parseDateOnly(value);
  if (dateOnly !== null) {
    return dateOnly;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('invalid ttl');
  }
  return parsed;
}

function parseDateOnly(value: string): number | null {
  if (value.length !== 10 || value[4] !== '-' || value[7] !== '-') {
    return null;
  }

  const yearText = value.slice(0, 4);
  const monthText = value.slice(5, 7);
  const dayText = value.slice(8, 10);
  if (
    !isAsciiDigits(yearText) ||
    !isAsciiDigits(monthText) ||
    !isAsciiDigits(dayText)
  ) {
    return null;
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysInMonth(year: number, month: number): number {
  if (
    month === 2 &&
    year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0)
  ) {
    return 29;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function validateSource(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('source must be an object');
  }
  for (const field of ['repo', 'rev', 'path', 'section', 'lines', 'quote']) {
    if (!isNonBlankString(value[field])) {
      throw new Error(`source.${field} must be a non-empty string`);
    }
  }
}

function evaluatePredicate(predicate: Predicate, action: Action): boolean {
  switch (predicate.op) {
    case 'op_in':
      return predicate.operations.includes(action.operation);

    case 'target_glob': {
      assertAbsoluteTarget(action.target);
      return predicate.patterns.some((pattern) =>
        picomatch(pattern, GLOB_OPTIONS)(action.target),
      );
    }

    case 'target_outside_glob': {
      assertAbsoluteTarget(action.target);
      return !predicate.patterns.some((pattern) =>
        picomatch(pattern, GLOB_OPTIONS)(action.target),
      );
    }

    case 'url_query_key_in': {
      const url = new URL(action.target);
      const keys = new Set(predicate.keys.map((key) => key.toLowerCase()));
      for (const key of url.searchParams.keys()) {
        if (keys.has(key.toLowerCase())) {
          return true;
        }
      }
      return false;
    }

    case 'target_scheme_in': {
      const url = new URL(action.target);
      const scheme = normalizeScheme(url.protocol);
      return predicate.schemes.some(
        (candidate) => normalizeScheme(candidate) === scheme,
      );
    }

    case 'target_host_in': {
      const url = new URL(action.target);
      const host = normalizeHost(url.hostname);
      return predicate.hosts.some(
        (candidate) => normalizeHost(candidate) === host,
      );
    }

    case 'target_host_not_in': {
      const url = new URL(action.target);
      const host = normalizeHost(url.hostname);
      return !predicate.hosts.some(
        (candidate) => normalizeHost(candidate) === host,
      );
    }

    default:
      throw new Error('unknown predicate op');
  }
}

function assertAbsoluteTarget(target: string): void {
  if (!target.startsWith('/')) {
    throw new Error('file target must be an absolute path');
  }
}

function normalizeScheme(scheme: string): string {
  return (scheme.endsWith(':') ? scheme.slice(0, -1) : scheme).toLowerCase();
}

function normalizeHost(host: string): string {
  const lowered = host.toLowerCase();
  if (lowered.startsWith('[') && lowered.endsWith(']')) {
    return lowered.slice(1, -1);
  }
  return lowered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readNonEmptyString(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return candidate;
}

function readStringArray(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    !candidate.every((item) => typeof item === 'string')
  ) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return candidate;
}
