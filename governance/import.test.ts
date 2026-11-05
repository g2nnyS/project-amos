import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  buildImportCandidate,
  previewImport,
  type ImportSources,
} from './import.ts';
import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import {
  HUMAN,
  RULES_YAML,
  createEnv,
  fullImportSources,
  publishOptions,
  seedProject,
} from './test-support.ts';

function rules(): Record<string, unknown>[] {
  return parseYaml(RULES_YAML) as Record<string, unknown>[];
}

function withRules(value: readonly unknown[]): ImportSources {
  return fullImportSources({ rulesYaml: stringifyYaml(value as unknown[]) });
}

test('import preview represents every rule, guidance seed, and setting without defaults', () => {
  const preview = previewImport(fullImportSources({
    piConfig: { mode: 'log-only', nested: { enabled: false } },
    opencodeOptions: { workflowGate: { enabled: false, shellGate: true } },
    jevConfig: { provider: 'typesafe', apiKey: '{env:TYPESAFE_API_KEY}', models: ['a'] },
  }));
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.issues, []);
  assert.equal(preview.rules.added.length, rules().length);
  const seedCount = GUIDANCE_PACKS.reduce((total, pack) => total + pack.rules.length, 0);
  assert.equal(preview.guidance.added.length, seedCount);
  assert.equal(preview.settings.length, 7);
  assert.deepEqual(preview.rules.removed, []);
  assert.deepEqual(preview.guidance.removed, []);
  assert.match(preview.schemaDigest, /^sha256:[0-9a-f]{64}$/);

  const candidate = buildImportCandidate(fullImportSources());
  assert.equal(candidate.rules?.length, rules().length);
  assert.equal(candidate.guidance?.length, GUIDANCE_PACKS.length);
});

test('duplicate rule IDs are rejected', () => {
  const value = rules();
  value.push({ ...value[0] });
  const preview = previewImport(withRules(value));
  assert.equal(preview.ok, false);
  assert.ok(preview.issues.some((issue) => issue.code === 'duplicate_id'));
});

test('unknown rule fields and invalid predicates are rejected', () => {
  const unknown = rules();
  unknown[0] = { ...unknown[0], extra_field: true };
  const unknownPreview = previewImport(withRules(unknown));
  assert.equal(unknownPreview.ok, false);
  assert.ok(unknownPreview.issues.some((issue) => issue.code === 'unknown_field'));

  const predicate = rules();
  predicate[1] = {
    ...predicate[1],
    predicate: [{ op: 'regex_route', args: { patterns: ['x'] } }],
  };
  const predicatePreview = previewImport(withRules(predicate));
  assert.equal(predicatePreview.ok, false);
  assert.ok(predicatePreview.issues.some((issue) => issue.code === 'invalid_predicate'));
});

test('secret literals are rejected and never echoed', () => {
  const secret = 'sk-live-governance-test-secret';
  const preview = previewImport(fullImportSources({
    jevConfig: { provider: 'typesafe', apiKey: secret },
  }));
  assert.equal(preview.ok, false);
  assert.ok(preview.issues.some((issue) => issue.code === 'secret_literal'));
  assert.equal(JSON.stringify(preview).includes(secret), false);
});

test('only {env:NAME} references are accepted for credential fields', () => {
  const preview = previewImport(fullImportSources({
    jevConfig: { provider: 'typesafe', apiKey: 'env:TYPESAFE_API_KEY' },
  }));
  assert.equal(preview.ok, true);
  const candidate = buildImportCandidate(fullImportSources({
    jevConfig: { provider: 'typesafe', apiKey: 'env:TYPESAFE_API_KEY' },
  }));
  const entry = candidate.settings?.find((setting) => setting.key === 'jev.apiKey');
  assert.equal(entry?.value, '{env:TYPESAFE_API_KEY}');
});

test('preview is deterministic and matches the published candidate digest', () => {
  const sources = fullImportSources();
  const first = previewImport(sources);
  const second = previewImport(sources);
  assert.deepEqual(first, second);

  const env = createEnv('import-digest');
  try {
    seedProject(env);
    const candidate = buildImportCandidate(sources);
    const proposal = env.store.createProposal(
      {
        projectId: 'p1',
        baseVersion: 0,
        type: 'rules',
        title: 'Import',
        rationale: 'Initial import',
        candidate,
      },
      HUMAN,
    );
    assert.equal(proposal.candidateDigest, first.candidateDigest);
    env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
    const publication = env.store.publish('p1', proposal.id, HUMAN, publishOptions(env));
    assert.equal(publication.candidateDigest, first.candidateDigest);
  } finally {
    env.db.close();
  }
});

test('preview without a current state reports additions, and a supplied state reports changes', () => {
  const missing = previewImport(fullImportSources({
    piConfig: { mode: 'log-only' },
  }));
  assert.equal(missing.settings.length, 1);
  assert.equal(missing.settings[0]?.changed, true);

  const current = previewImport(fullImportSources({
    piConfig: { mode: 'log-only' },
  }), {
    ruleDigests: {},
    guidanceDigests: {},
    settings: { 'pi.mode': 'log-only' },
  });
  assert.equal(current.settings[0]?.changed, false);
});
