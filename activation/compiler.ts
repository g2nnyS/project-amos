import { Ajv } from 'ajv';
import { assertValidTable } from '../engine/engine.ts';
import { compileAdvisorySnapshot, type AdvisoryRule, type InjectionRoute } from '../injector/snapshot.ts';
import { boundedCopy, canonicalJson, deepFreeze, digest, list, MAX_BYTES, record, text, uniqueStrings, workspace } from './json.ts';
import {
  ACTIVATION_COMPILER_VERSION, ACTIVATION_FORMAT, ACTIVATION_FORMAT_VERSION,
  ActivationError,
  type ActiveRule, type AdvisoryProjection, type ExecutionProjection,
  type InjectionMetadata, type ProjectActivationCompiler, type ProjectActivationInput,
  type ProjectActivationSnapshot, type ProjectIdentity, type RuleRef, type VersionedRule,
} from './types.ts';

const TOKEN = '${SESSION_WORKSPACE}';
const PROJECT_KEYS = ['projectId', 'workspace', 'policyVersion', 'selectedRuleRefs', 'excludedRuleIds', 'advisoryBaselineRuleIds', 'routes'] as const;
const SNAPSHOT_KEYS = ['format', 'formatVersion', 'compilerVersion', 'mode', 'libraryVersion', 'schemaDigest', 'project', 'activeRules', 'activationDigest', 'enforcement', 'advisory', 'digest'] as const;
const INJECTION_KEYS = ['areas', 'pathHints', 'taskTags', 'keywords', 'tags', 'specificity', 'priority'] as const;

/** Fixed library + explicit mandatory members; projects can select, not rewrite them. */
export function createProjectActivationCompiler(options: unknown): ProjectActivationCompiler {
  try {
    return createCompiler(options);
  } catch {
    throw new ActivationError();
  }
}

