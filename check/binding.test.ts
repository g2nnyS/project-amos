import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CHECK_BINDING_FORMAT,
  FINDING_BATCH_FORMAT,
  MAX_FINDINGS,
  acceptFindingBatch,
  createCheckBinding,
  createFindingBatch,
  digestTree,
  isSafeRelativePath,
  type AcceptanceInput,
  type CheckBinding,
  type FindingBatch,
} from './index.ts';
import { CheckError } from './index.ts';

const BASE = '/tmp/opencode';
const TREE = `sha256:${'a'.repeat(64)}`;
const COMMAND = `sha256:${'b'.repeat(64)}`;
const MESSAGE = `sha256:${'c'.repeat(64)}`;

function sha(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function bindingInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: CHECK_BINDING_FORMAT,
    version: 1,
    projectId: 'project-1',
    treeDigest: TREE,
    ruleRef: { id: 'rule-1', version: 1 },
    check: { id: 'typescript-noemit', version: '1' },
    analyzer: { id: 'tsc', version: '7.0.2' },
    checkpoint: 'ci',
    commandDigest: COMMAND,
    issuedAt: 1_000,
    ...overrides,
  };
}

function makeBinding(overrides: Record<string, unknown> = {}): CheckBinding {
  return createCheckBinding(bindingInput(overrides));
}

function batchInput(
  binding: CheckBinding,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: FINDING_BATCH_FORMAT,
    version: 1,
    bindingDigest: binding.digest,
    treeDigest: binding.treeDigest,
    status: 'complete',
    coverage: {
      filesExpected: 2,
      filesChecked: 2,
      analyzersExpected: 1,
      analyzersRun: 1,
    },
    findings: [],
    completedAt: 2_000,
    ...overrides,
  };
}

function makeBatch(
  binding: CheckBinding,
  overrides: Record<string, unknown> = {},
): FindingBatch {
  return createFindingBatch(batchInput(binding, overrides));
}

function acceptance(
  binding: CheckBinding,
  batch: FindingBatch,
  overrides: Record<string, unknown> = {},
): AcceptanceInput {
  return {
    binding,
    batch,
    currentTreeDigest: binding.treeDigest,
    expectedCheck: { id: binding.check.id, version: binding.check.version },
    expectedAnalyzer: {
      id: binding.analyzer.id,
      version: binding.analyzer.version,
    },
    expectedRuleRef: {
      id: binding.ruleRef.id,
      version: binding.ruleRef.version,
    },
    ...overrides,
  } as AcceptanceInput;
}

function assertCheckError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CheckError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function finding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ruleId: 'rule-1',
    path: 'src/index.ts',
    line: 1,
    messageDigest: MESSAGE,
    ...overrides,
  };
}

test('binding digest is deterministic, order-independent and frozen', () => {
  const first = makeBinding();
  const second = makeBinding();
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.ruleRef));
  assert.ok(Object.isFrozen(first.check));

  // Canonical JSON sorts keys, so input property order is irrelevant.
  const reordered = createCheckBinding(
    Object.fromEntries(Object.entries(bindingInput()).reverse()),
  );
  assert.equal(reordered.digest, first.digest);
});

test('binding rejects unknown fields, bad digests and bad rule versions', () => {
  assertCheckError(
    () => createCheckBinding({ ...bindingInput(), extra: true }),
    'invalid_binding',
  );
  assertCheckError(
    () =>
      createCheckBinding(
        bindingInput({ ruleRef: { id: 'rule-1', version: 1, extra: 1 } }),
      ),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ treeDigest: 'md5:abc' })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ commandDigest: 'sha256:xyz' })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ ruleRef: { id: 'rule-1', version: 0 } })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ ruleRef: { id: 'rule-1', version: 1.5 } })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ checkpoint: 'nightly' })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ issuedAt: Number.NaN })),
    'invalid_binding',
  );
  assertCheckError(
    () => createCheckBinding(bindingInput({ digest: sha('0') })),
    'digest_mismatch',
  );
});

