import { boundedCopy, deepFreeze, record, text, workspace } from './json.ts';
import { ActivationError, type ProjectActivationCompiler, type ProjectActivationSnapshot, type ProjectIdentity } from './types.ts';

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
): ProjectActivationStore {
  let identity: ProjectIdentity;
  try {
    const input = record(boundedCopy(expected), ['projectId', 'workspace']);
    identity = deepFreeze({ projectId: text(input.projectId), workspace: workspace(input.workspace) });
  } catch {
    throw new ActivationError();
  }
  let current: ProjectActivationSnapshot | null = null;
  return Object.freeze({
    current: () => current,
    load(input: unknown): ActivationLoadResult {
      try {
        const candidate = compiler.verify(compiler.compile(input), identity);
        current = candidate;
        return Object.freeze({ snapshot: current, error: null });
      } catch {
        return Object.freeze({ snapshot: current, error: 'activation_error' });
      }
    },
  });
}
