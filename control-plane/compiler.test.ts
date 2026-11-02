import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  COMPILER_VERSION,
  MAX_RULES_PER_CANDIDATE,
  RULE_SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  buildPolicySnapshot,
  createRuleValidator,
  proposalDigest,
  validateAndCompileCandidate,
} from './compiler.ts';
import type { RuleRecord, RulePredicate } from './contracts.ts';
import { expectDomainError } from './test-helpers.ts';
import {
  createTestClock,
  futureIso,
  makeAdvisoryRule,
  makeCandidate,
  makeRule,
  readSchema,
} from './test-helpers.ts';

const workspace = '/workspace/demo';
const validator = createRuleValidator(readSchema());

function compile(candidate: unknown) {
  return validateAndCompileCandidate(candidate, workspace, validator);
}

test('the repository constraints/rules.yaml compiles as a full candidate', () => {
  const rules = parseYaml(
    readFileSync(join(process.cwd(), 'constraints', 'rules.yaml'), 'utf8'),
  ) as RuleRecord[];

  const compilation = compile(makeCandidate(rules));
  assert.equal(
    compilation.result.valid,
    true,
    JSON.stringify(compilation.result.issues),
  );
  assert.ok(compilation.compiled);
  assert.equal(compilation.compiled.candidate.rules.length, rules.length);
});

test('compiles full candidates and splits deterministic and advisory lanes', () => {
  const candidate = makeCandidate([
    makeRule('det-1'),
    makeAdvisoryRule('adv-1'),
  ]);

  const compilation = compile(candidate);
  assert.equal(compilation.result.valid, true);
  assert.deepEqual(compilation.result.issues, []);
  assert.ok(compilation.compiled);

  const compiled = compilation.compiled;
  assert.deepEqual(compiled.candidate, candidate);
  assert.deepEqual(compiled.effectiveRuleIds, ['det-1', 'adv-1']);
  assert.deepEqual(
    compiled.enforcementRules.map((rule) => rule.id),
    ['det-1'],
  );
  assert.deepEqual(
    compiled.advisoryRules.map((rule) => rule.id),
    ['adv-1'],
  );
  // Every schema field survives compilation.
  assert.deepEqual(compiled.candidate.rules[0], candidate.rules[0]);
});

test('activation semantics reject duplicates, unknown ids, overlap, and empty sets', () => {
  const rules = [makeRule('a'), makeRule('b'), makeRule('c')];

  const selected = compile(
    makeCandidate(rules, {
      includedRuleIds: ['a', 'c'],
      excludedRuleIds: ['b'],
    }),
  );
  assert.equal(selected.result.valid, true);
  assert.deepEqual(selected.compiled?.effectiveRuleIds, ['a', 'c']);

  const overlap = compile(
    makeCandidate(rules, {
      includedRuleIds: ['a'],
      excludedRuleIds: ['a'],
    }),
  );
  assert.equal(overlap.result.valid, false);
  assert.ok(overlap.result.issues.some((issue) => issue.code === 'activation_overlap'));

  const unknown = compile(
    makeCandidate(rules, { includedRuleIds: ['missing'] }),
  );
  assert.equal(unknown.result.valid, false);
  assert.ok(unknown.result.issues.some((issue) => issue.code === 'unknown_rule_id'));

  const empty = compile(makeCandidate(rules, { includedRuleIds: [] }));
  assert.equal(empty.result.valid, false);
  assert.ok(
    empty.result.issues.some(
      (issue) => issue.code === 'empty_effective_policy',
    ),
  );

  const duplicate = compile(
    makeCandidate(rules, { includedRuleIds: ['a', 'a'] }),
  );
  assert.equal(duplicate.result.valid, false);
  assert.ok(
    duplicate.result.issues.some(
      (issue) => issue.code === 'duplicate_activation_id',
    ),
  );

  const unknownExcluded = compile(
    makeCandidate(rules, { excludedRuleIds: ['nope'] }),
  );
  assert.equal(unknownExcluded.result.valid, false);
  assert.ok(
    unknownExcluded.result.issues.some(
      (issue) => issue.code === 'unknown_rule_id',
    ),
  );
});

