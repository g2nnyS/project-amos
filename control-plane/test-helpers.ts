import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createControlPlane } from './store.ts';
import type {
  Actor,
  Candidate,
  CandidateActivation,
  ControlPlane,
  RuleRecord,
  RuleSource,
} from './contracts.ts';

export function readSchema(): string {
  return readFileSync(
    join(process.cwd(), 'constraints', 'schema.json'),
    'utf8',
  );
}

export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'amos-governance-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export interface TestClock {
  now(): number;
  iso(): string;
  advance(ms: number): number;
  set(iso: string): number;
}

export function createTestClock(
  start = '2026-11-01T00:00:00.000Z',
): TestClock {
  let current = Date.parse(start);
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
      return current;
    },
    set: (iso: string) => {
      current = Date.parse(iso);
      return current;
    },
  };
}

export function futureIso(clock: TestClock, ms = 60_000): string {
  return new Date(clock.now() + ms).toISOString();
}

export function human(id = 'human-1'): Actor {
  return { id, role: 'human' };
}

export function agent(id = 'agent-1'): Actor {
  return { id, role: 'agent' };
}

const DEFAULT_SOURCE: RuleSource = {
  repo: 'fixture',
  rev: 'fixture-rev',
  path: 'fixture/rules.yaml',
  section: 'fixture',
  lines: '1',
  quote: 'fixture quote',
};

export function makeRule(
  id: string,
  overrides: Partial<RuleRecord> = {},
): RuleRecord {
  const base: RuleRecord = {
    id,
    dimension: 'side_effect',
    level: 1,
    expressivity: 'deterministic',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    narrative: 'fixture rule',
    on_hit: 'deny',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: { ...DEFAULT_SOURCE },
    probe: 'fixture probe',
    policy_class: 'engineering',
    enforcement: 'runtime',
  };
  return { ...base, ...overrides, id } as RuleRecord;
}

export function makeAdvisoryRule(
  id: string,
  overrides: Partial<RuleRecord> = {},
): RuleRecord {
  return makeRule(id, {
    expressivity: 'advisory_only',
    predicate: null,
    enforcement: 'advisory',
    on_hit: 'log',
    ...overrides,
  });
}

export function makeCandidate(
  rules: RuleRecord[],
  activation: {
    includedRuleIds?: string[] | null;
    excludedRuleIds?: string[];
  } = {},
): Candidate {
  return {
    rules,
    activation: {
      includedRuleIds: activation.includedRuleIds ?? null,
      excludedRuleIds: activation.excludedRuleIds ?? [],
    },
  };
}

export interface ServiceFixture {
  readonly dir: string;
  readonly databasePath: string;
  readonly clock: TestClock;
  readonly cp: ControlPlane;
}

export function createServiceFixture(
  t: TestContext,
  options: {
    start?: string;
    databasePath?: string;
    schema?: string;
  } = {},
): ServiceFixture {
  const dir = makeTempDir(t);
  const databasePath = options.databasePath ?? join(dir, 'governance.sqlite');
  const clock = createTestClock(options.start);
  const cp = createControlPlane({
    databasePath,
    rawSchema: options.schema ?? readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());
  return { dir, databasePath, clock, cp };
}

export function createProject(
  cp: ControlPlane,
  workspace = '/workspace/demo',
  actor: Actor = human(),
) {
  return cp.createProject({ name: 'Demo project', workspace }, actor);
}

export function createSimpleProposal(
  cp: ControlPlane,
  projectId: string,
  clock: TestClock,
  options: {
    candidate?: Candidate;
    baseVersion?: number;
    expiresAt?: string;
    title?: string;
    rationale?: string;
    actor?: Actor;
  } = {},
) {
  return cp.createProposal(
    projectId,
    {
      title: options.title ?? 'Fixture proposal',
      rationale: options.rationale ?? 'Fixture rationale',
      baseVersion: options.baseVersion ?? 0,
      expiresAt: options.expiresAt ?? futureIso(clock),
      candidate: options.candidate ?? makeCandidate([makeRule('rule-1')]),
    },
    options.actor ?? human(),
  );
}

export function expectDomainError(
  fn: () => unknown,
  code: string,
  status?: number,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, code);
    if (status !== undefined) {
      assert.equal((error as { status?: number }).status, status);
    }
    return true;
  });
}
