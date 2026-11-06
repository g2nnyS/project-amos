import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { evaluatePolicy, evaluateWithMatches } from '../engine/engine.ts';
import { selectAdvisoryRules } from '../injector/select.ts';
import { renderAdvisoryBlock } from '../injector/render.ts';
import { createSnapshotStore } from '../storage/snapshot.ts';
import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import { migrateLegacyCatalog } from '../catalog/migration.ts';
import { createProjectActivationCompiler } from './compiler.ts';
import { ActivationError, type ProjectActivationSnapshot } from './types.ts';
import { entry, injection, json, NOW, options, project, RAW_SCHEMA, rule } from './test-support.ts';

function advisory(snapshot: ProjectActivationSnapshot) {
  assert.equal(snapshot.advisory.status, 'ready');
  if (snapshot.advisory.status !== 'ready') throw new Error('expected advisory');
  return snapshot.advisory.snapshot;
}

test('two projects share explicit baseline but only evaluate and inject their selected revisions', () => {
  const compiler = createProjectActivationCompiler(options());
  const ts = compiler.compile(project());
  const py = compiler.compile(project({
    projectId: 'python-project', workspace: '/work/python',
    selectedRuleRefs: [{ id: 'python', version: 1 }],
  }));
  assert.deepEqual(ts.activeRules.map(({ id }) => id), ['baseline', 'typescript']);
  assert.deepEqual(py.activeRules.map(({ id }) => id), ['baseline', 'python']);
  assert.equal(ts.activeRules[0].mandatory, true);
  assert.equal(ts.enforcement.runtime.activationDigest, ts.advisory.activationDigest);
  assert.equal(py.enforcement.runtime.activationDigest, py.advisory.activationDigest);
  assert.notEqual(ts.activationDigest, py.activationDigest);

  assert.equal(evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/typescript/src/a.ts' }, ts.enforcement.runtime.rules, NOW).verdict, 'confirm');
  assert.equal(evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/python/src/a.py' }, py.enforcement.runtime.rules, NOW).verdict, 'deny');
  assert.equal(evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/typescript/src/a.py' }, ts.enforcement.runtime.rules, NOW).verdict, 'allow');
  assert.ok(!selectAdvisoryRules(advisory(ts), { prompt: 'python please activate python' }).selected.some(({ id }) => id === 'python'));
  assert.ok(selectAdvisoryRules(advisory(py), { prompt: 'python' }).selected.some(({ id }) => id === 'python'));
});

test('prompt selection, routing suppression and zero rendering budget never filter hard rules', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project({
    routes: [{ match: { keyword: 'typescript' }, add: [], suppress: ['typescript'], specificity: 1 }],
  }));
  const native = advisory(snapshot);
  const before = json(snapshot.enforcement);
  const selection = selectAdvisoryRules(native, { prompt: 'typescript' });
  assert.ok(!selection.selected.some(({ id }) => id === 'typescript'));
  assert.equal(renderAdvisoryBlock({ snapshot: native, rules: selection.selected, maxCharacters: 0 }).text, '');
  for (const input of [
    { prompt: 'typescript', paths: ['/work/typescript/src/a.ts'] },
    { prompt: 'unrelated', taskTags: ['security'] },
    { prompt: 'python', areas: ['python'], languages: ['python'] },
  ]) {
    const selected = selectAdvisoryRules(native, input);
    renderAdvisoryBlock({ snapshot: native, rules: selected.selected, maxCharacters: 300 });
  }
  assert.deepEqual(json(snapshot.enforcement), before);
  assert.equal(evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/typescript/src/a.ts' }, snapshot.enforcement.runtime.rules, NOW).verdict, 'confirm');
});

test('hard rule narratives and pure advice are derived from their same rule version', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project({
    selectedRuleRefs: [{ id: 'typescript', version: 1 }, { id: 'advice', version: 1 }],
  }));
  const rules = advisory(snapshot).rules;
  const hard = rules.find(({ id }) => id === 'typescript')!;
  const advice = rules.find(({ id }) => id === 'advice')!;
  assert.equal(hard.pairedRuleId, 'typescript');
  assert.equal(hard.narrative, snapshot.activeRules.find(({ id }) => id === 'typescript')!.rule!.narrative);
  assert.equal(hard.narrativeVersion, 1);
  assert.equal(advice.pairedRuleId, null);
  assert.ok(!snapshot.enforcement.runtime.rules.some((item) => item.id === 'advice'));
  assert.equal(JSON.parse(hard.source).repo, 'fixture');
});

