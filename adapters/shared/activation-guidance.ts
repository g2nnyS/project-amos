/**
 * Optional activation-backed advisory guidance for adapters.
 *
 * This is a migration bridge, not a second enforcement path: it only replaces
 * the process-global guidance seed when the user explicitly configures a
 * verified `amos-unified-rule-catalog` v2 snapshot. It never grants execution
 * authority and never changes audit decisions.
 *
 * Failure is fail-closed for *injection*: a configured but invalid snapshot
 * yields an empty advisory session, not a fallback to the global seed. The
 * adapter can still record tool events and apply its separate workflow gate.
 */

import { readFileSync, statSync } from 'node:fs';

import { createActivationRuntime } from '../../activation/runtime.ts';
import { deepFreeze } from '../../activation/json.ts';
import type { ProjectInjectionBlock, ProjectInjectorSession } from '../../activation/injector.ts';
import type {
  InjectionBlock,
  InjectionInput,
  InjectorSession,
  StructuralAction,
} from '../../injector/index.ts';

export const MAX_ACTIVATION_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface ActivationGuidanceOptions {
  readonly snapshotPath: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly now?: () => number;
}

export interface ActivationGuidanceReady {
  readonly status: 'ready';
  createSession(): InjectorSession;
}

export interface ActivationGuidanceError {
  readonly status: 'error';
  readonly code: 'activation_guidance_error';
  /** Empty advisory session; never the global seed. */
  createSession(): InjectorSession;
}

export type ActivationGuidanceLoad = ActivationGuidanceReady | ActivationGuidanceError;

export function loadActivationGuidance(
  options: ActivationGuidanceOptions,
): ActivationGuidanceLoad {
  try {
    if (!isRecord(options)) return errorLoad();
    const snapshotPath = options.snapshotPath;
    const projectId = options.projectId;
    const workspace = options.workspace;
    if (
      typeof snapshotPath !== 'string' ||
      snapshotPath.length === 0 ||
      typeof projectId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId) ||
      typeof workspace !== 'string' ||
      workspace.length === 0
    ) {
      return errorLoad();
    }
    const now = options.now ?? Date.now;
    if (typeof now !== 'function') return errorLoad();

    const stat = statSync(snapshotPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ACTIVATION_SNAPSHOT_BYTES) {
      return errorLoad();
    }
    const raw = readFileSync(snapshotPath, 'utf8');
    if (raw.length === 0) return errorLoad();
    // The runtime verifier requires a deep-frozen snapshot identity. A parsed
    // file is a fresh mutable graph, so freeze the bounded copy first. This is
    // still a structural consistency check, not source authentication.
    const value: unknown = deepFreeze(JSON.parse(raw));
    const runtime = createActivationRuntime(value, { projectId, workspace });
    return Object.freeze({
      status: 'ready' as const,
      createSession(): InjectorSession {
        return wrap(runtime.injectorSession(now));
      },
    });
  } catch {
    return errorLoad();
  }
}

function errorLoad(): ActivationGuidanceError {
  return Object.freeze({
    status: 'error' as const,
    code: 'activation_guidance_error' as const,
    createSession(): InjectorSession {
      return emptySession();
    },
  });
}

function wrap(project: ProjectInjectorSession): InjectorSession {
  return Object.freeze({
    selectPrompt: (prompt: string): InjectionBlock => project.selectPrompt(prompt),
    select: (input: Omit<InjectionInput, 'alreadyInjected'>): InjectionBlock =>
      project.select(input),
    queueAction: (action: StructuralAction, projectDirectory: string): boolean =>
      project.queueAction(action, projectDirectory),
    selectPendingArea: (): InjectionBlock | null => project.selectPendingArea(),
    commit: (block: InjectionBlock): void =>
      project.commit(block as ProjectInjectionBlock),
  });
}

/** A session with no rules, used only for an explicitly configured invalid snapshot. */
export function createEmptyAdvisorySession(): InjectorSession {
  return emptySession();
}

function emptySession(): InjectorSession {
  const block: InjectionBlock = Object.freeze({
    text: '',
    ruleIds: Object.freeze([]),
    droppedRuleIds: Object.freeze([]),
    policyVersion: 'activation-guidance-unavailable',
    advisoryDigest: `sha256:${'0'.repeat(64)}`,
    channel: 'prompt',
    area: null,
    selectedRefs: Object.freeze([]),
    omittedRefs: Object.freeze([]),
    incomplete: false,
    fallbackReason: null,
  });
  return Object.freeze({
    selectPrompt: () => block,
    select: () => block,
    queueAction: () => false,
    selectPendingArea: () => null,
    commit: () => undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
