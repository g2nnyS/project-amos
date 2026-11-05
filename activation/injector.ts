import { createInjectorSession, type InjectionBlock, type InjectorSession, type StructuralAction } from '../injector/session.ts';
import { compileAdvisorySnapshot, type AdvisorySnapshot, type InjectionInput } from '../injector/snapshot.ts';
import { ActivationError, type ProjectActivationSnapshot, type RuleRef } from './types.ts';
import { canonicalJson, digest } from './json.ts';

export interface ProjectInjectionBlock extends InjectionBlock {
  readonly projectId: string;
  readonly workspace: string;
  readonly catalogVersion: string;
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly activationDigest: string;
  readonly advisoryProjectionDigest: string;
  readonly mode: 'advisory';
}

export interface ProjectInjectorSession {
  selectPrompt(prompt: string): ProjectInjectionBlock;
  select(input: Omit<InjectionInput, 'alreadyInjected'>): ProjectInjectionBlock;
  queueAction(action: StructuralAction, projectDirectory: string): boolean;
  selectPendingArea(): ProjectInjectionBlock | null;
  commit(block: ProjectInjectionBlock): void;
}

/**
 * Bind the current selector/render/session machinery to one complete activation
 * snapshot. The caller cannot supply enforcement and advisory pairings separately.
 */
/**
 * Bind one verified offline activation snapshot to an advisory session.
 * A fixed time is useful for replay; a clock callback is sampled for each
 * selection so advisory TTL does not extend during a long-lived session.
 */
export function createProjectInjectorSession(
  value: ProjectActivationSnapshot,
  now: number | (() => number),
): ProjectInjectorSession {
  try {
    const readNow = typeof now === 'function' ? now : () => now;
    const initialTime = readNow();
    if (!Number.isFinite(initialTime)) throw new Error('invalid_time');
    const snapshot = verifyProjectActivationSnapshot(value);
    const live = snapshot.advisory.status === 'ready'
      ? snapshot.advisory.snapshot.rules.filter((rule) => rule.ttl === null || initialTime < rule.ttl)
      : [];
    const effective = snapshot.advisory.status === 'ready' && live.length > 0
      ? Object.freeze({
          ...snapshot.advisory.snapshot,
          rules: Object.freeze(live),
          baselineRuleIds: Object.freeze(snapshot.advisory.snapshot.baselineRuleIds.filter(
            (id) => live.some((rule) => rule.id === id),
          )),
        })
      : null;
    const inner = effective === null ? null : createInjectorSession(effective, { now: readNow, initialNow: initialTime });
    const wrapped = new WeakMap<ProjectInjectionBlock, InjectionBlock>();

    const decorate = (block: InjectionBlock): ProjectInjectionBlock => {
      const text = bindBlockText(block.text, snapshot);
      const result: ProjectInjectionBlock = Object.freeze({
        ...block,
        text,
        projectId: snapshot.project.projectId,
        workspace: snapshot.project.workspace,
        catalogVersion: snapshot.catalogVersion,
        projectConfigVersion: snapshot.project.projectConfigVersion,
        baseVersion: snapshot.project.baseVersion,
        epoch: snapshot.epoch,
        activationDigest: snapshot.activationDigest,
        advisoryProjectionDigest: snapshot.advisory.digest,
        mode: 'advisory',
      });
      wrapped.set(result, block);
      return result;
    };

    const emptyBlock = (): ProjectInjectionBlock => decorate(Object.freeze({
      text: '',
      ruleIds: Object.freeze([]),
      droppedRuleIds: Object.freeze([]),
      policyVersion: snapshot.project.projectConfigVersion,
      advisoryDigest: snapshot.advisory.status === 'ready'
        ? snapshot.advisory.snapshot.advisoryDigest
        : snapshot.advisory.digest,
      channel: 'prompt' as const,
      area: null,
      selectedRefs: Object.freeze([]),
      omittedRefs: Object.freeze([]),
      incomplete: false,
      fallbackReason: null,
    }));

    const output = (block: InjectionBlock | null): ProjectInjectionBlock | null =>
      block === null ? null : decorate(block);

    return Object.freeze({
      selectPrompt(prompt: string) {
        return inner === null ? emptyBlock() : decorate(inner.selectPrompt(prompt));
      },
      select(input: Omit<InjectionInput, 'alreadyInjected'>) {
        return inner === null ? emptyBlock() : decorate(inner.select(input));
      },
      queueAction: (action: StructuralAction, projectDirectory: string) => inner?.queueAction(action, projectDirectory) ?? false,
      selectPendingArea() {
        return output(inner?.selectPendingArea() ?? null);
      },
      commit(block: ProjectInjectionBlock) {
        const original = wrapped.get(block);
        if (original !== undefined) inner?.commit(original);
      },
    });
  } catch {
    throw new ActivationError();
  }
}

