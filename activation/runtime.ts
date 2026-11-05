/**
 * Runtime binding for one verified offline activation snapshot.
 *
 * The binding is a structural consistency check, not source authentication:
 * anyone who can produce a well-formed snapshot can produce one. It ties the
 * execution projections and the advisory session to a single verified snapshot
 * identity so a host/adapter cannot mix projections from different activations.
 */

import {
  createProjectInjectorSession,
  verifyProjectActivationSnapshot,
  type ProjectInjectorSession,
} from './injector.ts';
import { boundedCopy, record, text, workspace } from './json.ts';
import {
  ActivationError,
  type ProjectActivationSnapshot,
  type ProjectIdentity,
} from './types.ts';

export interface ActivationExecutionView {
  readonly projectId: string;
  readonly workspace: string;
  readonly catalogVersion: string;
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly checkpoint: 'runtime' | 'ci' | 'server';
  readonly status: 'ready' | 'empty';
  readonly activationDigest: string;
  readonly digest: string;
  readonly ruleRefs: readonly { readonly id: string; readonly version: number }[];
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

export interface ActivationRuntime {
  readonly snapshot: ProjectActivationSnapshot;
  readonly projectId: string;
  readonly workspace: string;
  readonly epoch: number;
  readonly activationDigest: string;
  readonly catalogVersion: string;
  execution(checkpoint: 'runtime' | 'ci' | 'server'): ActivationExecutionView;
  injectorSession(now: number | (() => number)): ProjectInjectorSession;
}

/**
 * Structural verification + identity binding. This is NOT authentication of
 * the publisher; offline verify is only a consistency check.
 */
export function createActivationRuntime(
  value: unknown,
  expected: ProjectIdentity,
): ActivationRuntime {
  try {
    const identity = record(boundedCopy(expected), ['projectId', 'workspace']);
    const expectedProjectId = text(identity.projectId);
    const expectedWorkspace = workspace(identity.workspace);
    const snapshot = verifyProjectActivationSnapshot(value);
    if (snapshot.project.projectId !== expectedProjectId || snapshot.project.workspace !== expectedWorkspace) {
      throw new Error('identity_mismatch');
    }

    return Object.freeze({
      snapshot,
      projectId: snapshot.project.projectId,
      workspace: snapshot.project.workspace,
      epoch: snapshot.epoch,
      activationDigest: snapshot.activationDigest,
      catalogVersion: snapshot.catalogVersion,
      /**
       * Return the already verified projection from this snapshot. Nothing is
       * recompiled and the caller cannot supply a projection of its own.
       */
      execution(checkpoint: 'runtime' | 'ci' | 'server'): ActivationExecutionView {
        if (checkpoint !== 'runtime' && checkpoint !== 'ci' && checkpoint !== 'server') {
          throw new ActivationError();
        }
        const projection = snapshot.enforcement[checkpoint];
        // An empty projection stays explicit. It is never turned into a
        // fabricated ready table (and the engine rejects empty tables).
        return projection;
      },
      /** Advisory only; never falls back to process-global guidance seeds. */
      injectorSession(now: number | (() => number)): ProjectInjectorSession {
        return createProjectInjectorSession(snapshot, now);
      },
    });
  } catch {
    throw new ActivationError();
  }
}
