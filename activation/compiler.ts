import { Ajv } from 'ajv';
import { assertValidTable } from '../engine/engine.ts';
import {
  compileAdvisorySnapshot,
  type AdvisoryRule,
  type InjectionRoute,
} from '../injector/snapshot.ts';
import {
  boundedCopy,
  canonicalJson,
  deepFreeze,
  digest,
  list,
  MAX_BYTES,
  record,
  text,
  uniqueStrings,
  workspace,
} from './json.ts';
import {
  ACTIVATION_COMPILER_VERSION,
  ACTIVATION_FORMAT,
  ACTIVATION_FORMAT_VERSION,
  ActivationError,
  type ActiveRule,
  type AdvisoryProjection,
  type ExecutionProjection,
  type InjectionMetadata,
  type ProjectActivationCompiler,
  type ProjectActivationInput,
  type ProjectActivationSnapshot,
  type ProjectIdentity,
  type RuleProvenance,
  type RuleRef,
  type VersionedRule,
} from './types.ts';

const TOKEN = '${SESSION_WORKSPACE}';
const PROJECT_KEYS = [
  'projectId',
  'workspace',
  'projectConfigVersion',
  'baseVersion',
  'epoch',
  'selectedRuleRefs',
  'excludedRuleIds',
  'advisoryBaselineRuleIds',
  'routes',
] as const;
const SNAPSHOT_KEYS = [
  'format',
  'formatVersion',
  'compilerVersion',
  'mode',
  'catalogVersion',
  'schemaDigest',
  'project',
  'activeRules',
  'epoch',
  'activationDigest',
  'enforcement',
  'advisory',
  'digest',
] as const;
const CATALOG_KEYS = ['catalogVersion', 'rawSchema', 'rules', 'mandatoryRuleRefs'] as const;
const ENTRY_KEYS = ['id', 'version', 'rule', 'narrative', 'provenance', 'injection'] as const;
const INJECTION_KEYS = [
  'level',
  'areas',
  'languages',
  'frameworks',
  'pathHints',
  'taskTags',
  'keywords',
  'tags',
  'specificity',
  'priority',
] as const;

/** Fixed catalog + explicit baseline; this is an offline content compiler only. */
export function createProjectActivationCompiler(rawOptions: unknown): ProjectActivationCompiler {
  try {
    return createCompiler(rawOptions);
  } catch {
    throw new ActivationError();
  }
}