test('a complete batch with exact coverage for the current tree is accepted', () => {
  const binding = makeBinding();
  const batch = makeBatch(binding);
  const result = acceptFindingBatch(acceptance(binding, batch));
  assert.deepEqual(result, { accepted: true });
  assert.ok(Object.isFrozen(result));

  const withFinding = makeBatch(binding, {
    findings: [finding(), finding({ path: 'src/other.ts', line: 4 })],
  });
  assert.deepEqual(acceptFindingBatch(acceptance(binding, withFinding)), {
    accepted: true,
  });
});

test('failed, incomplete, uncovered and zero-coverage batches are rejected', () => {
  const binding = makeBinding();

  for (const status of ['failed', 'incomplete'] as const) {
    const batch = makeBatch(binding, { status });
    const result = acceptFindingBatch(acceptance(binding, batch));
    assert.deepEqual(result, { accepted: false, code: 'batch_not_complete' });
  }

  const zero = makeBatch(binding, {
    coverage: {
      filesExpected: 0,
      filesChecked: 0,
      analyzersExpected: 0,
      analyzersRun: 0,
    },
  });
  assert.deepEqual(acceptFindingBatch(acceptance(binding, zero)), {
    accepted: false,
    code: 'incomplete_coverage',
  });

  const short = makeBatch(binding, {
    coverage: {
      filesExpected: 2,
      filesChecked: 1,
      analyzersExpected: 1,
      analyzersRun: 1,
    },
  });
  assert.deepEqual(acceptFindingBatch(acceptance(binding, short)), {
    accepted: false,
    code: 'incomplete_coverage',
  });

  // Coverage must be present in a batch at all.
  const { coverage, ...withoutCoverage } = batchInput(binding);
  assertCheckError(
    () => createFindingBatch({ ...withoutCoverage, digest: sha('d') }),
    'invalid_batch',
  );
  const forgedAbsent = {
    ...withoutCoverage,
    // self-consistent digest is irrelevant: shape is checked first
    digest: sha('d'),
  } as unknown as FindingBatch;
  assert.deepEqual(
    acceptFindingBatch(acceptance(binding, forgedAbsent)),
    { accepted: false, code: 'invalid_batch' },
  );
});

test('a stale tree is rejected after the workspace changes', (t) => {
  const root = mkdtempSync(join(BASE, 'amos-check-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');

  const originalTree = digestTree({ root }).digest;
  const binding = makeBinding({ treeDigest: originalTree });
  const batch = makeBatch(binding);

  assert.deepEqual(acceptFindingBatch(acceptance(binding, batch)), {
    accepted: true,
  });

  writeFileSync(join(root, 'index.ts'), 'export const value = 2;\n');
  const modifiedTree = digestTree({ root }).digest;
  assert.notEqual(modifiedTree, originalTree);

  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, { currentTreeDigest: modifiedTree }),
    ),
    { accepted: false, code: 'stale_tree' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, { currentTreeDigest: 'not-a-digest' }),
    ),
    { accepted: false, code: 'invalid_current_tree' },
  );
});

test('forged binding and batch digests are rejected', () => {
  const binding = makeBinding();
  const batch = makeBatch(binding);

  const forgedBinding = { ...binding, digest: sha('0') } as CheckBinding;
  assert.deepEqual(
    acceptFindingBatch(acceptance(forgedBinding, batch)),
    { accepted: false, code: 'binding_digest_mismatch' },
  );

  const forgedBatch = { ...batch, digest: sha('1') } as FindingBatch;
  assert.deepEqual(
    acceptFindingBatch(acceptance(binding, forgedBatch)),
    { accepted: false, code: 'batch_digest_mismatch' },
  );

  // A batch that points at a different, otherwise valid binding.
  const otherBinding = makeBinding({ projectId: 'project-2' });
  const otherBatch = makeBatch(otherBinding);
  assert.deepEqual(acceptFindingBatch(acceptance(binding, otherBatch)), {
    accepted: false,
    code: 'binding_mismatch',
  });

  assertCheckError(
    () => createFindingBatch(batchInput(binding, { digest: sha('0') })),
    'digest_mismatch',
  );
});

