import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRequirementRegistry,
  defaultRequirementRegistryPath,
  DEFAULT_REQUIREMENT_TTL_MS,
  REQUIREMENT_REGISTRY_FORMAT,
  REQUIREMENT_REGISTRY_VERSION,
  RequirementRegistryError,
  type RequirementCaptureInput,
  type RequirementCaptureResult,
  type RequirementRegistryOptions,
} from './requirement-registry.ts';
import { requirementFrameDigest } from './requirement.ts';

const NOW = Date.parse('2026-11-07T00:00:00.000Z');
const UID = typeof process.getuid === 'function' ? process.getuid() : 1_000;
const MARKER = 'REQUIREMENT-TEXT-MARKER-7f3a';

interface Fixture {
  readonly root: string;
  readonly path: string;
  readonly options: RequirementRegistryOptions;
}

/** Minimal structural view of `node:test`'s context, for cleanup hooks. */
interface Cleanup {
  after(fn: () => void): void;
}

function fixture(
  t: Cleanup,
  overrides: Partial<RequirementRegistryOptions> = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'amos-requirement-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state', 'requirements.json');
  return {
    root,
    path,
    options: {
      path,
      projectId: 'proj_amos',
      ownerUid: UID,
      now: () => NOW,
      ...overrides,
    },
  };
}

function message(
  overrides: Partial<RequirementCaptureInput> = {},
): RequirementCaptureInput {
  return {
    sessionId: 'ses_001',
    epoch: 1,
    text: 'Refactor the parser.',
    egress: 'denied',
    actor: 'user',
    capturedBy: 'harness',
    ...overrides,
  };
}

function captured(
  result: RequirementCaptureResult,
): Extract<RequirementCaptureResult, { status: 'captured' }> {
  if (result.status !== 'captured') {
    assert.fail(`expected capture, got ${result.status}:${result.code}`);
  }
  return result;
}

function readState(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function sessionsOf(
  state: Record<string, unknown>,
): Record<string, unknown>[] {
  return state.sessions as Record<string, unknown>[];
}

function revisionsOf(
  state: Record<string, unknown>,
): Record<string, unknown>[] {
  return sessionsOf(state)[0].revisions as Record<string, unknown>[];
}

function rewrite(path: string, state: unknown): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function seed(t: Cleanup, text = 'Baseline requirement.'): Fixture {
  const context = fixture(t);
  const registry = createRequirementRegistry(context.options);
  captured(registry.captureUserMessage(message({ text })));
  registry.close();
  return context;
}

test('capture establishes baseline version 1 with a bound digest', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const result = captured(
    registry.captureUserMessage(message({ text: 'Refactor the parser.' })),
  );
  assert.equal(result.version, 1);
  assert.equal(result.expiresAt, NOW + DEFAULT_REQUIREMENT_TTL_MS);

  const resolution = registry.resolve('ses_001', 1);
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.version, 1);
  assert.equal(resolution.digest, result.digest);
  assert.equal(resolution.expiresAt, result.expiresAt);
  assert.equal(resolution.frame?.frame_id, 'ses_001:v1');
  assert.equal(resolution.frame?.text, 'Refactor the parser.');
  assert.equal(
    requirementFrameDigest(resolution.frame!),
    result.digest,
  );
  assert.equal(registry.size, 1);

  const stored = readState(path);
  assert.equal(stored.format, REQUIREMENT_REGISTRY_FORMAT);
  assert.equal(stored.version, REQUIREMENT_REGISTRY_VERSION);
  assert.equal(sessionsOf(stored)[0].sequence, 1);
  assert.equal(revisionsOf(stored)[0].digest, result.digest);
});