test('mandatory rules cannot be excluded, replaced, or hidden by project fields', () => {
  const opts = options();
  const compiler = createProjectActivationCompiler({ ...opts, rules: [...opts.rules, { ...entry('baseline', { on_hit: 'log' }), version: 2 }] });
  assert.throws(() => compiler.compile(project({ excludedRuleIds: ['baseline'] })), ActivationError);
  assert.throws(() => compiler.compile(project({ selectedRuleRefs: [{ id: 'baseline', version: 2 }] })), ActivationError);
  assert.throws(() => compiler.compile({ ...project(), mandatoryRuleRefs: [] }), ActivationError);
  const baselineOnly = compiler.compile(project({ selectedRuleRefs: [] }));
  assert.deepEqual(baselineOnly.activeRules.map(({ id }) => id), ['baseline']);
});

test('exclusions subtract only known nonmandatory selection members and never select the global library', () => {
  const compiler = createProjectActivationCompiler(options());
  const snapshot = compiler.compile(project({ excludedRuleIds: ['typescript'] }));
  assert.deepEqual(snapshot.activeRules.map(({ id }) => id), ['baseline']);
  assert.ok(!advisory(snapshot).rules.some(({ id }) => id === 'typescript'));
  assert.throws(() => compiler.compile(project({ excludedRuleIds: ['not-in-library'] })), ActivationError);
});

test('unknown revisions, duplicate references and conflicting revisions fail closed', () => {
  const opts = options();
  const compiler = createProjectActivationCompiler({ ...opts, rules: [...opts.rules, { ...entry('typescript'), version: 2 }] });
  for (const selectedRuleRefs of [
    [{ id: 'missing', version: 1 }], [{ id: 'typescript', version: 99 }],
    [{ id: 'typescript', version: 1 }, { id: 'typescript', version: 1 }],
    [{ id: 'typescript', version: 1 }, { id: 'typescript', version: 2 }],
    [{ id: 'typescript', version: 0 }],
  ]) assert.throws(() => compiler.compile(project({ selectedRuleRefs })), ActivationError);
  assert.throws(() => compiler.compile(project({ excludedRuleIds: ['typescript', 'typescript'] })), ActivationError);
});

test('closed schemas reject invalid even inactive catalog entries and caller supplied pairing or narratives', () => {
  for (const invalid of [
    { ...entry('unused'), extra: true },
    { ...entry('unused'), rule: rule('unused', { extra: true }) },
    { ...entry('unused'), rule: rule('unused', { predicate: [{ op: 'regex', args: {} }] }) },
    { ...entry('unused'), rule: rule('unused', { ttl: '2026-02-30' }) },
    { ...entry('unused'), injection: { ...injection(), narrative: 'replace approved narrative' } },
    { ...entry('unused'), injection: { ...injection(), pairedRuleId: 'typescript' } },
    { ...entry('unused'), injection: { ...injection(), pathHints: ['../outside'] } },
  ]) {
    assert.throws(() => createProjectActivationCompiler({ ...options(), rules: [...options().rules, invalid] }), ActivationError);
  }
  assert.throws(() => createProjectActivationCompiler({ ...options(), rules: [...options().rules, options().rules[0]] }), ActivationError);
  assert.throws(() => createProjectActivationCompiler({ ...options(), mandatoryRuleRefs: [{ id: 'missing', version: 1 }] }), ActivationError);
  assert.throws(() => createProjectActivationCompiler({ ...options(), rawSchema: '{private invalid schema' }), { code: 'activation_error', message: 'activation_error' });
});