function createCompiler(rawOptions: unknown): ProjectActivationCompiler {
  const options = record(boundedCopy(rawOptions), CATALOG_KEYS);
  if (typeof options.rawSchema !== 'string' || options.rawSchema.length > MAX_BYTES) {
    throw new Error('invalid_schema');
  }
  const schema: unknown = JSON.parse(options.rawSchema);
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('invalid_schema');
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const catalogVersion = text(options.catalogVersion);
  const schemaDigest = digest('amos-unified-catalog-schema-v2', options.rawSchema);
  const catalog = new Map<string, VersionedRule>();
  const knownVersions = new Map<string, Set<number>>();

  for (const value of list(options.rules)) {
    const entry = record(value, ENTRY_KEYS);
    const id = text(entry.id);
    const version = revision(entry.version);
    const provenance = readProvenance(entry.provenance);
    const rule = entry.rule === null ? null : asRecord(entry.rule);
    let narrative: string | null;
    let injection: InjectionMetadata | null;

    if (rule === null) {
      narrative = readNarrative(entry.narrative);
      injection = readInjection(entry.injection);
      if (injection === null) throw new Error('advisory_requires_metadata');
      if (provenance.kind !== 'guidance-pack-seed') throw new Error('invalid_guidance_source');
    } else {
      if (!validate([rule])) throw new Error('invalid_rule');
      if (rule.id !== id || entry.narrative !== null) throw new Error('invalid_rule_identity');
      // Validate inactive entries too. Workspace substitution remains limited to
      // the two existing glob operators and does not change the source record.
      assertValidTable([expandRule(rule, '/__activation_validation__')]);
      injection = entry.injection === null ? null : readInjection(entry.injection);
      narrative = null;
      if (provenance.kind !== 'legacy-constraints-yaml') throw new Error('invalid_rule_source');
      if (injection !== null && injection.level !== rule.level) {
        throw new Error('hard_rule_level_mismatch');
      }
    }

    const item: VersionedRule = deepFreeze({ id, version, rule, narrative, provenance, injection });
    const key = refKey({ id, version });
    if (catalog.has(key)) throw new Error('duplicate_revision');
    catalog.set(key, item);
    const versions = knownVersions.get(id) ?? new Set<number>();
    versions.add(version);
    knownVersions.set(id, versions);

    if (injection !== null) {
      compileAdvisorySnapshot(
        {
          policyVersion: 'catalog-validation',
          engineVersion: ACTIVATION_COMPILER_VERSION,
          projectId: 'catalog-validation',
          baselineRuleIds: [],
          routes: [],
          rules: [narrativeRule(item)],
        },
        {
          activeEnforcementRuleIds: rule?.expressivity === 'deterministic' ? [id] : [],
          activeEnforcementRuleRefs: rule?.expressivity === 'deterministic' ? [{ id, version }] : [],
        },
      );
    }
  }
  if (catalog.size === 0) throw new Error('empty_catalog');

  const mandatory = readRefs(options.mandatoryRuleRefs);
  const mandatoryIds = new Set<string>();
  for (const ref of mandatory) {
    if (!catalog.has(refKey(ref)) || mandatoryIds.has(ref.id)) throw new Error('invalid_baseline');
    mandatoryIds.add(ref.id);
  }
  deepFreeze(mandatory);

  function compile(input: unknown): ProjectActivationSnapshot {
    const project = readProject(input);
    const chosen = new Map<string, RuleRef>();
    for (const ref of [...mandatory, ...project.selectedRuleRefs]) {
      if (!catalog.has(refKey(ref))) throw new Error('unknown_revision');
      const previous = chosen.get(ref.id);
      if (previous !== undefined && previous.version !== ref.version) throw new Error('conflicting_revision');
      chosen.set(ref.id, ref);
    }
    for (const id of project.excludedRuleIds) {
      if (!knownVersions.has(id) || mandatoryIds.has(id)) throw new Error('invalid_exclusion');
      chosen.delete(id);
    }
    if (chosen.size === 0) throw new Error('empty_activation');

    const activeRules: ActiveRule[] = [...chosen.values()].map((ref) => {
      const item = catalog.get(refKey(ref));
      if (item === undefined) throw new Error('missing_ref');
      return {
        ...item,
        rule: item.rule === null ? null : expandRule(item.rule, project.workspace),
        mandatory: mandatoryIds.has(ref.id),
      };
    });
    const executableRecords = activeRules.flatMap((item) => item.rule === null ? [] : [item.rule]);
    if (executableRecords.length > 0) assertValidTable(executableRecords);

    const identityContent = {
      compilerVersion: ACTIVATION_COMPILER_VERSION,
      catalogVersion,
      schemaDigest,
      project,
      activeRules,
    };
    const activationDigest = digest('amos-project-activation-content-v2', identityContent);

    const projectionIdentity = {
      projectId: project.projectId,
      workspace: project.workspace,
      catalogVersion,
      projectConfigVersion: project.projectConfigVersion,
      baseVersion: project.baseVersion,
      epoch: project.epoch,
      activationDigest,
    };

    function execution(checkpoint: 'runtime' | 'ci' | 'server'): ExecutionProjection {
      const selected = activeRules.filter(
        (item) => item.rule !== null &&
          item.rule.expressivity === 'deterministic' &&
          item.rule.enforcement === checkpoint,
      );
      const rules = selected.flatMap((item) => item.rule === null ? [] : [item.rule]);
      const ruleRefs = selected.map(({ id, version }) => ({ id, version }));
      return {
        ...projectionIdentity,
        checkpoint,
        status: rules.length === 0 ? 'empty' : 'ready',
        digest: digest(`amos-unified-execution-${checkpoint}-v2`, {
          ...projectionIdentity,
          ruleRefs,
          rules,
        }),
        ruleRefs,
        rules,
      };
    }

    const enforcement = {
      runtime: execution('runtime'),
      ci: execution('ci'),
      server: execution('server'),
    };
    const narratives = activeRules.filter((item) => item.injection !== null);
    const advisoryRefs = narratives.map(({ id, version }) => ({ id, version }));
    let advisory: AdvisoryProjection;
    if (narratives.length === 0) {
      if (project.advisoryBaselineRuleIds.length > 0 || project.routes.length > 0) {
        throw new Error('invalid_empty_advisory');
      }
      advisory = {
        ...projectionIdentity,
        status: 'empty',
        ruleRefs: [],
        snapshot: null,
        digest: digest('amos-unified-advisory-v2', { ...projectionIdentity, status: 'empty' }),
      };
    } else {
      const enforcementRefs = activeRules
        .filter((item) => item.rule?.expressivity === 'deterministic')
        .map(({ id, version }) => ({ id, version }));
      const native = compileAdvisorySnapshot(
        {
          policyVersion: project.projectConfigVersion,
          engineVersion: ACTIVATION_COMPILER_VERSION,
          projectId: project.projectId,
          baselineRuleIds: project.advisoryBaselineRuleIds,
          routes: project.routes,
          rules: narratives.map(narrativeRule),
        },
        {
          activeEnforcementRuleIds: enforcementRefs.map(({ id }) => id),
          activeEnforcementRuleRefs: enforcementRefs,
        },
      );
      advisory = {
        ...projectionIdentity,
        status: 'ready',
        ruleRefs: advisoryRefs,
        snapshot: native,
        digest: digest('amos-unified-advisory-v2', {
          ...projectionIdentity,
          ruleRefs: advisoryRefs,
          snapshot: native,
        }),
      };
    }

    const content = {
      format: ACTIVATION_FORMAT,
      formatVersion: ACTIVATION_FORMAT_VERSION,
      compilerVersion: ACTIVATION_COMPILER_VERSION,
      mode: 'offline-shadow' as const,
      catalogVersion,
      schemaDigest,
      project,
      activeRules,
      epoch: project.epoch,
      activationDigest,
      enforcement,
      advisory,
    };
    const snapshot: ProjectActivationSnapshot = {
      ...content,
      digest: digest('amos-unified-activation-snapshot-v2', content),
    };
    boundedCopy(snapshot);
    return deepFreeze(snapshot);
  }

  return Object.freeze({
    compile(input: unknown) {
      try { return compile(input); } catch { throw new ActivationError(); }
    },
    verify(value: unknown, expected: ProjectIdentity) {
      try {
        const identity = record(boundedCopy(expected), ['projectId', 'workspace']);
        const expectedProjectId = text(identity.projectId);
        const expectedWorkspace = workspace(identity.workspace);
        const candidate = record(boundedCopy(value), SNAPSHOT_KEYS);
        const project = readProject(candidate.project);
        if (project.projectId !== expectedProjectId || project.workspace !== expectedWorkspace) {
          throw new Error('identity_mismatch');
        }
        const rebuilt = compile(project);
        if (canonicalJson(candidate) !== canonicalJson(rebuilt)) throw new Error('snapshot_mismatch');
        return rebuilt;
      } catch {
        throw new ActivationError();
      }
    },
  });
}

