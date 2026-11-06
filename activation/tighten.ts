/**
 * Append-only temporary tightening.
 *
 * A publisher may only apply rules from a closed list of approved templates.
 * Every application recompiles the same project activation with exactly one
 * additional deterministic, non-zero-layer rule (or `deny`/`confirm`) and then
 * proves that no pre-existing rule, mandatory membership, project selection or
 * advisory narrative changed. TTL and quota are derived only from the caller's
 * trusted clock and the fixed template/quota values; no model or agent text is
 * accepted.
 *
 * Limits (deliberate):
 * - Without `recovered` input the publisher is process-local and a restart
 *   loses every applied tightening. The control plane supplies SQLite-backed
 *   recovery so persisted TTLs and quotas survive restarts.
 * - There is no background cleanup timer and no retry/extension path. `expire()`
 *   must be called with the trusted clock; `apply()` never renews an entry.
 * - A template's `ruleDigest` binds the exact compiled (workspace-expanded)
 *   rule record. The approval artifact must be produced from the same project
 *   expansion; a raw unexpanded catalog record will not match.
 * - This is a workflow-level policy composition helper, not authentication,
 *   not a security boundary, and it does not enable adapter enforcement.
 */

import { createHash } from 'node:crypto';

import { verifyProjectActivationSnapshot } from './injector.ts';
import { canonicalJson } from './json.ts';
import {
  ActivationError,
  type ActiveRule,
  type ProjectActivationCompiler,
  type ProjectActivationSnapshot,
  type RuleRef,
} from './types.ts';

export interface ApprovedTighteningTemplate {
  readonly id: string;
  readonly ruleRef: { readonly id: string; readonly version: number };
  /** Canonical JSON digest of the exact rule record in the catalog. */
  readonly ruleDigest: string;
  readonly maxTtlMs: number;
  readonly maxApplications: number;
  readonly windowMs: number;
}

export interface TighteningQuota {
  readonly maxActive: number;
  readonly maxApplications: number;
  readonly windowMs: number;
}

export interface TemporaryTighteningRecovery {
  /**
   * Applications already persisted for this generation, in application order,
   * including retired entries needed to validate later apply-time snapshots.
   */
  readonly entries: readonly AppliedTightening[];
  /** Latest persisted effective snapshot (may already reflect a prior expiry). */
  readonly currentSnapshot?: ProjectActivationSnapshot;
  /** All persisted application times used for quota windows. */
  readonly applicationTimes: readonly number[];
  /** Per-template application times used for quota windows. */
  readonly templateTimes: Readonly<Record<string, readonly number[]>>;
  /** Last trusted-clock observation; a smaller `now` is a regression. */
  readonly lastObservedAt: number;
}

export interface TemporaryTighteningOptions {
  readonly compiler: ProjectActivationCompiler;
  readonly base: ProjectActivationSnapshot;
  readonly templates: readonly ApprovedTighteningTemplate[];
  readonly quota: TighteningQuota;
  readonly now: () => number;
  /** Caller supplies the next version/base identity; never derived from model text. */
  readonly newProjectConfigVersion: string;
  readonly newBaseVersion: string;
  /**
   * Optional SQLite-backed recovery state. Persisted TTLs are preserved; this
   * module never re-applies an old entry with a fresh clock or resets quota.
   */
  readonly recovered?: TemporaryTighteningRecovery;
}

export interface AppliedTightening {
  readonly snapshot: ProjectActivationSnapshot;
  readonly templateId: string;
  readonly ruleRef: { readonly id: string; readonly version: number };
  readonly appliedAt: number;
  readonly expiresAt: number;
  readonly epoch: number;
  /** Set when the application has expired and no longer contributes a rule. */
  readonly retiredAt?: number;
}

