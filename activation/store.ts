import { boundedCopy, deepFreeze, record, text, workspace } from './json.ts';
import {
  ActivationError,
  type ActivationStoreOptions,
  type ProjectActivationCompiler,
  type ProjectActivationSnapshot,
  type ProjectIdentity,
} from './types.ts';

export interface ActivationLoadResult {
  readonly snapshot: ProjectActivationSnapshot | null;
  readonly error: 'activation_error' | null;
}

export interface ProjectActivationStore {
  current(): ProjectActivationSnapshot | null;
  load(input: unknown): ActivationLoadResult;
}

/** Process-local last-good only. No persistence, authenticity or runtime hot reload. */
export function createProjectActivationStore(
  compiler: ProjectActivationCompiler,
  expected: ProjectIdentity,
  options: ActivationStoreOptions,
): ProjectActivationStore {
  let identity: ProjectIdentity;
  try {
    const input = record(boundedCopy(expected), ['projectId', 'workspace']);
    identity = deepFreeze({ projectId: text(input.projectId), workspace: workspace(input.workspace) });
  } catch {
    throw new ActivationError();
  }
  let current: ProjectActivationSnapshot | null = null;
  let lastObservedTime: number | null = null;
  let clockInvalidated = false;
  const isValid = (snapshot: ProjectActivationSnapshot): boolean => {
    try {
      let now: number;
      try {
        now = options.now();
      } catch {
        clockInvalidated = true;
        return false;
      }
      if (clockInvalidated || !Number.isFinite(now) || (lastObservedTime !== null && now < lastObservedTime)) {
        clockInvalidated = true;
        return false;
      }
      lastObservedTime = now;
      if (options.isCurrentAuthorization(snapshot) !== true) return false;
      // Be conservative: a last-good snapshot is retained only while every
      // activated legacy TTL is still live. It is never renewed by fallback.
      return snapshot.activeRules.every(({ rule }) => {
        if (rule === null || rule.ttl === null) return true;
        const expiresAt = Date.parse(rule.ttl as string);
        return Number.isFinite(expiresAt) && now < expiresAt;
      });
    } catch {
      return false;
    }
  };
  const liveCurrent = (): ProjectActivationSnapshot | null => {
    if (current !== null && !isValid(current)) current = null;
    return current;
  };
  return Object.freeze({
    current: liveCurrent,
    load(input: unknown): ActivationLoadResult {
      liveCurrent();
      try {
        const candidate = compiler.verify(compiler.compile(input), identity);
        if (!isValid(candidate)) throw new ActivationError();
        current = candidate;
        return Object.freeze({ snapshot: current, error: null });
      } catch {
        return Object.freeze({ snapshot: liveCurrent(), error: 'activation_error' });
      }
    },
  });
}
