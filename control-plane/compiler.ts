import { createHash } from 'node:crypto';
import { Ajv, type ErrorObject } from 'ajv';
import { assertValidTable } from '../engine/engine.ts';
import type {
  Candidate,
  CandidateActivation,
  PolicySnapshot,
  RulePredicate,
  RuleRecord,
  ValidationIssue,
  ValidationResult,
} from './contracts.ts';
import { DomainError } from './errors.ts';

export const SNAPSHOT_FORMAT = 'amos-governance-snapshot' as const;
export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const RULE_SCHEMA_VERSION = 'amos-rule-table-v1' as const;
export const COMPILER_VERSION = 'amos-governance-compiler-v1' as const;

export const MAX_RULES_PER_CANDIDATE = 500;
export const MAX_CANDIDATE_BYTES = 2_000_000;

const SESSION_WORKSPACE_TOKEN = '${SESSION_WORKSPACE}';

const PROPOSAL_DIGEST_DOMAIN = 'amos-governance-proposal-v1';
const CANDIDATE_DIGEST_DOMAIN = 'amos-governance-candidate-v1';
const ENFORCEMENT_DIGEST_DOMAIN = 'amos-governance-enforcement-v1';
const ADVISORY_DIGEST_DOMAIN = 'amos-governance-advisory-v1';
const SNAPSHOT_DIGEST_DOMAIN = 'amos-governance-snapshot-v1';

export interface RuleValidator {
  readonly schemaDigest: string;
  validateRules(rules: unknown): ValidationResult;
}

export interface CompiledCandidate {
  readonly candidate: Candidate;
  readonly effectiveRuleIds: string[];
  readonly enforcementRules: RuleRecord[];
  readonly advisoryRules: RuleRecord[];
  readonly candidateDigest: string;
}

export interface CandidateCompilation {
  readonly result: ValidationResult;
  readonly compiled: CompiledCandidate | null;
}

export interface ProposalDigestInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly baseVersion: number;
  readonly title: string;
  readonly rationale: string;
  readonly expiresAt: string;
  readonly restoreFromVersion: number | null;
  readonly schemaDigest: string;
  readonly compilerVersion: string;
  readonly candidate: Candidate;
}

export interface SnapshotBuildInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly compiled: CompiledCandidate;
  readonly schemaDigest: string;
  readonly schemaVersion?: string;
  readonly compilerVersion?: string;
}

/**
 * Compile the repo rule schema once per service. Invalid schema text fails
 * closed and its parser details never escape.
 */
export function createRuleValidator(
  rawSchema: string | Record<string, unknown>,
): RuleValidator {
  let parsed: unknown;
  try {
    parsed =
      typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema;
  } catch {
    throw new DomainError('schema_invalid');
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new DomainError('schema_invalid');
  }

  let validate: ReturnType<Ajv['compile']>;
  try {
    const ajv = new Ajv({ allErrors: true, strict: true });
    validate = ajv.compile(parsed as object);
  } catch {
    throw new DomainError('schema_invalid');
  }

  const schemaDigest = stringDigest(
    `${RULE_SCHEMA_VERSION}\0${canonicalJson(parsed)}`,
  );

  return {
    schemaDigest,
    validateRules(rules: unknown): ValidationResult {
      try {
        if (validate(rules)) {
          return { valid: true, issues: [] };
        }
        return { valid: false, issues: ajvIssues(validate.errors, 'candidate.rules') };
      } catch {
        return {
          valid: false,
          issues: [{ path: 'candidate.rules', code: 'invalid_rule' }],
        };
      }
    },
  };
}

/**
 * Validate a candidate and, when valid, produce the expanded immutable rule
 * sets used for publication. The stored/normalized candidate keeps the raw
 * `${SESSION_WORKSPACE}` token; only glob patterns are expanded.
 */