test('duplicate rule ids and schema violations are reported without echoing values', () => {
  const duplicate = compile(
    makeCandidate([makeRule('same'), makeRule('same')]),
  );
  assert.equal(duplicate.result.valid, false);
  assert.ok(
    duplicate.result.issues.some(
      (issue) => issue.code === 'duplicate_rule_id',
    ),
  );

  const hostile = {
    ...makeRule('hostile'),
    narrative: 'SECRET_RULE_BODY_MUST_NOT_LEAK',
    unexpected_field: 'SECRET_VALUE_MUST_NOT_LEAK',
  };
  const invalid = compile(makeCandidate([hostile as unknown as RuleRecord]));
  assert.equal(invalid.result.valid, false);
  const serialized = JSON.stringify(invalid.result);
  assert.equal(serialized.includes('SECRET_RULE_BODY_MUST_NOT_LEAK'), false);
  assert.equal(serialized.includes('SECRET_VALUE_MUST_NOT_LEAK'), false);
  assert.ok(
    invalid.result.issues.some((issue) => issue.code === 'unknown_field'),
  );
});

test('only the existing ${SESSION_WORKSPACE} glob substitution is supported', () => {
  const globRule = makeRule('glob-1', {
    predicate: [
      { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/src/**'] } },
      {
        op: 'target_outside_glob',
        args: { patterns: ['${SESSION_WORKSPACE}/tmp/**'] },
      },
    ],
  });
  const globCompilation = compile(makeCandidate([globRule]));
  assert.equal(globCompilation.result.valid, true);
  const expanded = globCompilation.compiled?.enforcementRules[0]
    .predicate as RulePredicate[];
  assert.deepEqual(expanded[0], {
    op: 'target_glob',
    args: { patterns: [`${workspace}/src/**`] },
  });
  assert.deepEqual(expanded[1], {
    op: 'target_outside_glob',
    args: { patterns: [`${workspace}/tmp/**`] },
  });
  assert.equal(
    JSON.stringify(globCompilation.compiled?.candidate).includes(
      '${SESSION_WORKSPACE}',
    ),
    true,
  );

  const unsupported = makeRule('bad-token', {
    predicate: [
      {
        op: 'op_in',
        args: { operations: ['${SESSION_WORKSPACE}'] },
      },
    ],
  });
  const unsupportedCompilation = compile(makeCandidate([unsupported]));
  assert.equal(unsupportedCompilation.result.valid, false);
  assert.ok(
    unsupportedCompilation.result.issues.some(
      (issue) => issue.code === 'unsupported_workspace_token',
    ),
  );
  assert.equal(
    JSON.stringify(unsupportedCompilation.result).includes(
      '${SESSION_WORKSPACE}',
    ),
    false,
  );
});

test('rule TTL semantics are engine-validated and an invalid workspace fails closed', () => {
  const invalidTtl = compile(
    makeCandidate([makeRule('ttl-bad', { ttl: '2026-13-40' })]),
  );
  assert.equal(invalidTtl.result.valid, false);
  assert.ok(
    invalidTtl.result.issues.some(
      (issue) => issue.code === 'invalid_rule_semantics',
    ),
  );

  const dateOnly = compile(
    makeCandidate([makeRule('ttl-date', { ttl: '2027-01-01' })]),
  );
  assert.equal(dateOnly.result.valid, true);

  const badWorkspace = validateAndCompileCandidate(
    makeCandidate([makeRule('r')]),
    'relative/path',
    validator,
  );
  assert.equal(badWorkspace.result.valid, false);
  assert.ok(
    badWorkspace.result.issues.some(
      (issue) => issue.code === 'invalid_workspace',
    ),
  );
});

test('bounded candidate input rejects excessive rule counts', () => {
  const rules = Array.from({ length: MAX_RULES_PER_CANDIDATE + 1 }, (_, index) =>
    makeRule(`rule-${index}`),
  );
  const result = compile(makeCandidate(rules));
  assert.equal(result.result.valid, false);
  assert.ok(
    result.result.issues.some((issue) => issue.code === 'payload_too_large'),
  );
});

test('proposal digest binds body fields and immutable execution context', () => {
  const clock = createTestClock();
  const candidate = makeCandidate([makeRule('r1')]);
  const base = {
    projectId: 'project-1',
    workspace,
    baseVersion: 0,
    title: 'Title',
    rationale: 'Rationale',
    expiresAt: futureIso(clock),
    restoreFromVersion: null,
    schemaDigest: validator.schemaDigest,
    compilerVersion: COMPILER_VERSION,
    candidate,
  } as const;

  const digest = proposalDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/);

  assert.notEqual(digest, proposalDigest({ ...base, projectId: 'project-2' }));
  assert.notEqual(
    digest,
    proposalDigest({ ...base, workspace: '/workspace/other' }),
  );
  assert.notEqual(
    digest,
    proposalDigest({ ...base, schemaDigest: 'f'.repeat(64) }),
  );
  assert.notEqual(
    digest,
    proposalDigest({ ...base, compilerVersion: 'amos-governance-compiler-v0' }),
  );
  assert.notEqual(digest, proposalDigest({ ...base, baseVersion: 1 }));
  assert.notEqual(digest, proposalDigest({ ...base, title: 'Other' }));
  assert.notEqual(digest, proposalDigest({ ...base, rationale: 'Other' }));
  assert.notEqual(
    digest,
    proposalDigest({ ...base, expiresAt: futureIso(clock, 120_000) }),
  );
  assert.notEqual(digest, proposalDigest({ ...base, restoreFromVersion: 1 }));
  assert.notEqual(
    digest,
    proposalDigest({
      ...base,
      candidate: makeCandidate([makeRule('r2')]),
    }),
  );
});

test('snapshot digests are versioned, lane-separated, and distinct from the legacy digest', () => {
  const candidate = makeCandidate([
    makeRule('det-1'),
    makeAdvisoryRule('adv-1'),
  ]);
  const compilation = compile(candidate);
  assert.ok(compilation.compiled);

  const makeSnapshot = (version: number, projectId = 'project-1') =>
    buildPolicySnapshot({
      projectId,
      workspace,
      version,
      compiled: compilation.compiled!,
      schemaDigest: validator.schemaDigest,
    });

  const first = makeSnapshot(1);
  const second = makeSnapshot(2);

  assert.equal(first.format, SNAPSHOT_FORMAT);
  assert.equal(first.formatVersion, SNAPSHOT_FORMAT_VERSION);
  assert.equal(first.schemaVersion, RULE_SCHEMA_VERSION);
  assert.equal(first.compilerVersion, COMPILER_VERSION);
  assert.equal(first.schemaDigest, validator.schemaDigest);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.match(first.enforcement.digest, /^[0-9a-f]{64}$/);
  assert.match(first.advisory.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.enforcementDigest, first.enforcement.digest);
  assert.equal(first.advisoryDigest, first.advisory.digest);
  assert.notEqual(first.enforcement.digest, first.advisory.digest);
  assert.notEqual(first.digest, first.enforcement.digest);
  assert.notEqual(first.digest, first.advisory.digest);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(
    first.digest,
    makeSnapshot(1, 'project-2').digest,
  );
  assert.notEqual(
    first.digest,
    buildPolicySnapshot({
      projectId: 'project-1',
      workspace: '/workspace/other',
      version: 1,
      compiled: compilation.compiled!,
      schemaDigest: validator.schemaDigest,
    }).digest,
  );

  const legacyDigest = createHash('sha256')
    .update(
      JSON.stringify(compilation.compiled!.candidate.rules) +
        '\0SESSION_WORKSPACE=' +
        workspace +
        '\0',
      'utf8',
    )
    .digest('hex');
  assert.notEqual(first.digest, legacyDigest);
  assert.notEqual(first.enforcement.digest, legacyDigest);

  assert.deepEqual(first.enforcement.rules, compilation.compiled!.enforcementRules);
  assert.deepEqual(first.advisory.rules, compilation.compiled!.advisoryRules);
  assert.deepEqual(first.activation, candidate.activation);
});

test('invalid schema text fails closed with a stable domain error', () => {
  expectDomainError(() => createRuleValidator('{'), 'schema_invalid', 500);
  expectDomainError(() => createRuleValidator('not json'), 'schema_invalid', 500);
});