function createCompiler(rawOptions: unknown): ProjectActivationCompiler {
  const options = record(boundedCopy(rawOptions), ['rawSchema', 'libraryVersion', 'rules', 'mandatoryRuleRefs']);
  if (typeof options.rawSchema !== 'string' || options.rawSchema.length > MAX_BYTES) {
    throw new Error('invalid_schema');
  }
  const schema: unknown = JSON.parse(options.rawSchema);
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('invalid_schema');
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const libraryVersion = text(options.libraryVersion);
  const schemaDigest = digest('amos-activation-schema-v1', options.rawSchema);
  const catalog = new Map<string, VersionedRule>();
  const knownIds = new Set<string>();

  for (const value of list(options.rules)) {
    const entry = record(value, ['version', 'rule', 'injection']);
    const version = revision(entry.version);
    if (!validate([entry.rule])) throw new Error('invalid_rule');
    const rawRule = entry.rule as Record<string, unknown>;
    const id = text(rawRule.id);
    // Validate even inactive library members, including TTL semantics. Expansion
    // here is only a validation probe; each project is expanded independently.
    assertValidTable([expandRule(rawRule, '/__activation_validation__')]);
    const injection = entry.injection === null ? null : readInjection(entry.injection);
    const item: VersionedRule = deepFreeze({ version, rule: rawRule, injection });
    if (injection !== null) {
      compileAdvisorySnapshot({
        projectId: 'validation', policyVersion: 'validation', engineVersion: ACTIVATION_COMPILER_VERSION,
        baselineRuleIds: [], routes: [], rules: [narrativeRule(item)],
      }, { activeEnforcementRuleIds: rawRule.expressivity === 'deterministic' ? [id] : [] });
    }
    const key = refKey({ id, version });
    if (catalog.has(key)) throw new Error('duplicate_revision');
    catalog.set(key, item);
    knownIds.add(id);
  }
  if (catalog.size === 0) throw new Error('empty_library');

  const mandatory = readRefs(options.mandatoryRuleRefs);
  const mandatoryIds = new Set<string>();
  for (const ref of mandatory) {
    if (!catalog.has(refKey(ref)) || mandatoryIds.has(ref.id)) {
      throw new Error('invalid_baseline');
    }
    mandatoryIds.add(ref.id);
  }
  deepFreeze(mandatory);

  function compile(input: unknown): ProjectActivationSnapshot {
    const project = readProject(input);
    const chosen = new Map<string, RuleRef>();
    for (const ref of [...mandatory, ...project.selectedRuleRefs]) {
      if (!catalog.has(refKey(ref))) throw new Error('unknown_revision');
      const previous = chosen.get(ref.id);
      if (previous !== undefined && previous.version !== ref.version) {
        throw new Error('conflicting_revision');
      }
      chosen.set(ref.id, ref);
    }
    for (const id of project.excludedRuleIds) {
      if (!knownIds.has(id) || mandatoryIds.has(id)) throw new Error('invalid_exclusion');
      chosen.delete(id);
    }
    if (chosen.size === 0) throw new Error('empty_activation');

    const activeRules: ActiveRule[] = [...chosen.values()].map((ref) => {
      const item = catalog.get(refKey(ref))!;
      return {
        id: ref.id, version: ref.version, mandatory: mandatoryIds.has(ref.id),
        rule: expandRule(item.rule, project.workspace), injection: item.injection,
      };
    });
    assertValidTable(activeRules.map((item) => item.rule));

    const activationDigest = digest('amos-project-activation-content-v1', {
      compilerVersion: ACTIVATION_COMPILER_VERSION, schemaDigest, libraryVersion,
      project, activeRules,
    });
    function execution(lane: 'runtime' | 'ci' | 'server'): ExecutionProjection {
      const rules = activeRules.filter(
        (item) => item.rule.expressivity === 'deterministic' && item.rule.enforcement === lane,
      ).map((item) => item.rule);
      return {
        status: rules.length === 0 ? 'empty' : 'ready', activationDigest,
        digest: digest(`amos-activation-${lane}-v1`, { activationDigest, rules }), rules,
      };
    }
    const enforcement = { runtime: execution('runtime'), ci: execution('ci'), server: execution('server') };
    const narratives = activeRules.filter((item) => item.injection !== null).map(narrativeRule);
    let advisory: AdvisoryProjection;
    if (narratives.length === 0) {
      if (project.advisoryBaselineRuleIds.length !== 0 || project.routes.length !== 0) {
        throw new Error('invalid_empty_advisory');
      }
      advisory = {
        status: 'empty', activationDigest, snapshot: null,
        digest: digest('amos-activation-advisory-v1', { activationDigest, snapshot: null }),
      };
    } else {
      const native = compileAdvisorySnapshot({
        projectId: project.projectId, policyVersion: project.policyVersion,
        engineVersion: ACTIVATION_COMPILER_VERSION,
        baselineRuleIds: project.advisoryBaselineRuleIds, routes: project.routes, rules: narratives,
      }, {
        activeEnforcementRuleIds: activeRules.filter(
          (item) => item.rule.expressivity === 'deterministic',
        ).map((item) => item.id),
      });
      advisory = {
        status: 'ready', activationDigest, snapshot: native,
        digest: digest('amos-activation-advisory-v1', { activationDigest, snapshot: native }),
      };
    }
    const content = {
      format: ACTIVATION_FORMAT, formatVersion: ACTIVATION_FORMAT_VERSION,
      compilerVersion: ACTIVATION_COMPILER_VERSION, mode: 'offline-shadow' as const,
      libraryVersion, schemaDigest, project, activeRules, activationDigest, enforcement, advisory,
    };
    const snapshot: ProjectActivationSnapshot = {
      ...content, digest: digest('amos-project-activation-snapshot-v1', content),
    };
    // Keep the verification/import envelope bounded as well as its inputs.
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
        const projectId = text(identity.projectId);
        const projectWorkspace = workspace(identity.workspace);
        const candidate = record(boundedCopy(value), SNAPSHOT_KEYS);
        const project = readProject(candidate.project);
        if (project.projectId !== projectId || project.workspace !== projectWorkspace) {
          throw new Error('identity_mismatch');
        }
        // Rebuild every projection from this compiler's fixed source versions.
        // Merely changing a lane's digest cannot make a mixed snapshot valid.
        const rebuilt = compile(project);
        if (canonicalJson(candidate) !== canonicalJson(rebuilt)) throw new Error('snapshot_mismatch');
        return rebuilt;
      } catch {
        throw new ActivationError();
      }
    },
  });
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('invalid_revision');
  }
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
    projectId: text(input.projectId), workspace: workspace(input.workspace), policyVersion: text(input.policyVersion),
    selectedRuleRefs: readRefs(input.selectedRuleRefs),
    excludedRuleIds: uniqueStrings(input.excludedRuleIds),
    advisoryBaselineRuleIds: uniqueStrings(input.advisoryBaselineRuleIds),
    // The existing advisory compiler validates the exact route schema and
    // requires every add/suppress reference to be in this active projection.
    routes: list(input.routes) as unknown as readonly InjectionRoute[],
  };
}

function readInjection(value: unknown): InjectionMetadata {
  const input = record(value, INJECTION_KEYS);
  if (
    typeof input.specificity !== 'number' || !Number.isFinite(input.specificity) ||
    typeof input.priority !== 'number' || !Number.isFinite(input.priority)
  ) throw new Error('invalid_rank');
  // Bounds/private-path validation are also applied by compileAdvisorySnapshot.
  const strings = (name: string): string[] => list(input[name]).map((item) => {
    if (typeof item !== 'string') throw new Error('invalid_hint');
    return item;
  });
  return {
    areas: strings('areas'), pathHints: strings('pathHints'), taskTags: strings('taskTags'),
    keywords: strings('keywords'), tags: strings('tags'),
    specificity: input.specificity, priority: input.priority,
  };
}

function narrativeRule(item: VersionedRule): AdvisoryRule {
  if (item.injection === null) throw new Error('missing_injection');
  return {
    ...item.injection,
    id: item.rule.id as string,
    narrative: item.rule.narrative as string,
    source: canonicalJson(item.rule.source),
    owner: item.rule.owner as string,
    ttl: item.rule.ttl === null ? null : Date.parse(item.rule.ttl as string),
    narrativeVersion: item.version,
    pairedRuleId: item.rule.expressivity === 'deterministic' ? item.rule.id as string : null,
  };
}

function expandRule(input: Readonly<Record<string, unknown>>, projectWorkspace: string): Record<string, unknown> {
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
