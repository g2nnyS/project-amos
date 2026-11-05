/**
 * Typed governance-domain contracts and validators.
 *
 * Every record returned by the store is deeply frozen and derived from validated
 * input. `Actor` values are trusted server state: the store never accepts an
 * actor that arrives inside client JSON.
 */

import { canonicalJson, deepFreeze, digest } from '../activation/json.ts';
import { assertValidTable } from '../engine/engine.ts';
import type { InjectionRoute } from '../injector/snapshot.ts';
import type { RuleRef } from '../activation/types.ts';
import { GovernanceError, fail } from './errors.ts';

export type RuleExpressivity = 'deterministic' | 'advisory_only';
export type RuleOnHit = 'deny' | 'confirm' | 'log';
export type RuleScope = 'project' | 'session';
export type RuleOwner = 'human' | 'agent';
export type RulePolicyClass = 'security' | 'engineering';
export type RuleEnforcement = 'runtime' | 'ci' | 'server' | 'advisory';
export type PredicateOp =
  | 'op_in'
  | 'target_glob'
  | 'target_outside_glob'
  | 'url_query_key_in'
  | 'target_scheme_in'
  | 'target_host_in'
  | 'target_host_not_in';

export interface RuleSource {
  readonly repo: string;
  readonly rev: string;
  readonly path: string;
  readonly section: string;
  readonly lines: string;
  readonly quote: string;
}

export interface RulePredicate {
  readonly op: PredicateOp;
  readonly args: Readonly<Record<string, readonly string[]>>;
}

/** Matches `constraints/schema.json`; predicate operators stay frozen. */
export interface RuleRecord {
  readonly id: string;
  readonly dimension: string;
  readonly level: number;
  readonly expressivity: RuleExpressivity;
  readonly predicate: readonly RulePredicate[] | null;
  readonly narrative: string;
  readonly on_hit: RuleOnHit;
  readonly scope: RuleScope;
  readonly ttl: string | null;
  readonly owner: RuleOwner;
  readonly source: RuleSource;
  readonly probe: string;
  readonly policy_class: RulePolicyClass;
  readonly enforcement: RuleEnforcement;
}

export type ActorRole = 'human' | 'agent';

/** Trusted server-side identity. Never parsed from a request body. */
export interface Actor {
  readonly id: string;
  readonly role: ActorRole;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly currentVersion: number;
  readonly createdAt: string;
}

export type ProposalType = 'rules' | 'project-activation' | 'settings';
export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'expired';
export type DecisionKind = 'approve' | 'reject';

export interface ProposalDecision {
  readonly actor: Actor;
  readonly at: string;
  readonly note: string;
}

export interface Proposal {
  readonly id: string;
  readonly projectId: string;
  readonly baseVersion: number;
  readonly type: ProposalType;
  readonly title: string;
  readonly rationale: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ProposalStatus;
  readonly candidateDigest: string;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly decision: ProposalDecision | null;
  readonly publishedVersion: number | null;
}

export interface Publication {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly activationDigest: string;
  readonly catalogVersion: string;
  readonly compilerVersion: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly auditId: number;
}

export interface Receipt {
  readonly publicationId: string;
  readonly hostId: string;
  readonly hostVersion: string;
  readonly projectId: string;
  readonly activationDigest: string;
  readonly receivedAt: string;
  readonly effective: boolean;
  readonly errorCode: string | null;
}

export interface AuditRecord {
  readonly id: number;
  readonly at: string;
  readonly action: string;
  readonly actorId: string;
  readonly actorRole: ActorRole;
  readonly projectId: string | null;
  readonly proposalId: string | null;
  readonly version: number | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Only the reference is stored; the value is never read from the database. */
export interface SecretRef {
  readonly name: string;
  readonly envVar: string;
}

export interface SettingEntry {
  readonly key: string;
  readonly value: unknown;
}

export interface ActivationSelection {
  readonly selectedRuleRefs: readonly RuleRef[];
  readonly excludedRuleIds: readonly string[];
  readonly advisoryBaselineRuleIds: readonly string[];
  readonly routes: readonly InjectionRoute[];
  readonly projectConfigVersion?: string;
  readonly epoch?: number;
}

export interface CandidateRecord extends Readonly<Record<string, unknown>> {
  readonly type: ProposalType;
  readonly activation?: ActivationSelection;
  readonly rules?: readonly RuleRecord[];
  readonly settings?: readonly SettingEntry[];
  readonly guidance?: readonly Readonly<Record<string, unknown>>[];
  readonly schemaDigest?: string;
}

export const CANDIDATE_DIGEST_DOMAIN = 'amos-governance-candidate-v1';

/** Identity of a proposal candidate, shared by preview, proposal, publish. */
export function digestCandidate(candidate: unknown): string {
  return digest(CANDIDATE_DIGEST_DOMAIN, candidate);
}

const SECRET_FIELD = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth[_-]?token|secret|password|passwd|credential|credentials|authorization)$/i;
const ENV_REFERENCE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BARE_ENV_REFERENCE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export function isSecretReference(value: unknown): boolean {
  return typeof value === 'string' && (ENV_REFERENCE.test(value) || BARE_ENV_REFERENCE.test(value));
}