function readProvenance(value: unknown): RuleProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_provenance');
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'legacy-constraints-yaml') {
    const input = record(candidate, ['kind', 'sourceDigest']);
    return { kind: 'legacy-constraints-yaml', sourceDigest: digestText(input.sourceDigest) };
  }
  if (candidate.kind === 'guidance-pack-seed') {
    const input = record(candidate, ['kind', 'sourceDigest', 'packId', 'packVersion', 'sourceRef']);
    return {
      kind: 'guidance-pack-seed',
      sourceDigest: digestText(input.sourceDigest),
      packId: text(input.packId),
      packVersion: text(input.packVersion),
      sourceRef: text(input.sourceRef),
    };
  }
  throw new Error('invalid_provenance_kind');
}

function digestText(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('invalid_source_digest');
  return value;
}

function readNarrative(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_000_000 || value.includes('\0')) {
    throw new Error('invalid_narrative');
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_rule_record');
  }
  return value as Record<string, unknown>;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('invalid_revision');
  return value;
}

function epoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_epoch');
  return value;
}

function readRefs(value: unknown): RuleRef[] {
  const seen = new Set<string>();
  return list(value).map((item) => {
    const input = record(item, ['id', 'version']);
    const ref = { id: text(input.id), version: revision(input.version) };
    const key = refKey(ref);
    if (seen.has(key)) throw new Error('duplicate_ref');
    seen.add(key);
    return ref;
  });
}