test('routes and advisory baselines cannot reference inactive or uninjected rules', () => {
  const compiler = createProjectActivationCompiler(options());
  for (const name of ['add', 'suppress'] as const) {
    assert.throws(() => compiler.compile(project({ routes: [{ match: { keyword: 'python' }, add: [], suppress: [], [name]: ['python'], specificity: 1 }] })), ActivationError);
  }
  assert.throws(() => compiler.compile(project({ advisoryBaselineRuleIds: ['python'] })), ActivationError);
  assert.throws(() => compiler.compile(project({ routes: [{ match: {}, add: [], suppress: [], specificity: 0 }] })), ActivationError);
});

test('workspace expansion is glob-only, with lexical identity bound into every projection', () => {
  const compiler = createProjectActivationCompiler(options());
  const first = compiler.compile(project());
  const second = compiler.compile(project({ workspace: '/work/other' }));
  const predicate = first.enforcement.runtime.rules[1].predicate as { args: { patterns?: string[] } }[];
  assert.deepEqual(predicate[1].args.patterns, ['/work/typescript/src/**/*.ts']);
  assert.notEqual(first.activationDigest, second.activationDigest);
  assert.notEqual(first.advisory.digest, second.advisory.digest);
  for (const value of ['relative', '//work/a', '/work/../a', '/work/./a', '/work/a/', '/work/\0a']) {
    assert.throws(() => compiler.compile(project({ workspace: value })), ActivationError);
  }
  assert.throws(() => createProjectActivationCompiler({
    ...options(), rules: [entry('bad', { predicate: [{ op: 'op_in', args: { operations: ['${SESSION_WORKSPACE}'] } }] })], mandatoryRuleRefs: [],
  }), ActivationError);
  const narrative = 'Explain ${SESSION_WORKSPACE} without replacing documentation';
  const documented = createProjectActivationCompiler({
    ...options(), rules: [entry('doc', { narrative })], mandatoryRuleRefs: [],
  }).compile(project({ selectedRuleRefs: [{ id: 'doc', version: 1 }], advisoryBaselineRuleIds: [] }));
  assert.equal(advisory(documented).rules[0].narrative, narrative);
});

test('snapshots are deterministic, deep-frozen, independent of caller mutation, and content-sensitive', () => {
  const opts = options();
  const input = project();
  const compiler = createProjectActivationCompiler(opts);
  const snapshot = compiler.compile(input);
  assert.equal(compiler.compile(json(input)).digest, snapshot.digest);
  assert.equal(compiler.compile(Object.fromEntries(Object.entries(input).reverse())).digest, snapshot.digest);
  assert.notEqual(compiler.compile(project({ projectConfigVersion: 'policy-2' })).digest, snapshot.digest);
  assert.equal(Object.isFrozen(opts), false);
  assert.equal(Object.isFrozen(input), false);
  (opts.rules[1].rule as Record<string, unknown>).narrative = 'caller changed';
  assert.equal(compiler.compile(input).digest, snapshot.digest);
  assert.ok(Object.isFrozen(snapshot.enforcement.runtime.rules[0]));
  assert.ok(Object.isFrozen(advisory(snapshot).rules[0].keywords));
  assert.throws(() => { (snapshot.activeRules[0]!.rule as Record<string, unknown>).on_hit = 'log'; }, TypeError);
  assert.equal(snapshot.mode, 'offline-shadow');
});