export function secretReferenceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const brace = ENV_REFERENCE.exec(value);
  if (brace !== null) return brace[1] ?? null;
  const bare = BARE_ENV_REFERENCE.exec(value);
  return bare === null ? null : (bare[1] ?? null);
}

/**
 * Reject credential literals embedded in any object field. Callers that accept
 * configuration input run this before persisting or echoing it.
 */
export function assertNoSecretLiterals(value: unknown, path = 'value', depth = 0): void {
  if (depth > 32) fail('invalid_value');
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretLiterals(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    // `{ key, value }` setting entries carry the setting name in `key`; the
    // credential check applies to the setting's value, handled by readSettings.
    if (key === 'key' && Object.hasOwn(record, 'value')) {
      assertNoSecretLiterals(entry, `${path}.key`, depth + 1);
      continue;
    }
    if (SECRET_FIELD.test(key)) {
      if (entry === null || entry === undefined || entry === '') continue;
      if (typeof entry !== 'string') fail('secret_literal');
      if (!isSecretReference(entry)) fail('secret_literal');
      continue;
    }
    assertNoSecretLiterals(entry, `${path}.${key}`, depth + 1);
  }
}

export function parseActor(value: unknown): Actor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_actor');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) fail('invalid_actor');
  if (typeof record.id !== 'string' || !isText(record.id, 160)) fail('invalid_actor');
  if (record.role !== 'human' && record.role !== 'agent') fail('invalid_actor');
  return Object.freeze({ id: record.id, role: record.role });
}

export function assertHuman(actor: Actor): void {
  if (actor.role !== 'human') fail('role_denied');
}

export function readBoundedText(value: unknown, max = 10_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max ||
    value.includes('\0')) fail('invalid_text');
  return value;
}

export function readLabel(value: unknown, max = 160): string {
  if (typeof value !== 'string' || !isText(value, max)) fail('invalid_text');
  return value;
}

export function readTimestamp(value: unknown, code = 'invalid_timestamp'): string {
  if (typeof value !== 'string' || value.length > 40) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code);
  return value;
}

export function toIso(now: number): string {
  return new Date(now).toISOString();
}

function isText(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max && !value.includes('\0');
}

export function readVersion(value: unknown, code = 'invalid_version'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

export function readRef(value: unknown): RuleRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_rule_ref');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) fail('invalid_rule_ref');
  const id = readLabel(record.id);
  const version = record.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    fail('invalid_rule_ref');
  }
  return Object.freeze({ id, version });
}

