/** Shared, non-production helpers for governance tests. */

import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import { migrateLegacyCatalog } from '../catalog/migration.ts';
import { createGovernanceStore, type GovernanceStore } from './store.ts';
import { openGovernanceDatabase, type GovernanceDatabase } from './database.ts';
import type { Actor, RuleRecord } from './contracts.ts';
import type { ImportSources } from './import.ts';

export const NOW = Date.parse('2026-06-01T00:00:00.000Z');
export const WORKSPACE = '/tmp/opencode/amos-governance-workspace';
export const WORKSPACE_2 = '/tmp/opencode/amos-governance-workspace-2';

export const HUMAN: Actor = Object.freeze({ id: 'human', role: 'human' });
export const AGENT: Actor = Object.freeze({ id: 'agent', role: 'agent' });

const ROOT = process.cwd();

export function repoText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

export const RULES_YAML = repoText('constraints/rules.yaml');
export const RULE_SCHEMA = repoText('constraints/schema.json');
export const GUIDANCE_SOURCE = repoText('guidance/packs.ts');

export function tempDir(label: string): string {
  return mkdtempSync(join('/tmp/opencode', `amos-governance-${label}-`));
}

export interface TestClock {
  now(): number;
  set(value: number): void;
  advance(ms: number): void;
}

export function createClock(start = NOW): TestClock {
  let value = start;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
    advance: (ms: number) => {
      value += ms;
    },
  };
}

export interface TestCatalog {
  readonly catalogVersion: string;
  readonly mandatoryRuleRefs: readonly { readonly id: string; readonly version: number }[];
  readonly compiler: ReturnType<typeof createProjectActivationCompiler>;
  readonly rules: readonly RuleRecord[];
}

export function createTestCatalog(): TestCatalog {
  const catalog = migrateLegacyCatalog({
    rulesYaml: RULES_YAML,
    rawSchema: RULE_SCHEMA,
    guidanceSource: GUIDANCE_SOURCE,
    guidancePacks: GUIDANCE_PACKS,
  });
  return {
    catalogVersion: catalog.catalogVersion,
    mandatoryRuleRefs: catalog.mandatoryRuleRefs,
    compiler: createProjectActivationCompiler(catalog.compilerOptions),
    rules: catalog.rules.flatMap((entry) =>
      entry.rule === null ? [] : [entry.rule as unknown as RuleRecord],
    ),
  };
}

export interface TestEnv {
  readonly dir: string;
  readonly path: string;
  readonly db: GovernanceDatabase;
  readonly store: GovernanceStore;
  readonly clock: TestClock;
  readonly catalog: TestCatalog;
}

export function createEnv(label: string): TestEnv {
  const dir = tempDir(label);
  const path = join(dir, 'governance.db');
  const clock = createClock();
  const db = openGovernanceDatabase({ path, now: clock.now });
  const store = createGovernanceStore(db, { now: clock.now });
  return { dir, path, db, store, clock, catalog: createTestCatalog() };
}

export function projectInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'p1',
    workspace: WORKSPACE,
    projectConfigVersion: 'config-1',
    baseVersion: '0',
    epoch: 1,
    selectedRuleRefs: [],
    excludedRuleIds: [],
    advisoryBaselineRuleIds: [],
    routes: [],
    ...overrides,
  };
}

export function fullImportSources(extra: Partial<ImportSources> = {}): ImportSources {
  return {
    rulesYaml: RULES_YAML,
    ruleSchema: RULE_SCHEMA,
    guidance: GUIDANCE_PACKS,
    ...extra,
  };
}

/** Minimal project-activation candidate used for fast publication tests. */
export function activationCandidate(selectedRuleIds: readonly string[] = ['credential-0-1']): Record<string, unknown> {
  return {
    type: 'project-activation',
    activation: {
      selectedRuleRefs: selectedRuleIds.map((id) => ({ id, version: 1 })),
      excludedRuleIds: [],
      advisoryBaselineRuleIds: [],
      routes: [],
    },
  };
}

export function publishOptions(env: TestEnv, overrides: Record<string, unknown> = {}) {
  return {
    compiler: env.catalog.compiler,
    catalogVersion: env.catalog.catalogVersion,
    rawSchema: RULE_SCHEMA,
    mandatoryRuleRefs: env.catalog.mandatoryRuleRefs,
    projectInput: projectInput(),
    ...overrides,
  };
}

/** Create + approve a proposal in one step, returning its id. */
export function approvedProposal(
  env: TestEnv,
  candidate: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): { id: string } {
  const proposal = env.store.createProposal(
    {
      projectId: 'p1',
      baseVersion: 0,
      type: candidate.type,
      title: 'Test proposal',
      rationale: 'Test rationale',
      candidate,
      ...overrides,
    },
    HUMAN,
  );
  env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
  return { id: proposal.id };
}

export function seedProject(env: TestEnv, id = 'p1', workspace = WORKSPACE): void {
  env.store.createProject({ id, name: `Project ${id}`, workspace }, HUMAN);
}
