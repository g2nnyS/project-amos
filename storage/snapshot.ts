import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { assertValidTable } from '../engine/engine.ts';

export type SnapshotRule = Readonly<Record<string, unknown>>;

export interface Snapshot {
  readonly table: readonly SnapshotRule[];
  readonly digest: string;
}

export interface SnapshotLoadResult {
  snapshot: Snapshot | null;
  error: 'snapshot_error' | null;
}

/**
 * The only runtime values a rule table may substitute. This is deliberately a
 * closed struct rather than a general variable map: the session workspace is
 * the single restricted substitution supported by the portable rule table.
 */
export interface SnapshotVariables {
  sessionWorkspace?: string;
}

export interface SnapshotStoreOptions {
  /**
   * Directory for content-addressed provenance archives. When set, every
   * successful load writes `<archiveDir>/<digest>.json` (or verifies an
   * existing file with the same digest).
   */
  archiveDir?: string;
}

/**
 * Persisted provenance for one snapshot digest. `rules` and `schema` are the
 * exact raw file bytes that were evaluated, so a later audit reader can
 * reconstruct the policy without trusting current files on disk.
 */
export interface SnapshotArchive {
  schema_version: 1;
  digest: string;
  session_workspace: string | null;
  rules: string;
  schema: string;
  schema_digest: string;
}

export interface SnapshotStore {
  current(): Snapshot | null;
  /**
   * Load and validate a rule table.
   *
   * `variables.sessionWorkspace` is substituted for the exact token
   * `${SESSION_WORKSPACE}` only inside `args.patterns` of `target_glob` and
   * `target_outside_glob` predicates. Any use of the token without a workspace
   * fails closed.
   *
   * The digest binds both the raw rule bytes and the effective workspace:
   * `SHA-256(rawRules + '\0SESSION_WORKSPACE=' + (value ?? '') + '\0')`.
   * Two sessions with different workspaces therefore cannot share a digest.
   */
  load(
    rulesPath: string,
    schemaPath: string,
    variables?: SnapshotVariables,
  ): SnapshotLoadResult;
}

const SESSION_WORKSPACE_TOKEN = '${SESSION_WORKSPACE}';

export function createSnapshotStore(
  options: SnapshotStoreOptions = {},
): SnapshotStore {
  const archiveDir = options.archiveDir;
  let current: Snapshot | null = null;

  return {
    current(): Snapshot | null {
      return current;
    },

    load(
      rulesPath: string,
      schemaPath: string,
      variables?: SnapshotVariables,
    ): SnapshotLoadResult {
      try {
        const rawRules = readFileSync(rulesPath, 'utf8');
        const parsed: unknown = parseYaml(rawRules);
        const sessionWorkspace = variables?.sessionWorkspace;

        if (sessionWorkspace !== undefined) {
          assertNormalizedSessionWorkspace(sessionWorkspace);
        }

        // Expand into a clone so the parsed input is never mutated or frozen,
        // and substitute only the explicit glob-pattern token.
        const rules = expandSessionWorkspace(parsed, sessionWorkspace);

        const rawSchema = readFileSync(schemaPath, 'utf8');
        const schema: unknown = JSON.parse(rawSchema);

        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema as object);
        if (!validate(rules)) {
          throw new Error('rules do not match schema');
        }

        assertValidTable(rules);

        const digest = snapshotDigest(rawRules, sessionWorkspace);
        const snapshot = deepFreeze({
          table: rules as readonly SnapshotRule[],
          digest,
        });

        if (archiveDir !== undefined) {
          // Provenance is part of a successful load: a write or verification
          // failure means the digest cannot be resolved later, so fail closed
          // before replacing `current`.
          archiveSnapshot(archiveDir, {
            digest,
            sessionWorkspace,
            rawRules,
            rawSchema,
          });
        }

        current = snapshot;
        return { snapshot, error: null };
      } catch {
        // Deliberately swallow validator/parser details: they can contain rule
        // content and must not be exposed through the audit surface.
        return { snapshot: current, error: 'snapshot_error' };
      }
    },
  };
}

/**
 * The digest formula is part of the audit-log contract: changing it would make
 * existing logs unresolvable. `schema_digest` is intentionally separate because
 * the schema is provenance metadata, not part of the snapshot identity.
 */
function snapshotDigest(
  rawRules: string,
  sessionWorkspace: string | undefined,
): string {
  return createHash('sha256')
    .update(
      rawRules +
        '\0SESSION_WORKSPACE=' +
        (sessionWorkspace ?? '') +
        '\0',
      'utf8',
    )
    .digest('hex');
}

function stringDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface ArchiveExpected {
  digest: string;
  sessionWorkspace: string | undefined;
  rawRules: string;
  rawSchema: string;
}