export function validateAndCompileCandidate(
  rawCandidate: unknown,
  workspace: string,
  validator: RuleValidator,
): CandidateCompilation {
  const issues: ValidationIssue[] = [];

  const workspaceIssue = normalizedWorkspaceIssue(workspace);
  if (workspaceIssue !== null) {
    return {
      result: { valid: false, issues: [workspaceIssue] },
      compiled: null,
    };
  }

  const serialized = serializedCandidate(rawCandidate);
  if (serialized === null) {
    return {
      result: {
        valid: false,
        issues: [{ path: 'candidate', code: 'invalid_candidate' }],
      },
      compiled: null,
    };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANDIDATE_BYTES) {
    return {
      result: {
        valid: false,
        issues: [{ path: 'candidate', code: 'payload_too_large' }],
      },
      compiled: null,
    };
  }

  const normalized = JSON.parse(serialized) as unknown;
  if (!isRecord(normalized)) {
    return {
      result: {
        valid: false,
        issues: [{ path: 'candidate', code: 'invalid_candidate' }],
      },
      compiled: null,
    };
  }

  for (const key of Object.keys(normalized)) {
    if (key !== 'rules' && key !== 'activation') {
      issues.push({ path: `candidate.${key}`, code: 'unknown_field' });
    }
  }

  const rules = normalized.rules;
  if (!Array.isArray(rules)) {
    issues.push({ path: 'candidate.rules', code: 'invalid_candidate' });
  } else if (rules.length === 0) {
    issues.push({ path: 'candidate.rules', code: 'empty_rules' });
  } else if (rules.length > MAX_RULES_PER_CANDIDATE) {
    issues.push({ path: 'candidate.rules', code: 'payload_too_large' });
  }

  let rawRules: RuleRecord[] = [];
  if (Array.isArray(rules) && rules.length > 0 && rules.length <= MAX_RULES_PER_CANDIDATE) {
    const schemaResult = validator.validateRules(rules);
    if (!schemaResult.valid) {
      issues.push(...schemaResult.issues);
    } else {
      rawRules = rules as RuleRecord[];

      const seen = new Set<string>();
      for (let index = 0; index < rawRules.length; index += 1) {
        const rule = rawRules[index];
        if (seen.has(rule.id)) {
          issues.push({
            path: `candidate.rules[${index}].id`,
            code: 'duplicate_rule_id',
          });
        } else {
          seen.add(rule.id);
        }

        try {
          // Validate each rule independently so a semantic failure (for
          // example an invalid TTL date) can be attributed without echoing the
          // rule body.
          assertValidTable([rule]);
        } catch {
          issues.push({
            path: `candidate.rules[${index}]`,
            code: 'invalid_rule_semantics',
          });
        }
      }
    }
  }

  const activationResult = validateActivation(
    normalized.activation,
    rawRules,
    issues,
  );

  const expansion =
    rawRules.length > 0
      ? expandCandidateRules(rawRules, workspace)
      : { rules: [] as RuleRecord[], issues: [] as ValidationIssue[] };
  issues.push(...expansion.issues);

  if (issues.length > 0) {
    return {
      result: { valid: false, issues: dedupeIssues(issues) },
      compiled: null,
    };
  }

  if (activationResult === null || rawRules.length === 0) {
    return {
      result: {
        valid: false,
        issues: [{ path: 'candidate.activation', code: 'empty_effective_policy' }],
      },
      compiled: null,
    };
  }

  try {
    assertValidTable(expansion.rules);
  } catch {
    return {
      result: {
        valid: false,
        issues: [{ path: 'candidate.rules', code: 'invalid_rule_semantics' }],
      },
      compiled: null,
    };
  }

  const candidate: Candidate = {
    rules: rawRules,
    activation: activationResult.candidate,
  };
  const effectiveSet = new Set(activationResult.effectiveRuleIds);
  const effectiveRules = expansion.rules.filter((rule) =>
    effectiveSet.has(rule.id),
  );
  const enforcementRules = effectiveRules.filter(
    (rule) => rule.expressivity === 'deterministic',
  );
  const advisoryRules = effectiveRules.filter(
    (rule) => rule.expressivity === 'advisory_only',
  );

  return {
    result: { valid: true, issues: [] },
    compiled: {
      candidate,
      effectiveRuleIds: effectiveRules.map((rule) => rule.id),
      enforcementRules,
      advisoryRules,
      candidateDigest: candidateDigest(candidate),
    },
  };
}

