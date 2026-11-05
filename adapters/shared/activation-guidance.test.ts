import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createProjectActivationCompiler } from '../../activation/compiler.ts';
import { options as compilerOptions, project as projectInput } from '../../activation/test-support.ts';
import { loadActivationGuidance } from './activation-guidance.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly workspace: string;
  readonly snapshotPath: string;
  readonly projectId: string;
} {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync(join('/tmp/opencode', 'amos-activation-guidance-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  const projectId = 'project-1';
  const compiler = createProjectActivationCompiler(compilerOptions());
  const snapshot = compiler.compile(
    projectInput({
      projectId,
      workspace,
      selectedRuleRefs: [{ id: 'typescript', version: 1 }],
      advisoryBaselineRuleIds: ['baseline'],
    }),
  );
  const snapshotPath = join(root, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');
  return { workspace, snapshotPath, projectId };
}

describe('activation-backed adapter guidance', () => {
  it('selects only active narratives and does not fall back to the seed', () => {
    const { workspace, snapshotPath, projectId } = fixture();
    const loaded = loadActivationGuidance({ snapshotPath, projectId, workspace });
    assert.equal(loaded.status, 'ready');
    const session = loaded.createSession();
    const block = session.selectPrompt('please work on typescript');
    assert.ok(block.ruleIds.includes('typescript'));
    assert.equal(block.ruleIds.includes('python'), false);
    assert.match(block.text, /amos-guidance/);
  });

  it('rejects a wrong workspace and yields an empty session, never the global seed', () => {
    const { snapshotPath, projectId } = fixture();
    const loaded = loadActivationGuidance({
      snapshotPath,
      projectId,
      workspace: '/tmp/opencode/not-the-snapshot-workspace',
    });
    assert.equal(loaded.status, 'error');
    const block = loaded.createSession().selectPrompt('typescript');
    assert.equal(block.text, '');
    assert.deepEqual(block.ruleIds, []);
  });

  it('rejects malformed or oversized snapshots with a fixed error', () => {
    mkdirSync('/tmp/opencode', { recursive: true });
    const root = mkdtempSync(join('/tmp/opencode', 'amos-activation-guidance-bad-'));
    roots.push(root);
    const path = join(root, 'bad.json');
    writeFileSync(path, '{not-json', 'utf8');
    const loaded = loadActivationGuidance({
      snapshotPath: path,
      projectId: 'project-1',
      workspace: root,
    });
    assert.deepEqual(
      { status: loaded.status, code: loaded.status === 'error' ? loaded.code : null },
      { status: 'error', code: 'activation_guidance_error' },
    );
    assert.equal(loaded.createSession().selectPrompt('x').text, '');
  });
});
