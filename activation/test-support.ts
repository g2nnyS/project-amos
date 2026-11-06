import { readFileSync } from 'node:fs';
import type { ActivationCompilerOptions, InjectionMetadata, ProjectActivationInput, VersionedRule } from './types.ts';

export const RAW_SCHEMA = readFileSync('constraints/schema.json', 'utf8');
export const NOW = Date.parse('2026-11-02T12:00:00.000Z');

export function rule(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, dimension: 'filesystem', level: 1, expressivity: 'deterministic',
    policy_class: 'security', enforcement: 'runtime',
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    narrative: `Approved narrative for ${id}`, on_hit: 'deny', scope: 'project',
    ttl: null, owner: 'human',
    source: { repo: 'fixture', rev: 'v1', path: 'docs/standard.md', section: 'test', lines: '1', quote: 'approved source' },
    probe: 'offline fixture', ...overrides,
  };
}

export function injection(area = 'typescript'): InjectionMetadata {
  return {
    level: 1,
    areas: [area], pathHints: [], taskTags: [], keywords: [area], tags: [],
    languages: area === 'typescript' || area === 'python' ? [area] : [],
    frameworks: [],
    specificity: 1, priority: 0,
  };
}

export function entry(id: string, overrides: Record<string, unknown> = {}, area = 'typescript'): VersionedRule {
  const legacyRule = rule(id, overrides);
  const metadata = { ...injection(area), level: legacyRule.level as number };
  return {
    id,
    version: 1,
    rule: legacyRule,
    narrative: null,
    provenance: { kind: 'legacy-constraints-yaml', sourceDigest: `sha256:${'a'.repeat(64)}` },
    injection: metadata,
  };
}

export function options(): ActivationCompilerOptions {
  return {
    rawSchema: RAW_SCHEMA, catalogVersion: 'test-catalog-v2',
    rules: [
      entry('baseline', { level: 0, predicate: [{ op: 'op_in', args: { operations: ['file_delete'] } }] }, 'security'),
      entry('typescript', {
        on_hit: 'confirm',
        predicate: [
          { op: 'op_in', args: { operations: ['file_write'] } },
          { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/src/**/*.ts'] } },
        ],
      }),
      entry('python', {
        predicate: [
          { op: 'op_in', args: { operations: ['file_write'] } },
          { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/src/**/*.py'] } },
        ],
      }, 'python'),
      entry('advice', { expressivity: 'advisory_only', enforcement: 'advisory', predicate: null, on_hit: 'log' }),
      { ...entry('ci-check', { enforcement: 'ci' }), injection: null },
      { ...entry('server-check', { enforcement: 'server' }), injection: null },
    ],
    mandatoryRuleRefs: [{ id: 'baseline', version: 1 }],
  };
}

export function project(overrides: Partial<ProjectActivationInput> = {}): ProjectActivationInput {
  return {
    projectId: 'typescript-project', workspace: '/work/typescript',
    projectConfigVersion: 'policy-1', baseVersion: 'base-1', epoch: 1,
    selectedRuleRefs: [{ id: 'typescript', version: 1 }], excludedRuleIds: [],
    advisoryBaselineRuleIds: ['baseline'], routes: [], ...overrides,
  };
}

export function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