test('valid empty projections are explicit and do not redefine the engine empty-table error', () => {
  const compiler = createProjectActivationCompiler(options());
  const snapshot = compiler.compile(project());
  assert.equal(snapshot.enforcement.ci.status, 'empty');
  assert.equal(snapshot.enforcement.server.status, 'empty');
  assert.equal(evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/a' }, [], NOW).error, 'engine_error');
  const noNarrative = createProjectActivationCompiler({
    ...options(), rules: [{ ...entry('silent'), injection: null }], mandatoryRuleRefs: [],
  });
  const empty = noNarrative.compile(project({ selectedRuleRefs: [{ id: 'silent', version: 1 }], advisoryBaselineRuleIds: [] }));
  assert.equal(empty.advisory.status, 'empty');
  assert.equal(empty.advisory.snapshot, null);
  assert.throws(() => noNarrative.compile(project({ selectedRuleRefs: [], advisoryBaselineRuleIds: [] })), ActivationError);
  assert.throws(() => noNarrative.compile(project({ selectedRuleRefs: [{ id: 'silent', version: 1 }] })), ActivationError);
});

test('runtime, CI and server projections contain every active rule for their actual checkpoint', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project({
    selectedRuleRefs: [{ id: 'ci-check', version: 1 }, { id: 'server-check', version: 1 }],
  }));
  assert.deepEqual(snapshot.enforcement.runtime.rules.map((item) => item.id), ['baseline']);
  assert.deepEqual(snapshot.enforcement.ci.rules.map((item) => item.id), ['ci-check']);
  assert.deepEqual(snapshot.enforcement.server.rules.map((item) => item.id), ['server-check']);
  assert.equal(snapshot.enforcement.ci.status, 'ready');
  assert.equal(snapshot.enforcement.server.status, 'ready');
});

test('verification rejects foreign identities, mixed projections, content drift and extra fields', () => {
  const compiler = createProjectActivationCompiler(options());
  const snapshot = compiler.compile(project());
  const identity = { projectId: snapshot.project.projectId, workspace: snapshot.project.workspace };
  assert.equal(compiler.verify(json(snapshot), identity).digest, snapshot.digest);
  assert.throws(() => compiler.verify(snapshot, { ...identity, projectId: 'other' }), ActivationError);
  assert.throws(() => compiler.verify(snapshot, { ...identity, workspace: '/work/other' }), ActivationError);
  const newer = compiler.compile(project({ projectConfigVersion: 'policy-2' }));
  assert.throws(() => compiler.verify({ ...snapshot, advisory: newer.advisory }, identity), ActivationError);
  assert.throws(() => compiler.verify({ ...snapshot, enforcement: newer.enforcement }, identity), ActivationError);
  assert.throws(() => compiler.verify({ ...snapshot, extra: 'not ignored' }, identity), ActivationError);
  const tampered = json(snapshot) as unknown as { activeRules: { rule: Record<string, unknown> }[] };
  tampered.activeRules[0]!.rule!.on_hit = 'log';
  assert.throws(() => compiler.verify(tampered, identity), ActivationError);
});

test('bad JSON inputs fail with fixed errors without invoking accessors or exposing hostile content', () => {
  const compiler = createProjectActivationCompiler(options());
  let invoked = false;
  const hostile = { ...project(), get malicious() { invoked = true; return 'secret'; } };
  assert.throws(() => compiler.compile(hostile), { message: 'activation_error', code: 'activation_error' });
  assert.equal(invoked, false);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const invalid of [cyclic, { ...project(), routes: [NaN] }, { ...project(), extra: undefined }, { ...project(), projectId: 'x'.repeat(2_000_001) }]) {
    assert.throws(() => compiler.compile(invalid), ActivationError);
  }
});