test('a second turn creates version 2 and stops returning version 1', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const first = captured(registry.captureUserMessage(message()));
  const second = captured(
    registry.captureUserMessage(message({ text: 'Ship the release.' })),
  );

  assert.equal(second.version, 2);
  assert.notEqual(second.digest, first.digest);

  const resolution = registry.resolve('ses_001', 1);
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.version, 2);
  assert.equal(resolution.digest, second.digest);
  assert.notEqual(resolution.digest, first.digest);
  assert.equal(resolution.frame?.frame_id, 'ses_001:v2');

  const revisions = revisionsOf(readState(path));
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].digest, first.digest);
  assert.equal(revisions[1].digest, second.digest);
});

test('a new instance restores the version and digest from disk', (t) => {
  const { path, options } = fixture(t);
  const first = createRequirementRegistry(options);
  const firstCapture = captured(first.captureUserMessage(message()));
  const secondCapture = captured(
    first.captureUserMessage(message({ text: 'Ship the release.' })),
  );
  first.close();

  const reopened = createRequirementRegistry(options);
  t.after(() => reopened.close());
  const resolution = reopened.resolve('ses_001', 1);
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.version, 2);
  assert.equal(resolution.digest, secondCapture.digest);
  assert.notEqual(resolution.digest, firstCapture.digest);
  assert.equal(reopened.size, 1);
  assert.equal(readState(path).format, REQUIREMENT_REGISTRY_FORMAT);
});

test('a stale instance reports conflict and recovers on the next turn', (t) => {
  const { path, options } = fixture(t);
  const a = createRequirementRegistry(options);
  t.after(() => a.close());
  captured(a.captureUserMessage(message({ text: 'First instruction.' })));

  const b = createRequirementRegistry(options);
  t.after(() => b.close());
  assert.equal(b.resolve('ses_001', 1).version, 1);

  const aSecond = captured(
    a.captureUserMessage(message({ text: 'A revised instruction.' })),
  );
  assert.equal(aSecond.version, 2);

  const stale = b.captureUserMessage(message({ text: 'B stale instruction.' }));
  assert.deepEqual(stale, { status: 'rejected', code: 'conflict' });
  assert.equal(b.resolve('ses_001', 1).status, 'conflict');
  assert.equal(b.resolve('ses_001', 1).frame, null);

  // The loser never wrote: disk still holds A's version 2 only.
  const stored = readState(path);
  const revisions = revisionsOf(stored);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].digest, aSecond.digest);
  assert.equal(sessionsOf(stored)[0].sequence, 2);

  const recovered = captured(
    b.captureUserMessage(message({ text: 'B new instruction.' })),
  );
  assert.equal(recovered.version, 3);
  assert.equal(b.resolve('ses_001', 1).status, 'ready');
  assert.equal(b.resolve('ses_001', 1).version, 3);
  assert.equal(revisionsOf(readState(path)).length, 3);
});

test('resolution re-reads revisions and revocation from other instances', (t) => {
  const { options } = fixture(t);
  const a = createRequirementRegistry(options);
  const b = createRequirementRegistry(options);
  t.after(() => a.close());
  t.after(() => b.close());
  captured(a.captureUserMessage(message({ text: 'First instruction.' })));
  assert.equal(b.resolve('ses_001', 1).version, 1);

  const second = captured(
    a.captureUserMessage(message({ text: 'A revised instruction.' })),
  );
  const revised = b.resolve('ses_001', 1);
  assert.equal(revised.status, 'ready');
  assert.equal(revised.version, 2);
  assert.equal(revised.digest, second.digest);

  assert.equal(a.revoke('ses_001'), true);
  assert.equal(b.resolve('ses_001', 1).status, 'revoked');
});

test('revoke persists, and a new user turn restores a higher version', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const first = captured(registry.captureUserMessage(message()));
  assert.equal(registry.revoke('ses_001'), true);
  assert.equal(registry.resolve('ses_001', 1).status, 'revoked');
  assert.equal(registry.resolve('ses_001', 1).frame, null);
  assert.equal(sessionsOf(readState(path))[0].state, 'revoked');

  const reopened = createRequirementRegistry(options);
  t.after(() => reopened.close());
  assert.equal(reopened.resolve('ses_001', 1).status, 'revoked');

  const second = captured(
    registry.captureUserMessage(message({ text: 'Resume the work.' })),
  );
  assert.equal(second.version, 2);
  assert.notEqual(second.digest, first.digest);
  assert.equal(registry.resolve('ses_001', 1).status, 'ready');
  assert.equal(registry.resolve('ses_001', 1).version, 2);
  assert.equal(sessionsOf(readState(path))[0].state, 'active');
});