export function readRefs(value: unknown): readonly RuleRef[] {
  if (!Array.isArray(value) || value.length > 4_096) fail('invalid_rule_refs');
  const refs = value.map(readRef);
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.id}\0${ref.version}`;
    if (seen.has(key)) fail('duplicate_rule_ref');
    seen.add(key);
  }
  return deepFreeze(refs);
}

export function readStringList(value: unknown, code = 'invalid_list'): readonly string[] {
  if (!Array.isArray(value) || value.length > 4_096) fail(code);
  const strings = value.map((entry) => readLabel(entry));
  const seen = new Set<string>();
  for (const entry of strings) {
    if (seen.has(entry)) fail('duplicate_id');
    seen.add(entry);
  }
  return deepFreeze(strings);
}

export function readRoutes(value: unknown): readonly InjectionRoute[] {
  if (!Array.isArray(value) || value.length > 1_024) fail('invalid_routes');
  for (const route of value) {
    if (route === null || typeof route !== 'object' || Array.isArray(route)) fail('invalid_routes');
    const record = route as Record<string, unknown>;
    if (record.match === null || typeof record.match !== 'object' || Array.isArray(record.match)) {
      fail('invalid_routes');
    }
    if (!Array.isArray(record.add) || !Array.isArray(record.suppress)) fail('invalid_routes');
    if (typeof record.specificity !== 'number' || !Number.isFinite(record.specificity)) {
      fail('invalid_routes');
    }
  }
  // The activation compiler performs the authoritative route validation.
  return deepFreeze(value as InjectionRoute[]);
}

export function readActivation(value: unknown): ActivationSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_activation');
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'selectedRuleRefs',
    'excludedRuleIds',
    'advisoryBaselineRuleIds',
    'routes',
    'projectConfigVersion',
    'epoch',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail('unknown_field');
  }
  const selectedRuleRefs = readRefs(record.selectedRuleRefs ?? []);
  const excludedRuleIds = readStringList(record.excludedRuleIds ?? []);
  const advisoryBaselineRuleIds = readStringList(record.advisoryBaselineRuleIds ?? []);
  const routes = readRoutes(record.routes ?? []);
  const projectConfigVersion = record.projectConfigVersion === undefined
    ? undefined
    : readLabel(record.projectConfigVersion);
  let epoch: number | undefined;
  if (record.epoch !== undefined) {
    if (typeof record.epoch !== 'number' || !Number.isSafeInteger(record.epoch) || record.epoch < 0) {
      fail('invalid_epoch');
    }
    epoch = record.epoch;
  }
  const selection: Record<string, unknown> = {
    selectedRuleRefs,
    excludedRuleIds,
    advisoryBaselineRuleIds,
    routes,
  };
  if (projectConfigVersion !== undefined) selection.projectConfigVersion = projectConfigVersion;
  if (epoch !== undefined) selection.epoch = epoch;
  return deepFreeze(selection) as unknown as ActivationSelection;
}

const RULE_KEYS = [
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
  'policy_class',
  'enforcement',
] as const;

const SOURCE_KEYS = ['repo', 'rev', 'path', 'section', 'lines', 'quote'] as const;
const OPS: Readonly<Record<PredicateOp, string>> = Object.freeze({
  op_in: 'operations',
  target_glob: 'patterns',
  target_outside_glob: 'patterns',
  url_query_key_in: 'keys',
  target_scheme_in: 'schemes',
  target_host_in: 'hosts',
  target_host_not_in: 'hosts',
});

export function readRule(value: unknown): RuleRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_rule');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== RULE_KEYS.length) fail('unknown_field');
  for (const key of RULE_KEYS) {
    if (!Object.hasOwn(record, key)) fail('unknown_field');
  }
  const id = readLabel(record.id);
  const dimension = readLabel(record.dimension);
  if (typeof record.level !== 'number' || !Number.isSafeInteger(record.level) || record.level < 0) {
    fail('invalid_rule');
  }
  const expressivity = record.expressivity;
  if (expressivity !== 'deterministic' && expressivity !== 'advisory_only') fail('invalid_rule');
  const predicate = readPredicateList(record.predicate);
  const narrative = readBoundedText(record.narrative, 1_000_000);
  if (record.on_hit !== 'deny' && record.on_hit !== 'confirm' && record.on_hit !== 'log') {
    fail('invalid_rule');
  }
  if (record.scope !== 'project' && record.scope !== 'session') fail('invalid_rule');
  const ttlValue = record.ttl === null ? null : readBoundedText(record.ttl, 160);
  if (record.owner !== 'human' && record.owner !== 'agent') fail('invalid_rule');
  const source = readSource(record.source);
  const probe = readBoundedText(record.probe, 10_000);
  if (record.policy_class !== 'security' && record.policy_class !== 'engineering') {
    fail('invalid_rule');
  }
  const enforcement = record.enforcement;
  if (enforcement !== 'runtime' && enforcement !== 'ci' && enforcement !== 'server' &&
    enforcement !== 'advisory') {
    fail('invalid_rule');
  }
  if (expressivity === 'advisory_only') {
    if (predicate !== null || enforcement !== 'advisory') fail('invalid_rule');
  } else if (predicate === null || enforcement === 'advisory') {
    fail('invalid_rule');
  }
  return deepFreeze({
    id,
    dimension,
    level: record.level,
    expressivity,
    predicate,
    narrative,
    on_hit: record.on_hit,
    scope: record.scope,
    ttl: ttlValue,
    owner: record.owner,
    source,
    probe,
    policy_class: record.policy_class,
    enforcement,
  });
}

function readPredicateList(value: unknown): readonly RulePredicate[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('invalid_predicate');
  return deepFreeze(value.map(readPredicate));
}

function readPredicate(value: unknown): RulePredicate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_predicate');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'op') || !Object.hasOwn(record, 'args')) {
    fail('invalid_predicate');
  }
  if (typeof record.op !== 'string' || !Object.hasOwn(OPS, record.op)) fail('invalid_predicate');
  const op = record.op as PredicateOp;
  if (record.args === null || typeof record.args !== 'object' || Array.isArray(record.args)) {
    fail('invalid_predicate');
  }
  const args = record.args as Record<string, unknown>;
  const expected = OPS[op];
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, expected)) fail('invalid_predicate');
  const values = args[expected];
  if (!Array.isArray(values) || values.length === 0 || values.length > 4_096) {
    fail('invalid_predicate');
  }
  const strings = values.map((entry) => readBoundedText(entry, 1_024));
  return deepFreeze({ op, args: { [expected]: strings } });
}

function readSource(value: unknown): RuleSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_source');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== SOURCE_KEYS.length) fail('invalid_source');
  for (const key of SOURCE_KEYS) {
    if (!Object.hasOwn(record, key)) fail('invalid_source');
    readBoundedText(record[key], 10_000);
  }
  return deepFreeze({
    repo: record.repo as string,
    rev: record.rev as string,
    path: record.path as string,
    section: record.section as string,
    lines: record.lines as string,
    quote: record.quote as string,
  });
}

/**
 * Validate a complete rule table using the same engine table validator that
 * governs the runtime policy input, plus duplicate-ID detection.
 */
export function readRuleTable(value: unknown): readonly RuleRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) fail('invalid_rules');
  const rules = value.map(readRule);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) fail('duplicate_id');
    ids.add(rule.id);
  }
  try {
    assertValidTable(rules);
  } catch {
    throw new GovernanceError('invalid_rules');
  }
  return deepFreeze(rules);
}

export function readSettings(value: unknown): readonly SettingEntry[] {
  if (!Array.isArray(value) || value.length > 4_096) fail('invalid_settings');
  const settings: SettingEntry[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_settings');
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'key') ||
      !Object.hasOwn(record, 'value')) fail('invalid_settings');
    const key = readLabel(record.key);
    if (keys.has(key)) fail('duplicate_id');
    keys.add(key);
    settings.push(Object.freeze({ key, value: normalizeSettingValue(key, record.value) }));
  }
  return deepFreeze(settings);
}

function normalizeSettingValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD.test(key.split('.').at(-1) ?? key)) {
    if (value === null || value === undefined || value === '') return value;
    const envVar = secretReferenceName(value);
    if (envVar === null) fail('secret_literal');
    return `{env:${envVar}}`;
  }
  if (typeof value === 'string' && SECRET_FIELD.test(key) && !isSecretReference(value)) {
    fail('secret_literal');
  }
  assertNoSecretLiterals(value, `settings.${key}`);
  return value;
}

/**
 * Normalize a proposal candidate. Unknown top-level fields are rejected so a
 * proposal cannot smuggle extra authority.
 */
export function readCandidate(value: unknown): CandidateRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_candidate');
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== 'rules' && type !== 'project-activation' && type !== 'settings') {
    fail('invalid_candidate_type');
  }
  const allowed = new Set([
    'type',
    'activation',
    'rules',
    'settings',
    'guidance',
    'schemaDigest',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail('unknown_field');
  }
  assertNoSecretLiterals(value, 'candidate');
  const result: Record<string, unknown> = { type };
  if (record.activation !== undefined) result.activation = readActivation(record.activation);
  if (record.rules !== undefined) result.rules = readRuleTable(record.rules);
  if (record.settings !== undefined) result.settings = readSettings(record.settings);
  if (record.guidance !== undefined) result.guidance = readGuidanceRefs(record.guidance);
  if (record.schemaDigest !== undefined) result.schemaDigest = readDigest(record.schemaDigest);

  if (type === 'rules') {
    if (result.rules === undefined) fail('invalid_candidate');
  }
  if (type === 'project-activation') {
    if (result.activation === undefined) fail('invalid_candidate');
    if (result.rules !== undefined || result.settings !== undefined) fail('invalid_candidate');
  }
  if (type === 'settings') {
    if (result.settings === undefined) fail('invalid_candidate');
  }
  return deepFreeze(result) as CandidateRecord;
}

function readGuidanceRefs(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 4_096) fail('invalid_guidance');
  return deepFreeze(value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('invalid_guidance');
    }
    return { ...(entry as Record<string, unknown>) };
  }));
}

export function readDigest(value: unknown, code = 'invalid_digest'): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(code);
  return value;
}

export function candidateDigestOf(candidate: CandidateRecord): string {
  return digestCandidate(candidate);
}

/** Stable serialization used only for audit detail and test assertions. */
export function stableJson(value: unknown): string {
  return canonicalJson(value);
}