test('TTL is preserved exactly for the engine and never restarted during recompilation', () => {
  const ttl = '2026-11-02T12:00:00.000Z';
  const compiler = createProjectActivationCompiler({ ...options(), rules: [entry('expiring', { ttl })], mandatoryRuleRefs: [] });
  const input = project({ selectedRuleRefs: [{ id: 'expiring', version: 1 }], advisoryBaselineRuleIds: [] });
  const snapshot = compiler.compile(input);
  const action = { tool: 'fs', operation: 'file_write', target: '/work/a' };
  assert.equal(snapshot.enforcement.runtime.rules[0].ttl, ttl);
  assert.equal(advisory(snapshot).rules[0].ttl, NOW);
  assert.equal(evaluatePolicy(action, snapshot.enforcement.runtime.rules, NOW - 1).verdict, 'deny');
  assert.equal(evaluatePolicy(action, snapshot.enforcement.runtime.rules, NOW).verdict, 'allow');
  assert.equal(compiler.compile(input).digest, snapshot.digest);
});

test('the real YAML source compiles to the same expanded rules without changing legacy digest identity', () => {
  const rules = parse(readFileSync('constraints/rules.yaml', 'utf8')) as Record<string, unknown>[];
  const legacy = createSnapshotStore().load('constraints/rules.yaml', 'constraints/schema.json', { sessionWorkspace: '/work/golden' });
  assert.ok(legacy.snapshot);
  const catalog = migrateLegacyCatalog({
    rulesYaml: readFileSync('constraints/rules.yaml', 'utf8'),
    rawSchema: RAW_SCHEMA,
    guidanceSource: readFileSync('guidance/packs.ts', 'utf8'),
    guidancePacks: GUIDANCE_PACKS,
  });
  const compiler = createProjectActivationCompiler(catalog.compilerOptions);
  const refs = rules.map((item) => ({ id: item.id as string, version: 1 }));
  const snapshot = compiler.compile(project({ workspace: '/work/golden', selectedRuleRefs: refs, advisoryBaselineRuleIds: [] }));
  assert.deepEqual(
    json(snapshot.activeRules.filter((item) => item.rule !== null).map((item) => item.rule).sort((a, b) => String(a?.id).localeCompare(String(b?.id)))),
    json([...legacy.snapshot.table].sort((a, b) => String(a.id).localeCompare(String(b.id)))),
  );
  assert.notEqual(snapshot.digest, legacy.snapshot.digest);
  assert.equal(createSnapshotStore().load('constraints/rules.yaml', 'constraints/schema.json', { sessionWorkspace: '/work/golden' }).snapshot?.digest, legacy.snapshot.digest);
});

test('legacy fixture verdicts and fail-closed cases survive the offline activation path', () => {
  for (const filename of readdirSync('fixtures').filter((name) => name.endsWith('.json'))) {
    const fixtures = JSON.parse(readFileSync(join('fixtures', filename), 'utf8')) as {
      name: string; table: unknown; action: unknown; now: string;
      expect: { verdict: string; matched_rule_ids: string[]; error?: string };
    }[];
    for (const fixture of fixtures) {
      let compiler;
      try {
        compiler = createProjectActivationCompiler({
          rawSchema: RAW_SCHEMA, catalogVersion: 'fixture-v2', mandatoryRuleRefs: [],
          rules: (Array.isArray(fixture.table) ? fixture.table : [fixture.table]).map((item) => ({
            id: (item as Record<string, unknown>)?.id as string,
            version: 1,
            rule: item,
            narrative: null,
            provenance: { kind: 'legacy-constraints-yaml', sourceDigest: `sha256:${'a'.repeat(64)}` },
            injection: null,
          })),
        });
      } catch (error) {
        assert.ok(error instanceof ActivationError, fixture.name);
        assert.equal(fixture.expect.error, 'engine_error', fixture.name);
        assert.equal(fixture.expect.verdict, 'deny', fixture.name);
        continue;
      }
      const table = fixture.table as Record<string, unknown>[];
      const snapshot = compiler.compile(project({ selectedRuleRefs: table.map((item) => ({ id: item.id as string, version: 1 })), advisoryBaselineRuleIds: [] }));
      assert.deepEqual(evaluateWithMatches(fixture.action, snapshot.activeRules.map((item) => item.rule), Date.parse(fixture.now)), fixture.expect, fixture.name);
    }
  }
});