test('wrong check, analyzer, rule and versions are rejected', () => {
  const binding = makeBinding();
  const batch = makeBatch(binding);

  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedCheck: { id: 'other-check', version: '1' },
      }),
    ),
    { accepted: false, code: 'check_mismatch' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedCheck: { id: binding.check.id, version: '2' },
      }),
    ),
    { accepted: false, code: 'check_mismatch' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedAnalyzer: { id: 'other-analyzer', version: '7.0.2' },
      }),
    ),
    { accepted: false, code: 'analyzer_mismatch' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedAnalyzer: { id: binding.analyzer.id, version: '7.0.1' },
      }),
    ),
    { accepted: false, code: 'analyzer_mismatch' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedRuleRef: { id: 'rule-1', version: 2 },
      }),
    ),
    { accepted: false, code: 'rule_mismatch' },
  );
  assert.deepEqual(
    acceptFindingBatch(
      acceptance(binding, batch, {
        expectedRuleRef: { id: 'rule-2', version: 1 },
      }),
    ),
    { accepted: false, code: 'rule_mismatch' },
  );
});

test('unsafe paths, unbound rules and duplicate findings are rejected', () => {
  const binding = makeBinding();

  for (const path of [
    '../escape.ts',
    'src/../../escape.ts',
    '/etc/passwd',
    'C:/windows.ts',
    './relative.ts',
    'src//double.ts',
    'src\\windows.ts',
  ]) {
    assert.equal(isSafeRelativePath(path), false, path);
    const batch = makeBatch(binding, {
      findings: [finding({ path })],
    });
    assert.deepEqual(acceptFindingBatch(acceptance(binding, batch)), {
      accepted: false,
      code: 'unsafe_path',
    }, path);
  }

  assert.equal(isSafeRelativePath('src/index.ts'), true);
  assert.equal(isSafeRelativePath('a.b/c-d_e.ts'), true);

  const unbound = makeBatch(binding, {
    findings: [finding({ ruleId: 'rule-2' })],
  });
  assert.deepEqual(acceptFindingBatch(acceptance(binding, unbound)), {
    accepted: false,
    code: 'unbound_rule',
  });

  const duplicate = makeBatch(binding, {
    findings: [finding(), finding()],
  });
  assert.deepEqual(acceptFindingBatch(acceptance(binding, duplicate)), {
    accepted: false,
    code: 'duplicate_finding',
  });

  // Same rule and location with different analyzer wording is still duplicate identity.
  const duplicateIdentity = makeBatch(binding, {
    findings: [finding(), finding({ messageDigest: sha('e') })],
  });
  assert.deepEqual(
    acceptFindingBatch(acceptance(binding, duplicateIdentity)),
    { accepted: false, code: 'duplicate_finding' },
  );

  assertCheckError(
    () => makeBatch(binding, { findings: [finding({ line: 0 })] }),
    'invalid_line',
  );
  assertCheckError(
    () => makeBatch(binding, { findings: [finding({ path: '' })] }),
    'invalid_path',
  );
  assertCheckError(
    () => makeBatch(binding, { findings: [finding({ path: 'src/\0nul.ts' })] }),
    'invalid_path',
  );
});

test('batch creation is a strict schema but not an acceptance decision', () => {
  const binding = makeBinding();

  assertCheckError(
    () => createFindingBatch({ ...batchInput(binding), extra: true }),
    'invalid_batch',
  );
  assertCheckError(
    () => createFindingBatch(batchInput(binding, { version: 2 })),
    'invalid_batch',
  );
  assertCheckError(
    () => createFindingBatch(batchInput(binding, { status: 'partial' })),
    'invalid_batch',
  );
  assertCheckError(
    () =>
      createFindingBatch(
        batchInput(binding, {
          findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding()),
        }),
      ),
    'invalid_batch',
  );
  assertCheckError(
    () =>
      createFindingBatch(
        batchInput(binding, {
          findings: [{ ...finding(), messageDigest: 'plain text message' }],
        }),
      ),
    'invalid_batch',
  );
  assertCheckError(
    () => createFindingBatch(batchInput(binding, { completedAt: -1 })),
    'invalid_batch',
  );
});
