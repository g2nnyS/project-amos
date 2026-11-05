import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { createActivationRuntime } from '../activation/runtime.ts';
import {
  injection,
  options as compilerOptions,
  project as projectInput,
} from '../activation/test-support.ts';
import type { VersionedRule } from '../activation/types.ts';
import { createHarnessGate } from './harness.ts';

test('a legal empty runtime projection allows an audited call without inventing rules', (t) => {
  const root = mkdtempSync(join('/tmp/opencode', 'amos-empty-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const base = compilerOptions();
  const advice: VersionedRule = {
    id: 'advice-only',
    version: 1,
    rule: null,
    narrative: 'Advisory-only project guidance.',
    provenance: {
      kind: 'guidance-pack-seed',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      packId: 'empty-gate-pack',
      packVersion: 'v1',
      sourceRef: 'docs/guidance.md',
    },
    injection: { ...injection('typescript'), level: 2 },
  };
  const compiler = createProjectActivationCompiler({
    ...base,
    rules: [advice],
    mandatoryRuleRefs: [],
  });
  const snapshot = compiler.compile(
    projectInput({
      projectId: 'empty-project',
      workspace,
      selectedRuleRefs: [{ id: 'advice-only', version: 1 }],
      advisoryBaselineRuleIds: [],
    }),
  );
  const runtime = createActivationRuntime(snapshot, {
    projectId: 'empty-project',
    workspace,
  });
  assert.equal(runtime.execution('runtime').status, 'empty');

  const auditPath = join(root, 'audit.jsonl');
  writeFileSync(auditPath, '', { mode: 0o600 });
  const gate = createHarnessGate({
    activation: runtime,
    auditPath,
    sessionId: 'session-empty',
    requirement: null,
    review: null,
  });
  return gate
    .preCall({
      callId: 'call-empty-1',
      action: {
        tool: 'write',
        operation: 'file_write',
        target: join(workspace, 'src/a.ts'),
      },
    })
    .then((result) => {
      assert.equal(result.action, 'allow');
      assert.equal(result.code, 'allowed');
      assert.deepEqual(result.matchedRuleIds, []);
      assert.equal(gate.recordResult('call-empty-1', 'executed'), true);
      gate.close();
    });
});
