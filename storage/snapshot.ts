import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

export interface SnapshotStore {
  current(): Snapshot | null;
  load(rulesPath: string, schemaPath: string): SnapshotLoadResult;
}

export function createSnapshotStore(): SnapshotStore {
  let current: Snapshot | null = null;

  return {
    current(): Snapshot | null {
      return current;
    },

    load(rulesPath: string, schemaPath: string): SnapshotLoadResult {
      try {
        const rawRules = readFileSync(rulesPath, 'utf8');
        const rules: unknown = parseYaml(rawRules);

        const rawSchema = readFileSync(schemaPath, 'utf8');
        const schema: unknown = JSON.parse(rawSchema);

        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema as object);
        if (!validate(rules)) {
          throw new Error('rules do not match schema');
        }

        assertValidTable(rules);

        const digest = createHash('sha256').update(rawRules, 'utf8').digest('hex');
        const snapshot = deepFreeze({
          table: rules as readonly SnapshotRule[],
          digest,
        });

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