export interface TemporaryTighteningPublisher {
  apply(templateId: string, ttlMs: number): AppliedTightening;
  /** Recompute without expired entries; never renews and never adds rules. */
  expire(): { readonly snapshot: ProjectActivationSnapshot; readonly expired: readonly string[] };
  active(): readonly AppliedTightening[];
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Digest of one exact rule record. Approval templates must call this with the
 * project-expanded record that the compiler will actually activate.
 */
export function tighteningRuleDigest(rule: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(rule), 'utf8').digest('hex')}`;
}

interface PublisherConfig {
  readonly compiler: ProjectActivationCompiler;
  readonly base: ProjectActivationSnapshot;
  readonly templates: ReadonlyMap<string, ApprovedTighteningTemplate>;
  readonly quota: TighteningQuota;
  readonly now: () => number;
  readonly newProjectConfigVersion: string;
  readonly newBaseVersion: string;
}

/** Publisher over an optional caller-supplied recovery state. */
export function createTemporaryTighteningPublisher(
  options: TemporaryTighteningOptions,
): TemporaryTighteningPublisher {
  const config = readPublisherConfig(options);
  const {
    compiler,
    base,
    templates,
    quota,
    now: optionsNow,
    newProjectConfigVersion,
    newBaseVersion,
  } = config;
  let currentSnapshot = base;
  let activeEntries: AppliedTightening[] = [];
  // Trusted-clock observations used only for quota windows. They are never
  // cleared by apply/expire cycles, so a retry cannot reset the quota.
  let applicationTimes: number[] = [];
  let templateTimes = new Map<string, number[]>();
  let lastObserved: number | null = null;

  if (options.recovered !== undefined) {
    const recovered = readRecovery(options.recovered, base);
    currentSnapshot = recovered.currentSnapshot;
    activeEntries = recovered.entries;
    applicationTimes = recovered.applicationTimes;
    templateTimes = recovered.templateTimes;
    lastObserved = recovered.lastObservedAt;
  }

  function readNow(): number {
    let value: number;
    try {
      value = optionsNow();
    } catch {
      throw new ActivationError();
    }
    if (!Number.isFinite(value) || (lastObserved !== null && value < lastObserved)) {
      throw new ActivationError();
    }
    lastObserved = value;
    return value;
  }

  function compileProject(
    previous: ProjectActivationSnapshot,
    selectedRuleRefs: readonly RuleRef[],
    epoch: number,
    added: readonly RuleRef[],
    removed: readonly RuleRef[],
  ): ProjectActivationSnapshot {
    let compiled: ProjectActivationSnapshot;
    try {
      compiled = verifyProjectActivationSnapshot(compiler.compile({
        ...previous.project,
        projectConfigVersion: newProjectConfigVersion,
        baseVersion: newBaseVersion,
        epoch,
        selectedRuleRefs: [...selectedRuleRefs],
      }));
    } catch {
      throw new ActivationError();
    }
    assertAppendOnly(previous, compiled, selectedRuleRefs, added, removed, {
      projectConfigVersion: newProjectConfigVersion,
      baseVersion: newBaseVersion,
      epoch,
    });
    return compiled;
  }

  function applyInternal(templateId: string, ttlMs: number): AppliedTightening {
    const now = readNow();
    if (typeof templateId !== 'string') throw new ActivationError();
    const template = templates.get(templateId);
    if (template === undefined) throw new ActivationError();
    if (
      typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 || ttlMs > template.maxTtlMs
    ) throw new ActivationError();
    const expiresAt = now + ttlMs;
    if (!Number.isFinite(expiresAt)) throw new ActivationError();

    const ref = template.ruleRef;
    // A tightening must add a rule that is not already part of this activation;
    // re-applying an active rule is not a tightening and cannot extend TTL.
    if (currentSnapshot.activeRules.some((item) => item.id === ref.id)) {
      throw new ActivationError();
    }
    if (activeEntries.some((entry) => entry.ruleRef.id === ref.id && entry.ruleRef.version === ref.version)) {
      throw new ActivationError();
    }
    if (activeEntries.length + 1 > quota.maxActive) throw new ActivationError();
    if (countWithin(applicationTimes, now, quota.windowMs) >= quota.maxApplications) {
      throw new ActivationError();
    }
    const perTemplate = templateTimes.get(template.id) ?? [];
    if (countWithin(perTemplate, now, template.windowMs) >= template.maxApplications) {
      throw new ActivationError();
    }

    const selectedRuleRefs = [
      ...currentSnapshot.project.selectedRuleRefs,
      { id: ref.id, version: ref.version },
    ];
    const compiled = compileProject(
      currentSnapshot,
      selectedRuleRefs,
      currentSnapshot.epoch + 1,
      [ref],
      [],
    );

    const activated = compiled.activeRules.find(
      (item) => item.id === ref.id && item.version === ref.version,
    );
    if (activated === undefined || activated.rule === null) throw new ActivationError();
    const record = activated.rule;
    if (activated.mandatory) throw new ActivationError();
    // Strict tightening: no zero-layer rules, no advisory-only rules, no
    // relaxation (`log`/`allow`). Deterministic `deny`/`confirm` only.
    if (record.expressivity !== 'deterministic') throw new ActivationError();
    if (typeof record.id !== 'string' || record.id !== ref.id) throw new ActivationError();
    if (
      typeof record.level !== 'number' || !Number.isSafeInteger(record.level) ||
      record.level <= 0
    ) throw new ActivationError();
    if (record.on_hit !== 'deny' && record.on_hit !== 'confirm') throw new ActivationError();
    if (tighteningRuleDigest(record) !== template.ruleDigest) throw new ActivationError();

    const applied: AppliedTightening = Object.freeze({
      snapshot: compiled,
      templateId: template.id,
      ruleRef: Object.freeze({ id: ref.id, version: ref.version }),
      appliedAt: now,
      expiresAt,
      epoch: compiled.epoch,
    });
    applicationTimes.push(now);
    templateTimes.set(template.id, [...perTemplate, now]);
    activeEntries = [...activeEntries, applied];
    currentSnapshot = compiled;
    return applied;
  }

  return Object.freeze({
    apply(templateId: string, ttlMs: number): AppliedTightening {
      try {
        return applyInternal(templateId, ttlMs);
      } catch {
        throw new ActivationError();
      }
    },

    expire(): { readonly snapshot: ProjectActivationSnapshot; readonly expired: readonly string[] } {
      try {
        const now = readNow();
        const expired = activeEntries.filter((entry) => now >= entry.expiresAt);
        if (expired.length === 0) {
          return Object.freeze({
            snapshot: currentSnapshot,
            expired: Object.freeze([] as string[]),
          });
        }
        const expiredRefs = expired.map((entry) => entry.ruleRef);
        const keyOf = (ref: RuleRef): string => `${ref.id}\0${ref.version}`;
        const expiredKeys = new Set(expiredRefs.map(keyOf));
        const selectedRuleRefs = currentSnapshot.project.selectedRuleRefs.filter(
          (ref) => !expiredKeys.has(keyOf(ref)),
        );
        // One compile and one epoch increment for the whole expiry batch.
        const compiled = compileProject(
          currentSnapshot,
          selectedRuleRefs,
          currentSnapshot.epoch + 1,
          [],
          expiredRefs,
        );
        activeEntries = activeEntries.filter((entry) => now < entry.expiresAt);
        currentSnapshot = compiled;
        return Object.freeze({
          snapshot: compiled,
          expired: Object.freeze(expired.map((entry) => entry.templateId)),
        });
      } catch {
        throw new ActivationError();
      }
    },

    /** Entries not yet retired by `expire()`; TTL is enforced by `expire()`. */
    active(): readonly AppliedTightening[] {
      return Object.freeze([...activeEntries]);
    },
  });
}

export function validateApprovedTighteningTemplates(
  value: unknown,
): readonly ApprovedTighteningTemplate[] {
  try {
    return Object.freeze([...readTemplates(value).values()]);
  } catch {
    throw new ActivationError();
  }
}

export function validateTighteningQuota(value: unknown): TighteningQuota {
  try {
    return readQuota(value);
  } catch {
    throw new ActivationError();
  }
}

interface NormalizedRecovery {
  readonly entries: AppliedTightening[];
  readonly currentSnapshot: ProjectActivationSnapshot;
  readonly applicationTimes: number[];
  readonly templateTimes: Map<string, number[]>;
  readonly lastObservedAt: number;
}

function readRecovery(value: unknown, base: ProjectActivationSnapshot): NormalizedRecovery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationError();
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['entries', 'currentSnapshot', 'applicationTimes', 'templateTimes', 'lastObservedAt']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ActivationError();
  }
  if (!Array.isArray(raw.entries) || raw.entries.length > 64) throw new ActivationError();
  if (typeof raw.lastObservedAt !== 'number' || !Number.isSafeInteger(raw.lastObservedAt) || raw.lastObservedAt < 0) {
    throw new ActivationError();
  }
  const entries: AppliedTightening[] = [];
  const keyOf = (ref: RuleRef): string => `${ref.id}\0${ref.version}`;
  const baseKeys = new Set(base.activeRules.map(keyOf));
  const knownRules = new Map(
    base.activeRules.map((item): [string, ActiveRule] => [keyOf(item), item]),
  );
  let sawEntry = false;
  let previousAppliedAt = -1;
  let previousEpoch = base.epoch;
  for (const candidate of raw.entries) {
    const entry = readRecoveredEntry(candidate);
    sawEntry = true;
    if (entry.appliedAt <= previousAppliedAt) throw new ActivationError();
    previousAppliedAt = entry.appliedAt;
    if (
      entry.snapshot.project.projectId !== base.project.projectId ||
      entry.snapshot.project.workspace !== base.project.workspace ||
      entry.snapshot.project.baseVersion !== base.project.baseVersion
    ) {
      throw new ActivationError();
    }
    // Each application adds exactly one rule to a snapshot of the same
    // generation. Expiry later removes rules, so a historical snapshot may
    // contain retired entries but never an unknown or rewritten one.
    if (entry.epoch <= previousEpoch) throw new ActivationError();
    previousEpoch = entry.epoch;
    const entryKey = keyOf(entry.ruleRef);
    if (!entry.snapshot.activeRules.some((item) => keyOf(item) === entryKey)) {
      throw new ActivationError();
    }
    assertSameImmutableProjection(base, entry.snapshot);
    for (const item of entry.snapshot.activeRules) {
      const key = keyOf(item);
      const known = knownRules.get(key);
      if (known === undefined) {
        if (key !== entryKey) throw new ActivationError();
        knownRules.set(key, item);
      } else if (canonicalJson(known) !== canonicalJson(item)) {
        throw new ActivationError();
      }
    }
    if (entry.retiredAt === undefined) entries.push(entry);
  }

  let currentSnapshot: ProjectActivationSnapshot;
  if (raw.currentSnapshot !== undefined) {
    currentSnapshot = verifyProjectActivationSnapshot(raw.currentSnapshot);
    if (
      currentSnapshot.project.projectId !== base.project.projectId ||
      currentSnapshot.project.workspace !== base.project.workspace ||
      currentSnapshot.project.baseVersion !== base.project.baseVersion
    ) {
      throw new ActivationError();
    }
    if (currentSnapshot.epoch < previousEpoch) throw new ActivationError();
    assertSameImmutableProjection(base, currentSnapshot);
    for (const item of currentSnapshot.activeRules) {
      const known = knownRules.get(keyOf(item));
      if (known === undefined || canonicalJson(known) !== canonicalJson(item)) {
        throw new ActivationError();
      }
    }
    const activeKeys = new Set(entries.map((entry) => keyOf(entry.ruleRef)));
    for (const key of activeKeys) {
      if (!currentSnapshot.activeRules.some((item) => keyOf(item) === key)) {
        throw new ActivationError();
      }
    }
    // Base rules cannot disappear without an expiry record.
    for (const key of baseKeys) {
      if (currentSnapshot.activeRules.some((item) => keyOf(item) === key)) continue;
      throw new ActivationError();
    }
  } else {
    // A tightened generation always persists its current snapshot; rows
    // without one cannot be reconstructed safely.
    if (sawEntry) throw new ActivationError();
    currentSnapshot = base;
  }

  if (raw.lastObservedAt < previousAppliedAt) {
    // A restart behind a persisted application is a clock regression, never a
    // reason to re-heal or extend the TTL.
    throw new ActivationError();
  }
  if (!Array.isArray(raw.applicationTimes)) throw new ActivationError();
  const applicationTimes = raw.applicationTimes.map(readRecoveredTime);
  if (!isPlainRecoveryRecord(raw.templateTimes)) throw new ActivationError();
  const templateTimes = new Map<string, number[]>();
  for (const [templateId, times] of Object.entries(raw.templateTimes)) {
    if (typeof templateId !== 'string' || templateId.length === 0) throw new ActivationError();
    if (!Array.isArray(times)) throw new ActivationError();
    templateTimes.set(templateId, times.map(readRecoveredTime));
  }

  return {
    entries,
    currentSnapshot,
    applicationTimes,
    templateTimes,
    lastObservedAt: raw.lastObservedAt,
  };
}

function readRecoveredEntry(value: unknown): AppliedTightening {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationError();
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['snapshot', 'templateId', 'ruleRef', 'appliedAt', 'expiresAt', 'epoch', 'retiredAt']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ActivationError();
  }
  if (typeof raw.templateId !== 'string' || raw.templateId.length === 0 || raw.templateId.length > 160) {
    throw new ActivationError();
  }
  if (raw.ruleRef === null || typeof raw.ruleRef !== 'object' || Array.isArray(raw.ruleRef)) {
    throw new ActivationError();
  }
  const ref = raw.ruleRef as Record<string, unknown>;
  if (
    typeof ref.id !== 'string' || ref.id.length === 0 || ref.id.length > 160 ||
    typeof ref.version !== 'number' || !Number.isSafeInteger(ref.version) || ref.version < 1
  ) throw new ActivationError();
  const appliedAt = readRecoveredTime(raw.appliedAt);
  const expiresAt = readRecoveredTime(raw.expiresAt);
  const epoch = raw.epoch;
  if (expiresAt <= appliedAt) throw new ActivationError();
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) throw new ActivationError();
  const retiredAt = raw.retiredAt === undefined ? undefined : readRecoveredTime(raw.retiredAt);
  if (retiredAt !== undefined && retiredAt < appliedAt) throw new ActivationError();
  const snapshot = verifyProjectActivationSnapshot(raw.snapshot);
  if (snapshot.epoch !== epoch) throw new ActivationError();
  return Object.freeze({
    snapshot,
    templateId: raw.templateId,
    ruleRef: Object.freeze({ id: ref.id, version: ref.version }),
    appliedAt,
    expiresAt,
    epoch,
    ...(retiredAt === undefined ? {} : { retiredAt }),
  });
}

function readRecoveredTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ActivationError();
  }
  return value;
}

function isPlainRecoveryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countWithin(times: readonly number[], now: number, windowMs: number): number {
  let count = 0;
  for (const time of times) {
    if (now - time < windowMs) count += 1;
  }
  return count;
}

interface ExpectedIdentity {
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
}

function assertAppendOnly(
  previous: ProjectActivationSnapshot,
  next: ProjectActivationSnapshot,
  expectedSelectedRefs: readonly RuleRef[],
  added: readonly RuleRef[],
  removed: readonly RuleRef[],
  expected: ExpectedIdentity,
): void {
  if (
    next.project.projectId !== previous.project.projectId ||
    next.project.workspace !== previous.project.workspace
  ) throw new ActivationError();
  if (canonicalJson(next.project.excludedRuleIds) !== canonicalJson(previous.project.excludedRuleIds)) {
    throw new ActivationError();
  }
  if (canonicalJson(next.project.advisoryBaselineRuleIds) !== canonicalJson(previous.project.advisoryBaselineRuleIds)) {
    throw new ActivationError();
  }
  if (canonicalJson(next.project.routes) !== canonicalJson(previous.project.routes)) {
    throw new ActivationError();
  }
  if (canonicalJson(next.project.selectedRuleRefs) !== canonicalJson(expectedSelectedRefs)) {
    throw new ActivationError();
  }
  if (next.project.projectConfigVersion !== expected.projectConfigVersion) throw new ActivationError();
  if (next.project.baseVersion !== expected.baseVersion) throw new ActivationError();
  if (next.epoch !== expected.epoch || next.project.epoch !== expected.epoch) {
    throw new ActivationError();
  }

  const keyOf = (ref: RuleRef): string => `${ref.id}\0${ref.version}`;
  const addedKeys = new Set(added.map(keyOf));
  const removedKeys = new Set(removed.map(keyOf));
  const previousRules = new Map(
    previous.activeRules.map((item): [string, ActiveRule] => [keyOf(item), item]),
  );
  const nextRules = new Map(
    next.activeRules.map((item): [string, ActiveRule] => [keyOf(item), item]),
  );
  // A duplicate key would silently drop one record from the map.
  if (nextRules.size !== next.activeRules.length) throw new ActivationError();

  for (const [key, before] of previousRules) {
    const after = nextRules.get(key);
    if (after === undefined) {
      if (!removedKeys.has(key)) throw new ActivationError();
      continue;
    }
    if (removedKeys.has(key)) throw new ActivationError();
    if (after.mandatory !== before.mandatory) throw new ActivationError();
    // Byte-identical rule record, provenance, injection metadata and version.
    if (canonicalJson(after) !== canonicalJson(before)) throw new ActivationError();
  }
  for (const key of nextRules.keys()) {
    if (!previousRules.has(key) && !addedKeys.has(key)) throw new ActivationError();
  }
  for (const key of addedKeys) {
    const after = nextRules.get(key);
    if (after === undefined) throw new ActivationError();
    if (after.mandatory) throw new ActivationError();
  }

  assertSameAdvisory(previous, next);
}

function assertSameImmutableProjection(
  previous: ProjectActivationSnapshot,
  next: ProjectActivationSnapshot,
): void {
  if (canonicalJson(next.project.excludedRuleIds) !== canonicalJson(previous.project.excludedRuleIds)) {
    throw new ActivationError();
  }
  if (canonicalJson(next.project.advisoryBaselineRuleIds) !== canonicalJson(previous.project.advisoryBaselineRuleIds)) {
    throw new ActivationError();
  }
  if (canonicalJson(next.project.routes) !== canonicalJson(previous.project.routes)) {
    throw new ActivationError();
  }
  assertSameAdvisory(previous, next);
}

function assertSameAdvisory(
  previous: ProjectActivationSnapshot,
  next: ProjectActivationSnapshot,
): void {
  // The advisory projection may change its identity (epoch/version), but it
  // must not gain, lose, or rewrite a narrative. A tightening is hard-rule only.
  const beforeAdvisory = previous.advisory;
  const afterAdvisory = next.advisory;
  if (beforeAdvisory.status !== afterAdvisory.status) throw new ActivationError();
  if (beforeAdvisory.status === 'ready') {
    if (afterAdvisory.status !== 'ready') throw new ActivationError();
    if (canonicalJson(afterAdvisory.ruleRefs) !== canonicalJson(beforeAdvisory.ruleRefs)) {
      throw new ActivationError();
    }
    if (canonicalJson(afterAdvisory.snapshot.rules) !== canonicalJson(beforeAdvisory.snapshot.rules)) {
      throw new ActivationError();
    }
    if (canonicalJson(afterAdvisory.snapshot.routes) !== canonicalJson(beforeAdvisory.snapshot.routes)) {
      throw new ActivationError();
    }
    if (
      canonicalJson(afterAdvisory.snapshot.baselineRuleIds) !==
      canonicalJson(beforeAdvisory.snapshot.baselineRuleIds)
    ) throw new ActivationError();
  } else {
    if (afterAdvisory.status !== 'empty' || afterAdvisory.snapshot !== null) {
      throw new ActivationError();
    }
  }
}

function readTemplates(value: unknown): ReadonlyMap<string, ApprovedTighteningTemplate> {
  if (!Array.isArray(value)) throw new Error('invalid_templates');
  const result = new Map<string, ApprovedTighteningTemplate>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid_template');
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 160 || id.includes('\0')) {
      throw new Error('invalid_template_id');
    }
    if (result.has(id)) throw new Error('duplicate_template');
    const ruleRef = record.ruleRef;
    if (ruleRef === null || typeof ruleRef !== 'object' || Array.isArray(ruleRef)) {
      throw new Error('invalid_template_ref');
    }
    const ref = ruleRef as Record<string, unknown>;
    const refId = ref.id;
    const version = ref.version;
    if (typeof refId !== 'string' || refId.trim().length === 0 || refId.length > 160 || refId.includes('\0')) {
      throw new Error('invalid_template_ref');
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw new Error('invalid_template_ref');
    }
    const ruleDigest = record.ruleDigest;
    if (typeof ruleDigest !== 'string' || !DIGEST_PATTERN.test(ruleDigest)) {
      throw new Error('invalid_template_digest');
    }
    const maxTtlMs = record.maxTtlMs;
    if (typeof maxTtlMs !== 'number' || !Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) {
      throw new Error('invalid_template_ttl');
    }
    const maxApplications = record.maxApplications;
    if (typeof maxApplications !== 'number' || !Number.isSafeInteger(maxApplications) || maxApplications < 0) {
      throw new Error('invalid_template_quota');
    }
    const windowMs = record.windowMs;
    if (typeof windowMs !== 'number' || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error('invalid_template_window');
    }
    result.set(id, Object.freeze({
      id,
      ruleRef: Object.freeze({ id: refId, version }),
      ruleDigest,
      maxTtlMs,
      maxApplications,
      windowMs,
    }));
  }
  return result;
}

function readQuota(value: unknown): TighteningQuota {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_quota');
  }
  const record = value as Record<string, unknown>;
  const maxActive = record.maxActive;
  const maxApplications = record.maxApplications;
  const windowMs = record.windowMs;
  if (typeof maxActive !== 'number' || !Number.isSafeInteger(maxActive) || maxActive < 0) {
    throw new Error('invalid_quota');
  }
  if (typeof maxApplications !== 'number' || !Number.isSafeInteger(maxApplications) || maxApplications < 0) {
    throw new Error('invalid_quota');
  }
  if (typeof windowMs !== 'number' || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error('invalid_quota');
  }
  return Object.freeze({ maxActive, maxApplications, windowMs });
}

function readClock(value: unknown): () => number {
  if (typeof value !== 'function') throw new Error('invalid_clock');
  return value as () => number;
}

function readVersion(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160 || value.includes('\0')) {
    throw new Error('invalid_version');
  }
  return value;
}

function readPublisherConfig(raw: unknown): PublisherConfig {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('invalid_options');
    }
    const options = raw as Record<string, unknown>;
    const compiler = options.compiler;
    if (
      compiler === null || typeof compiler !== 'object' ||
      typeof (compiler as { compile?: unknown }).compile !== 'function'
    ) throw new Error('invalid_compiler');
    return Object.freeze({
      compiler: compiler as ProjectActivationCompiler,
      base: verifyProjectActivationSnapshot(options.base),
      templates: readTemplates(options.templates),
      quota: readQuota(options.quota),
      now: readClock(options.now),
      newProjectConfigVersion: readVersion(options.newProjectConfigVersion),
      newBaseVersion: readVersion(options.newBaseVersion),
    });
  } catch {
    throw new ActivationError();
  }
}