function refKey(ref: RuleRef): string {
  return `${ref.id}\0${ref.version}`;
}

function readProject(value: unknown): ProjectActivationInput {
  const input = record(boundedCopy(value), PROJECT_KEYS);
  return {
    projectId: text(input.projectId),
    workspace: workspace(input.workspace),
    projectConfigVersion: text(input.projectConfigVersion),
    baseVersion: text(input.baseVersion),
    epoch: epoch(input.epoch),
    selectedRuleRefs: readRefs(input.selectedRuleRefs),
    excludedRuleIds: uniqueStrings(input.excludedRuleIds),
    advisoryBaselineRuleIds: uniqueStrings(input.advisoryBaselineRuleIds),
    routes: list(input.routes) as unknown as readonly InjectionRoute[],
  };
}

function readInjection(value: unknown): InjectionMetadata | null {
  if (value === null) return null;
  const input = record(value, INJECTION_KEYS);
  if (
    typeof input.specificity !== 'number' || !Number.isFinite(input.specificity) ||
    typeof input.priority !== 'number' || !Number.isFinite(input.priority) ||
    typeof input.level !== 'number' || !Number.isSafeInteger(input.level) || input.level < 0
  ) throw new Error('invalid_rank');
  const strings = (name: string): string[] => list(input[name]).map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0) throw new Error('invalid_hint');
    return item;
  });
  return {
    level: input.level,
    areas: strings('areas'),
    languages: strings('languages'),
    frameworks: strings('frameworks'),
    pathHints: strings('pathHints'),
    taskTags: strings('taskTags'),
    keywords: strings('keywords'),
    tags: strings('tags'),
    specificity: input.specificity,
    priority: input.priority,
  };
}

function narrativeRule(item: VersionedRule): AdvisoryRule {
  if (item.injection === null) throw new Error('missing_injection');
  const raw = item.rule;
  const narrative = raw === null ? item.narrative : raw.narrative;
  if (typeof narrative !== 'string') throw new Error('missing_narrative');
  const source = raw === null
    ? (item.provenance.kind === 'guidance-pack-seed' ? item.provenance.sourceRef : '')
    : canonicalJson(raw.source);
  const level = raw === null ? item.injection.level : raw.level as number;
  return {
    ...item.injection,
    id: item.id,
    ruleVersion: item.version,
    level,
    narrative,
    source,
    owner: raw === null ? 'repository guidance' : raw.owner as string,
    ttl: raw === null || raw.ttl === null ? null : Date.parse(raw.ttl as string),
    narrativeVersion: item.version,
    pairedRuleId: raw?.expressivity === 'deterministic' ? item.id : null,
    pairedRuleVersion: raw?.expressivity === 'deterministic' ? item.version : null,
  };
}

function expandRule(
  input: Readonly<Record<string, unknown>>,
  projectWorkspace: string,
): Record<string, unknown> {
  const rule = boundedCopy(input) as Record<string, unknown>;
  if (Array.isArray(rule.predicate)) {
    for (const value of rule.predicate) {
      const call = value as Record<string, unknown>;
      if (call.op !== 'target_glob' && call.op !== 'target_outside_glob') continue;
      const args = call.args as Record<string, unknown>;
      args.patterns = (args.patterns as string[]).map((pattern) => pattern.split(TOKEN).join(projectWorkspace));
    }
    if (canonicalJson(rule.predicate).includes(TOKEN)) throw new Error('invalid_substitution');
  }
  return rule;
}