function archiveSnapshot(archiveDir: string, expected: ArchiveExpected): void {
  // Best-effort confidentiality, same caveat as the audit writer: an existing
  // directory keeps its mode and a same-user attacker can still read or rewrite
  // the archive. The trusted supervisor remains required.
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archivePath = join(archiveDir, `${expected.digest}.json`);

  const archive: SnapshotArchive = {
    schema_version: 1,
    digest: expected.digest,
    session_workspace: expected.sessionWorkspace ?? null,
    rules: expected.rawRules,
    schema: expected.rawSchema,
    schema_digest: stringDigest(expected.rawSchema),
  };
  // JSON.stringify escapes arbitrary raw content; it does not throw on lone
  // surrogates or control characters.
  const serialized = `${JSON.stringify(archive, null, 2)}\n`;

  try {
    writeFileSync(archivePath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    // The digest already has an archive. Reuse is only allowed when its content
    // matches the snapshot we just loaded; otherwise this is either tampering
    // or a digest collision and must fail closed.
    verifySnapshotArchive(archivePath, expected);
  }
}

function verifySnapshotArchive(
  archivePath: string,
  expected: ArchiveExpected,
): void {
  const parsed: unknown = JSON.parse(readFileSync(archivePath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('snapshot archive is not an object');
  }
  const archive = parsed as Record<string, unknown>;

  if (archive.schema_version !== 1) {
    throw new Error('snapshot archive schema_version is unsupported');
  }
  if (archive.digest !== expected.digest) {
    throw new Error('snapshot archive digest does not match');
  }

  const archivedWorkspace = archive.session_workspace;
  if (archivedWorkspace !== null && typeof archivedWorkspace !== 'string') {
    throw new Error('snapshot archive session_workspace is invalid');
  }
  if (archivedWorkspace !== (expected.sessionWorkspace ?? null)) {
    throw new Error('snapshot archive session_workspace does not match');
  }

  if (archive.rules !== expected.rawRules) {
    throw new Error('snapshot archive rules do not match');
  }

  if (
    typeof archive.schema !== 'string' ||
    archive.schema !== expected.rawSchema ||
    archive.schema_digest !== stringDigest(archive.schema)
  ) {
    throw new Error('snapshot archive schema does not match');
  }

  // Recompute from the archived bytes rather than trusting the stored digest
  // field alone.
  if (
    snapshotDigest(
      expected.rawRules,
      archivedWorkspace === null ? undefined : archivedWorkspace,
    ) !== archive.digest
  ) {
    throw new Error('snapshot archive digest cannot be reproduced');
  }
}

/**
 * Validate the single supported substitution value. Only a normalized absolute
 * POSIX path is accepted: it must start with `/`, contain no NUL, no `//`, no
 * `.`/`..` segments, and no trailing slash (except for the root `/`).
 */
function assertNormalizedSessionWorkspace(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('//') ||
    (value.length > 1 && value.endsWith('/'))
  ) {
    throw new Error('sessionWorkspace must be a normalized absolute POSIX path');
  }

  const segments = value.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '.' || segment === '..') {
      throw new Error('sessionWorkspace must be a normalized absolute POSIX path');
    }
  }
}

function expandSessionWorkspace(
  parsed: unknown,
  sessionWorkspace: string | undefined,
): unknown {
  const usesToken = containsSessionWorkspaceToken(parsed);
  if (usesToken && sessionWorkspace === undefined) {
    // Fail closed: a table that wants a workspace must not silently retain the
    // literal token and evaluate it as a path.
    throw new Error('rule table uses ${SESSION_WORKSPACE} without a session workspace');
  }

  const clone = structuredClone(parsed);
  if (sessionWorkspace !== undefined) {
    substituteGlobPatterns(clone, sessionWorkspace);
  }
  if (containsSessionWorkspaceTokenInPredicates(clone)) {
    // The token is reserved for glob patterns. An occurrence in operations,
    // keys, hosts, schemes, or another predicate shape must not silently
    // survive as a literal that looks configured but is not. Narrative, source,
    // and probe are documentation fields and may mention the token verbatim.
    throw new Error('SESSION_WORKSPACE token appears outside a supported pattern');
  }
  return clone;
}

function containsSessionWorkspaceTokenInPredicates(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((rule) => {
    if (rule === null || typeof rule !== 'object') {
      return false;
    }
    const predicate = (rule as Record<string, unknown>).predicate;
    return containsSessionWorkspaceToken(predicate);
  });
}

function containsSessionWorkspaceToken(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (typeof value === 'string') {
    return value.includes(SESSION_WORKSPACE_TOKEN);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsSessionWorkspaceToken(item, seen));
  }
  return Object.values(value).some((item) =>
    containsSessionWorkspaceToken(item, seen),
  );
}

/**
 * Mutate only the cloned table: replace the exact token inside `args.patterns`
 * of `target_glob` / `target_outside_glob` predicate calls. Narrative, source,
 * probe, keys, tool/operation strings, and every other field stay untouched.
 */
function substituteGlobPatterns(value: unknown, sessionWorkspace: string): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const rule of value) {
    if (rule === null || typeof rule !== 'object') {
      continue;
    }
    const predicate = (rule as Record<string, unknown>).predicate;
    if (!Array.isArray(predicate)) {
      continue;
    }

    for (const call of predicate) {
      if (call === null || typeof call !== 'object') {
        continue;
      }
      const record = call as Record<string, unknown>;
      if (record.op !== 'target_glob' && record.op !== 'target_outside_glob') {
        continue;
      }

      const args = record.args;
      if (args === null || typeof args !== 'object') {
        continue;
      }
      const patterns = (args as Record<string, unknown>).patterns;
      if (!Array.isArray(patterns)) {
        continue;
      }

      for (let index = 0; index < patterns.length; index += 1) {
        const pattern = patterns[index];
        if (typeof pattern === 'string') {
          patterns[index] = pattern
            .split(SESSION_WORKSPACE_TOKEN)
            .join(sessionWorkspace);
        }
      }
    }
  }
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item, seen);
    }
  } else {
    for (const item of Object.values(value)) {
      deepFreeze(item, seen);
    }
  }

  return Object.freeze(value);
}