export function proposalDigest(input: ProposalDigestInput): string {
  return digestWithDomain(PROPOSAL_DIGEST_DOMAIN, {
    projectId: input.projectId,
    workspace: input.workspace,
    baseVersion: input.baseVersion,
    title: input.title,
    rationale: input.rationale,
    expiresAt: input.expiresAt,
    restoreFromVersion: input.restoreFromVersion,
    schemaDigest: input.schemaDigest,
    compilerVersion: input.compilerVersion,
    candidate: input.candidate,
  });
}

export function candidateDigest(candidate: Candidate): string {
  return digestWithDomain(CANDIDATE_DIGEST_DOMAIN, candidate);
}

/**
 * Build the control-plane snapshot. The three digests are deliberately
 * domain-separated from the legacy `storage/snapshot.ts` digest and from each
 * other. The top-level digest binds project, workspace, version,
 * schema/compiler, activation, and both compiled lanes.
 */
export function buildPolicySnapshot(input: SnapshotBuildInput): PolicySnapshot {
  const schemaVersion = input.schemaVersion ?? RULE_SCHEMA_VERSION;
  const compilerVersion = input.compilerVersion ?? COMPILER_VERSION;
  const common = {
    projectId: input.projectId,
    workspace: input.workspace,
    version: input.version,
    schemaVersion,
    compilerVersion,
    schemaDigest: input.schemaDigest,
    candidateDigest: input.compiled.candidateDigest,
    activation: input.compiled.candidate.activation,
  } as const;

  const enforcement = {
    digest: digestWithDomain(ENFORCEMENT_DIGEST_DOMAIN, {
      ...common,
      rules: input.compiled.enforcementRules,
    }),
    ruleIds: input.compiled.enforcementRules.map((rule) => rule.id),
    rules: input.compiled.enforcementRules,
  };

  const advisory = {
    digest: digestWithDomain(ADVISORY_DIGEST_DOMAIN, {
      ...common,
      rules: input.compiled.advisoryRules,
    }),
    ruleIds: input.compiled.advisoryRules.map((rule) => rule.id),
    rules: input.compiled.advisoryRules,
  };

  return {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    ...common,
    enforcement,
    advisory,
    enforcementDigest: enforcement.digest,
    advisoryDigest: advisory.digest,
    digest: digestWithDomain(SNAPSHOT_DIGEST_DOMAIN, {
      ...common,
      enforcementDigest: enforcement.digest,
      advisoryDigest: advisory.digest,
    }),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item, seen);
    }
  } else {
    for (const item of Object.values(value)) {
      deepFreeze(item, seen);
    }
  }

  return Object.freeze(value);
}

export function assertNormalizedWorkspace(value: unknown): asserts value is string {
  if (normalizedWorkspaceIssue(value) !== null) {
    throw new DomainError('invalid_workspace');
  }
}

function normalizedWorkspaceIssue(value: unknown): ValidationIssue | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('//') ||
    (value.length > 1 && value.endsWith('/'))
  ) {
    return { path: 'workspace', code: 'invalid_workspace' };
  }
  const segments = value.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '.' || segment === '..') {
      return { path: 'workspace', code: 'invalid_workspace' };
    }
  }
  return null;
}

interface ActivationValidation {
  readonly candidate: CandidateActivation;
  readonly effectiveRuleIds: string[];
}

function validateActivation(
  value: unknown,
  rules: RuleRecord[],
  issues: ValidationIssue[],
): ActivationValidation | null {
  if (!isRecord(value)) {
    issues.push({ path: 'candidate.activation', code: 'invalid_candidate' });
    return null;
  }

  for (const key of Object.keys(value)) {
    if (key !== 'includedRuleIds' && key !== 'excludedRuleIds') {
      issues.push({
        path: `candidate.activation.${key}`,
        code: 'unknown_field',
      });
    }
  }

  const includedRaw = value.includedRuleIds;
  let included: string[] | null = null;
  if (includedRaw !== null) {
    const parsed = readIdArray(
      includedRaw,
      'candidate.activation.includedRuleIds',
      issues,
    );
    if (parsed === null) {
      return null;
    }
    included = parsed;
  }

  const excluded = readIdArray(
    value.excludedRuleIds,
    'candidate.activation.excludedRuleIds',
    issues,
  );
  if (excluded === null) {
    return null;
  }

  const ruleIds = new Set(rules.map((rule) => rule.id));
  checkIds(included, 'candidate.activation.includedRuleIds', ruleIds, issues);
  checkIds(excluded, 'candidate.activation.excludedRuleIds', ruleIds, issues);

  if (included !== null) {
    const excludedSet = new Set(excluded);
    if (included.some((id) => excludedSet.has(id))) {
      issues.push({
        path: 'candidate.activation',
        code: 'activation_overlap',
      });
    }
  }

  if (issues.length > 0) {
    return null;
  }

  const selected =
    included === null
      ? new Set(rules.map((rule) => rule.id))
      : new Set(included);
  const excludedSet = new Set(excluded);
  const effectiveRuleIds = rules
    .filter((rule) => selected.has(rule.id) && !excludedSet.has(rule.id))
    .map((rule) => rule.id);

  if (effectiveRuleIds.length === 0) {
    issues.push({
      path: 'candidate.activation',
      code: 'empty_effective_policy',
    });
    return null;
  }

  return {
    candidate: {
      includedRuleIds: included === null ? null : [...included],
      excludedRuleIds: [...excluded],
    },
    effectiveRuleIds,
  };
}

function readIdArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push({ path, code: 'invalid_candidate' });
    return null;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push({ path: `${path}[${index}]`, code: 'invalid_candidate' });
      continue;
    }
    if (seen.has(item)) {
      issues.push({ path: `${path}[${index}]`, code: 'duplicate_activation_id' });
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function checkIds(
  ids: string[] | null,
  path: string,
  ruleIds: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (ids === null) {
    return;
  }
  for (let index = 0; index < ids.length; index += 1) {
    if (!ruleIds.has(ids[index])) {
      issues.push({ path: `${path}[${index}]`, code: 'unknown_rule_id' });
    }
  }
}

function expandCandidateRules(
  rules: RuleRecord[],
  workspace: string,
): { rules: RuleRecord[]; issues: ValidationIssue[] } {
  const clone = structuredClone(rules) as RuleRecord[];
  const issues: ValidationIssue[] = [];

  for (let ruleIndex = 0; ruleIndex < clone.length; ruleIndex += 1) {
    const rule = clone[ruleIndex];
    const predicate = rule.predicate;
    if (!Array.isArray(predicate)) {
      continue;
    }

    for (let callIndex = 0; callIndex < predicate.length; callIndex += 1) {
      const call = predicate[callIndex] as RulePredicate;
      const args = call.args as Record<string, unknown>;
      const isGlob =
        call.op === 'target_glob' || call.op === 'target_outside_glob';

      if (isGlob && Array.isArray(args.patterns)) {
        args.patterns = args.patterns.map((pattern) =>
          typeof pattern === 'string'
            ? pattern.split(SESSION_WORKSPACE_TOKEN).join(workspace)
            : pattern,
        );
        continue;
      }

      if (containsToken(args)) {
        issues.push({
          path: `candidate.rules[${ruleIndex}].predicate[${callIndex}]`,
          code: 'unsupported_workspace_token',
        });
      }
    }
  }

  return { rules: clone, issues };
}

function containsToken(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(SESSION_WORKSPACE_TOKEN);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsToken(item));
  }
  return Object.values(value).some((item) => containsToken(item));
}

function serializedCandidate(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function ajvIssues(
  errors: ErrorObject[] | null | undefined,
  prefix: string,
): ValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [{ path: prefix, code: 'invalid_rule' }];
  }
  return errors.map((error) => ({
    path: `${prefix}${pointerSuffix(error.instancePath)}`,
    code: ajvCode(error.keyword),
  }));
}

function pointerSuffix(pointer: string): string {
  if (pointer.length === 0) {
    return '';
  }
  return pointer
    .split('/')
    .slice(1)
    .map(
      (segment) =>
        `[${segment.replace(/~1/g, '/').replace(/~0/g, '~')}]`,
    )
    .join('');
}

function ajvCode(keyword: string): string {
  if (keyword === 'required') {
    return 'required_field';
  }
  if (keyword === 'additionalProperties') {
    return 'unknown_field';
  }
  return 'invalid_rule';
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const result: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}\0${issue.code}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(issue);
  }
  return result;
}

function digestWithDomain(domain: string, value: unknown): string {
  return stringDigest(`${domain}\0${canonicalJson(value)}\0`);
}

function stringDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