/**
 * Structural consistency check for one compiled activation snapshot: format
 * identity, content digests, projection completeness/pairing, advisory
 * reproduction and deep freezing. This is not a signature or source
 * authentication; it only proves the value is internally consistent.
 */
export function verifyProjectActivationSnapshot(input: unknown): ProjectActivationSnapshot {
  if (input === null || typeof input !== 'object') throw new Error('invalid_snapshot');
  const value = input as ProjectActivationSnapshot;
  if (
    value.format !== 'amos-unified-rule-catalog' || value.formatVersion !== 2 ||
    value.compilerVersion !== 'amos-unified-rule-catalog-v2' || value.mode !== 'offline-shadow' ||
    !isDeepFrozen(value)
  ) throw new Error('invalid_snapshot');

  const project = value.project;
  const activationDigest = digest('amos-project-activation-content-v2', {
    compilerVersion: value.compilerVersion,
    catalogVersion: value.catalogVersion,
    schemaDigest: value.schemaDigest,
    project,
    activeRules: value.activeRules,
  });
  if (activationDigest !== value.activationDigest || value.epoch !== project.epoch) throw new Error('activation_identity_mismatch');

  const active = new Map<string, ProjectActivationSnapshot['activeRules'][number]>(
    value.activeRules.map((item) => [`${item.id}\0${item.version}`, item]),
  );
  const common = {
    projectId: project.projectId,
    workspace: project.workspace,
    catalogVersion: value.catalogVersion,
    projectConfigVersion: project.projectConfigVersion,
    baseVersion: project.baseVersion,
    epoch: project.epoch,
    activationDigest,
  };
  for (const checkpoint of ['runtime', 'ci', 'server'] as const) {
    const projection = value.enforcement[checkpoint];
    for (const [key, expected] of Object.entries(common)) {
      if (projection[key as keyof typeof projection] !== expected) throw new Error('mixed_projection');
    }
    const expectedRefs = value.activeRules
      .filter((item) => item.rule !== null && item.rule.expressivity === 'deterministic' && item.rule.enforcement === checkpoint)
      .map(({ id, version }) => ({ id, version }));
    if (projection.checkpoint !== checkpoint || canonicalJson(projection.ruleRefs) !== canonicalJson(expectedRefs)) {
      throw new Error('incomplete_execution_projection');
    }
    const expectedRules = projection.ruleRefs.map((ref) => {
      const entry = active.get(refKey(ref));
      if (entry?.rule === null || entry === undefined) throw new Error('foreign_execution_ref');
      if (entry.rule.expressivity !== 'deterministic' || entry.rule.enforcement !== checkpoint) {
        throw new Error('wrong_execution_checkpoint');
      }
      return entry.rule;
    });
    if (canonicalJson(expectedRules) !== canonicalJson(projection.rules)) throw new Error('execution_ref_mismatch');
    if (projection.status !== (projection.rules.length === 0 ? 'empty' : 'ready')) throw new Error('invalid_empty_status');
    if (projection.digest !== digest(`amos-unified-execution-${checkpoint}-v2`, {
      ...common,
      ruleRefs: projection.ruleRefs,
      rules: projection.rules,
    })) throw new Error('execution_digest_mismatch');
  }

  const advisory = value.advisory;
  for (const [key, expected] of Object.entries(common)) {
    if (advisory[key as keyof typeof advisory] !== expected) throw new Error('mixed_advisory');
  }
  if (advisory.status === 'ready') {
    if (advisory.snapshot === null || advisory.snapshot.projectId !== project.projectId) throw new Error('invalid_advisory');
    const enforcementRefs = value.activeRules
      .filter((item) => item.rule?.expressivity === 'deterministic')
      .map(({ id, version }) => ({ id, version }));
    const rebuilt = compileAdvisorySnapshot({
      policyVersion: project.projectConfigVersion,
      engineVersion: value.compilerVersion,
      projectId: project.projectId,
      baselineRuleIds: project.advisoryBaselineRuleIds,
      routes: project.routes,
      rules: value.activeRules.filter((item) => item.injection !== null).map((item) => {
        const raw = item.rule;
        const injection = item.injection!;
        const source = item.provenance.kind === 'guidance-pack-seed'
          ? item.provenance.sourceRef
          : canonicalJson(raw?.source);
        return {
          ...injection,
          id: item.id,
          ruleVersion: item.version,
          level: raw === null ? injection.level : raw?.level,
          narrative: raw === null ? item.narrative : raw?.narrative,
          source,
          owner: raw === null ? 'repository guidance' : raw?.owner,
          ttl: raw === null || raw?.ttl === null ? null : Date.parse(raw?.ttl as string),
          narrativeVersion: item.version,
          pairedRuleId: raw?.expressivity === 'deterministic' ? item.id : null,
          pairedRuleVersion: raw?.expressivity === 'deterministic' ? item.version : null,
        };
      }),
    }, {
      activeEnforcementRuleIds: enforcementRefs.map(({ id }) => id),
      activeEnforcementRuleRefs: enforcementRefs,
    });
    if (canonicalJson(rebuilt) !== canonicalJson(advisory.snapshot)) throw new Error('advisory_content_mismatch');
    const expectedRefs = rebuilt.rules.map(({ id, ruleVersion }) => ({ id, version: ruleVersion }));
    if (canonicalJson(expectedRefs) !== canonicalJson(advisory.ruleRefs)) throw new Error('advisory_ref_mismatch');
    if (advisory.digest !== digest('amos-unified-advisory-v2', {
      ...common,
      ruleRefs: advisory.ruleRefs,
      snapshot: advisory.snapshot,
    })) throw new Error('advisory_digest_mismatch');
  } else if (advisory.status === 'empty') {
    if (value.activeRules.some((item) => item.injection !== null) || advisory.snapshot !== null || advisory.ruleRefs.length !== 0 || project.routes.length !== 0 || project.advisoryBaselineRuleIds.length !== 0) {
      throw new Error('invalid_empty_advisory');
    }
    if (advisory.digest !== digest('amos-unified-advisory-v2', { ...common, status: 'empty' })) {
      throw new Error('advisory_digest_mismatch');
    }
  } else {
    throw new Error('invalid_advisory_status');
  }

  const { digest: snapshotDigest, ...content } = value;
  if (snapshotDigest !== digest('amos-unified-activation-snapshot-v2', content)) throw new Error('snapshot_digest_mismatch');
  return value;
}

function refKey(ref: RuleRef): string {
  return `${ref.id}\0${ref.version}`;
}

function bindBlockText(text: string, snapshot: ProjectActivationSnapshot): string {
  if (text.length === 0) return text;
  return text.replace(
    '<amos-guidance ',
    `<amos-guidance project="${escapeAttribute(snapshot.project.projectId)}" activation="${snapshot.activationDigest}" epoch="${snapshot.epoch}" advisory-projection="${snapshot.advisory.digest}" `,
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => isDeepFrozen(child, seen));
}