test('revoking an unknown session reports false', (t) => {
  const { options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  assert.equal(registry.revoke('ses_absent'), false);
  assert.equal(registry.revoke('bad session'), false);
});

test('ttl expiry stops resolution and never revives', (t) => {
  let clock = NOW;
  const { options } = fixture(t, { ttlMs: 1_000, now: () => clock });
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const result = captured(registry.captureUserMessage(message()));
  assert.equal(result.expiresAt, NOW + 1_000);

  clock = NOW + 999;
  assert.equal(registry.resolve('ses_001', 1).status, 'ready');

  clock = NOW + 1_000;
  assert.equal(registry.resolve('ses_001', 1).status, 'expired');
  assert.equal(registry.resolve('ses_001', 1).frame, null);

  clock = NOW + 10_000_000;
  assert.equal(registry.resolve('ses_001', 1).status, 'expired');
});

test('invalid JSON leaves the registry corrupt and the file untouched', (t) => {
  const { path, options } = seed(t);
  writeFileSync(path, '{not-json', { mode: 0o600 });

  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'corrupt');
  assert.deepEqual(registry.captureUserMessage(message()), {
    status: 'rejected',
    code: 'corrupt',
  });
  assert.equal(readFileSync(path, 'utf8'), '{not-json');
});

test('a frame digest mismatch is corrupt and blocks capture', (t) => {
  const { path, options } = seed(t);
  const state = readState(path);
  revisionsOf(state)[0].digest = `sha256:${'0'.repeat(64)}`;
  rewrite(path, state);
  const before = readFileSync(path, 'utf8');

  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'corrupt');
  assert.deepEqual(registry.captureUserMessage(message()), {
    status: 'rejected',
    code: 'corrupt',
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a revision version gap is corrupt and blocks capture', (t) => {
  const { path, options } = seed(t);
  const state = readState(path);
  revisionsOf(state)[0].version = 2;
  rewrite(path, state);
  const before = readFileSync(path, 'utf8');

  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'corrupt');
  assert.deepEqual(registry.captureUserMessage(message()), {
    status: 'rejected',
    code: 'corrupt',
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a world-readable state file is owner_mismatch', (t) => {
  const { path, options } = seed(t);
  chmodSync(path, 0o644);
  const before = readFileSync(path, 'utf8');

  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'owner_mismatch');
  assert.deepEqual(registry.captureUserMessage(message()), {
    status: 'rejected',
    code: 'owner_mismatch',
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a state file owned by another uid is owner_mismatch', (t) => {
  const { path, options } = seed(t);
  const before = readFileSync(path, 'utf8');

  const registry = createRequirementRegistry({
    ...options,
    ownerUid: UID + 1,
  });
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'owner_mismatch');
  assert.deepEqual(registry.captureUserMessage(message()), {
    status: 'rejected',
    code: 'owner_mismatch',
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a project id mismatch is owner_mismatch', (t) => {
  const { options } = seed(t);
  const registry = createRequirementRegistry({
    ...options,
    projectId: 'proj_other',
  });
  t.after(() => registry.close());
  assert.equal(registry.resolve('ses_001', 1).status, 'owner_mismatch');
});

test('a different epoch resolves as unavailable, never rebound', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const first = captured(registry.captureUserMessage(message({ epoch: 1 })));
  assert.equal(registry.resolve('ses_001', 1).status, 'ready');
  assert.equal(registry.resolve('ses_001', 2).status, 'unavailable');
  assert.equal(registry.resolve('ses_001', 2).frame, null);
  assert.equal(registry.resolve('ses_001', 2).version, null);
  // The stale epoch never rewrote anything.
  assert.equal(revisionsOf(readState(path)).length, 1);

  const second = captured(
    registry.captureUserMessage(message({ epoch: 2, text: 'New epoch.' })),
  );
  assert.equal(second.version, 2);
  assert.notEqual(second.digest, first.digest);
  assert.equal(registry.resolve('ses_001', 2).status, 'ready');
  assert.equal(registry.resolve('ses_001', 2).version, 2);
  assert.equal(registry.resolve('ses_001', 1).status, 'unavailable');

  const stored = readState(path);
  assert.equal(sessionsOf(stored)[0].epoch, 2);
  const revisions = revisionsOf(stored);
  assert.equal(revisions[0].epoch, 1);
  assert.equal(revisions[1].epoch, 2);
  assert.equal(revisions[1].digest, second.digest);
});

test('requirement text never reaches errors or resolutions', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  const result = captured(
    registry.captureUserMessage(
      message({ text: `Refactor ${MARKER} now.` }),
    ),
  );
  assert.equal(JSON.stringify(result).includes(MARKER), false);

  const resolution = registry.resolve('ses_001', 1);
  assert.equal(JSON.stringify(resolution).includes(MARKER), false);
  assert.equal(String(resolution.status).includes(MARKER), false);

  // The text exists only inside the protected state file.
  assert.equal(readFileSync(path, 'utf8').includes(MARKER), true);

  registry.close();
  let error: unknown;
  try {
    registry.resolve('ses_001', 1);
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof RequirementRegistryError, true);
  assert.equal(String(error).includes(MARKER), false);
  assert.equal((error as RequirementRegistryError).code, 'registry_closed');
});

test('a non-user actor is rejected as invalid without writing', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const agent = registry.captureUserMessage(
    message({ actor: 'agent' as never }),
  );
  assert.deepEqual(agent, { status: 'rejected', code: 'invalid' });
  assert.equal(existsSync(path), false);
  assert.equal(registry.size, 0);
  assert.equal(registry.resolve('ses_001', 1).status, 'missing');

  const wrongChannel = registry.captureUserMessage(
    message({ capturedBy: 'adapter' as never }),
  );
  assert.deepEqual(wrongChannel, { status: 'rejected', code: 'invalid' });
  assert.equal(existsSync(path), false);
});

test('invalid capture input is rejected without writing', (t) => {
  const { path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const cases: RequirementCaptureInput[] = [
    message({ sessionId: 'bad session' }),
    message({ sessionId: '' }),
    message({ text: '' }),
    message({ text: '   ' }),
    message({ text: 'nul\0byte' }),
    message({ text: 'x'.repeat(4_097) }),
    message({ egress: 'maybe' as never }),
    message({ epoch: -1 }),
    message({ epoch: 1.5 }),
    message({ epoch: 'one' as never }),
    message({ declaredScope: Array.from({ length: 17 }, () => 'scope') }),
    message({ declaredScope: ['x'.repeat(201)] }),
    message({ declaredScope: ['  '] }),
  ];
  for (const input of cases) {
    assert.deepEqual(registry.captureUserMessage(input), {
      status: 'rejected',
      code: 'invalid',
    });
  }
  assert.equal(existsSync(path), false);
  assert.equal(registry.size, 0);
});

test('capture creates a 0700 directory and a 0600 file', (t) => {
  const { root, path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  captured(registry.captureUserMessage(message()));
  const directoryMode = statSync(join(root, 'state')).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a failed write is reported as unavailable and writes nothing', {
  skip:
    typeof process.getuid === 'function' && process.getuid() === 0
      ? 'root bypasses directory permissions'
      : false,
}, (t) => {
  const { root, path, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());

  const stateDirectory = join(root, 'state');
  chmodSync(stateDirectory, 0o500);
  try {
    assert.deepEqual(registry.captureUserMessage(message()), {
      status: 'rejected',
      code: 'unavailable',
    });
    assert.equal(existsSync(path), false);
    assert.equal(registry.resolve('ses_001', 1).status, 'missing');
    assert.equal(registry.size, 0);
  } finally {
    chmodSync(stateDirectory, 0o700);
  }
});

test('failed revision and revocation stop the previous requirement', {
  skip:
    typeof process.getuid === 'function' && process.getuid() === 0
      ? 'root bypasses directory permissions'
      : false,
}, (t) => {
  const { root, options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  captured(registry.captureUserMessage(message({ text: 'First turn.' })));
  const stateDirectory = join(root, 'state');

  chmodSync(stateDirectory, 0o500);
  try {
    assert.deepEqual(
      registry.captureUserMessage(message({ text: 'Second turn.' })),
      { status: 'rejected', code: 'unavailable' },
    );
    assert.equal(registry.resolve('ses_001', 1).status, 'unavailable');
  } finally {
    chmodSync(stateDirectory, 0o700);
  }

  const recovered = captured(
    registry.captureUserMessage(message({ text: 'Third turn.' })),
  );
  assert.equal(recovered.version, 2);
  assert.equal(registry.resolve('ses_001', 1).digest, recovered.digest);

  chmodSync(stateDirectory, 0o500);
  try {
    assert.equal(registry.revoke('ses_001'), false);
    assert.equal(registry.resolve('ses_001', 1).status, 'unavailable');
  } finally {
    chmodSync(stateDirectory, 0o700);
  }
});

test('close rejects every later call with a fixed code', (t) => {
  const { options } = fixture(t);
  const registry = createRequirementRegistry(options);
  captured(registry.captureUserMessage(message()));
  registry.close();
  registry.close();

  const closed = (error: unknown): boolean =>
    error instanceof RequirementRegistryError &&
    error.code === 'registry_closed';

  assert.throws(() => registry.resolve('ses_001', 1), closed);
  assert.throws(() => registry.captureUserMessage(message()), closed);
  assert.throws(() => registry.revoke('ses_001'), closed);
  assert.throws(() => registry.size, closed);
});

test('unknown and malformed session ids resolve as missing', (t) => {
  const { options } = fixture(t);
  const registry = createRequirementRegistry(options);
  t.after(() => registry.close());
  captured(registry.captureUserMessage(message()));

  for (const sessionId of ['ses_absent', 'bad session', '', 'x'.repeat(129)]) {
    const resolution = registry.resolve(sessionId, 1);
    assert.equal(resolution.status, 'missing');
    assert.equal(resolution.frame, null);
    assert.equal(resolution.version, null);
    assert.equal(resolution.digest, null);
    assert.equal(resolution.expiresAt, null);
  }
});

test('default path stays under XDG state home, outside the workspace', () => {
  assert.equal(
    defaultRequirementRegistryPath('proj_amos', {
      XDG_STATE_HOME: '/home/example/.state',
    }),
    '/home/example/.state/amos-governance/requirement-registry/proj_amos.json',
  );
  assert.equal(
    defaultRequirementRegistryPath('proj_amos', {}),
    join(
      homedir(),
      '.local',
      'state',
      'amos-governance',
      'requirement-registry',
      'proj_amos.json',
    ),
  );
  assert.throws(() => defaultRequirementRegistryPath('bad/id', {}));
});

test('options are validated eagerly', () => {
  const base: RequirementRegistryOptions = {
    path: '/tmp/amos-registry-options.json',
    projectId: 'proj_amos',
    ownerUid: UID,
  };
  assert.throws(() => createRequirementRegistry({ ...base, ttlMs: 0 }));
  assert.throws(() => createRequirementRegistry({ ...base, ttlMs: 1.5 }));
  assert.throws(() => createRequirementRegistry({ ...base, ownerUid: -1 }));
  assert.throws(() => createRequirementRegistry({ ...base, projectId: '' }));
  assert.throws(() => createRequirementRegistry({ ...base, path: '' }));
});
