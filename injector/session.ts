/**
 * In-memory advisory injection session.
 *
 * A session owns deduplication and budgets only. It performs no I/O, calls no
 * model, and does not decide whether the adapter actually showed a block:
 * `commit` must be called by the adapter only after successful emission.
 * Process-restart reconstruction from audit records is future work.
 */

import { renderAdvisoryBlock } from './render.ts';
import { matchesPathHint, selectAdvisoryRules, selectAllActiveAdvisoryRules } from './select.ts';
import type {
  AdvisorySnapshot,
  InjectionChannel,
  InjectionInput,
} from './snapshot.ts';

export const SESSION_TOTAL_CHARACTERS = 6_000;
export const PROMPT_CHARACTERS = 1_800;
export const PROMPT_FALLBACK_CHARACTERS = 1_200;
export const AREA_CHARACTERS = 900;
export const MAX_RULES_PER_BLOCK = 6;

const WRITE_TOOLS = new Set(['write', 'edit', 'file_write']);
const MAX_ACTION_PATH_CHARACTERS = 4_096;

export interface StructuralAction {
  readonly tool: string;
  readonly operation: string;
  readonly target: string;
}

export interface InjectionBlock {
  readonly text: string;
  readonly ruleIds: readonly string[];
  readonly droppedRuleIds: readonly string[];
  readonly policyVersion: string;
  readonly advisoryDigest: string;
  readonly channel: InjectionChannel;
  readonly area: string | null;
  readonly selectedRefs: readonly { readonly id: string; readonly version: number }[];
  readonly omittedRefs: readonly { readonly id: string; readonly version: number }[];
  readonly incomplete: boolean;
  readonly fallbackReason: 'no_signal_match' | 'routing_error' | null;
}

export interface InjectorSession {
  selectPrompt(prompt: string): InjectionBlock;
  /** Select from active project narratives using bounded structured signals. */
  select(input: Omit<InjectionInput, 'alreadyInjected'>): InjectionBlock;
  /** Returns true only when a write/edit target queued at least one area. */
  queueAction(action: StructuralAction, projectDirectory: string): boolean;
  selectPendingArea(): InjectionBlock | null;
  commit(block: InjectionBlock): void;
}

export interface InjectorSessionOptions {
  /** Optional trusted clock for per-selection advisory TTL filtering. */
  readonly now?: () => number;
  /** Already sampled creation time, when the caller sampled the same clock. */
  readonly initialNow?: number;
}

interface PendingArea {
  readonly area: string;
  readonly paths: Set<string>;
}

interface BlockRecord {
  readonly channel: InjectionChannel;
  readonly area: string | null;
  committed: boolean;
}

/**
 * Create one deduplicating/budgeted session. When `options.now` is provided,
 * each new selection filters expired guidance; clock failure/rollback makes
 * advisory unavailable for the remainder of this process-local session.
 */
export function createInjectorSession(
  snapshot: AdvisorySnapshot,
  options: InjectorSessionOptions = {},
): InjectorSession {
  const injectedRuleIds = new Set<string>();
  const injectedAreas = new Set<string>();
  const pendingAreas = new Map<string, PendingArea>();
  const pendingBlocks = new Map<string, InjectionBlock>();
  const blockRecords = new WeakMap<InjectionBlock, BlockRecord>();
  let totalCharacters = 0;
  let lastObservedTime: number | null = options.initialNow ?? null;
  let clockInvalidated = lastObservedTime !== null && !Number.isFinite(lastObservedTime);

  const activeSnapshot = (): AdvisorySnapshot => {
    if (options.now === undefined) return snapshot;
    try {
      const now = options.now();
      if (!Number.isFinite(now) || (lastObservedTime !== null && now < lastObservedTime)) {
        clockInvalidated = true;
      } else {
        lastObservedTime = now;
      }
    } catch {
      clockInvalidated = true;
    }
    const rules = clockInvalidated
      ? []
      : snapshot.rules.filter((rule) => rule.ttl === null || lastObservedTime! < rule.ttl);
    const activeIds = new Set(rules.map(({ id }) => id));
    return {
      ...snapshot,
      rules,
      baselineRuleIds: snapshot.baselineRuleIds.filter((id) => activeIds.has(id)),
    };
  };
  if (options.now !== undefined && options.initialNow === undefined) activeSnapshot();

  const makeBlock = (
    channel: InjectionChannel,
    area: string | null,
    selection: ReturnType<typeof selectAdvisoryRules>,
    budget: number,
  ): InjectionBlock => {
    const remaining = Math.max(0, SESSION_TOTAL_CHARACTERS - totalCharacters);
    const allowed = Math.min(budget, remaining);
    const rendered =
      selection.selected.length === 0
        ? { text: '', ruleIds: [], droppedRuleIds: [] }
        : renderAdvisoryBlock({
            snapshot,
            rules: selection.selected,
            maxRulesPerBlock: MAX_RULES_PER_BLOCK,
            maxCharacters: allowed,
          });

    const block: InjectionBlock = Object.freeze({
      // No rule means no advisory block at all. A warning wrapper with no
      // rules would consume the session budget without carrying guidance.
      text: rendered.ruleIds.length === 0 ? '' : rendered.text,
      ruleIds: Object.freeze([...rendered.ruleIds]),
      droppedRuleIds: Object.freeze([...rendered.droppedRuleIds]),
      policyVersion: snapshot.policyVersion,
      advisoryDigest: snapshot.advisoryDigest,
      channel,
      area,
      selectedRefs: Object.freeze(rendered.ruleIds.flatMap((id) => {
        const rule = snapshot.rules.find((candidate) => candidate.id === id);
        return rule === undefined ? [] : [{ id, version: rule.ruleVersion }];
      })),
      omittedRefs: Object.freeze(rendered.droppedRuleIds.flatMap((id) => {
        const rule = snapshot.rules.find((candidate) => candidate.id === id);
        return rule === undefined ? [] : [{ id, version: rule.ruleVersion }];
      })),
      incomplete: rendered.droppedRuleIds.length > 0,
      fallbackReason: selection.fallbackReason,
    });
    blockRecords.set(block, { channel, area, committed: false });
    return block;
  };

  const selectSignals = (input: Omit<InjectionInput, 'alreadyInjected'>): InjectionBlock => {
    const current = activeSnapshot();
    let selection: ReturnType<typeof selectAdvisoryRules>;
    try {
      const boundedInput: InjectionInput = {
        ...input,
        alreadyInjected: [...injectedRuleIds],
      };
      selection = selectAdvisoryRules(current, boundedInput);
    } catch {
      // Do not let a malformed signal payload make the fallback fail too. The
      // fallback needs only the session's trusted deduplication state.
      selection = selectAllActiveAdvisoryRules(
        current,
        { alreadyInjected: [...injectedRuleIds] },
        'routing_error',
      );
    }
    const budget = selection.usedFallback
      ? PROMPT_FALLBACK_CHARACTERS
      : PROMPT_CHARACTERS;
    return makeBlock('prompt', null, selection, budget);
  };

  return {
    selectPrompt(prompt: string): InjectionBlock {
      return selectSignals({ prompt: typeof prompt === 'string' ? prompt : '' });
    },

    select(input: Omit<InjectionInput, 'alreadyInjected'>): InjectionBlock {
      return selectSignals(input);
    },

    queueAction(action: StructuralAction, projectDirectory: string): boolean {
      if (!isWriteAction(action)) {
        return false;
      }
      const project = canonicalizeAbsolutePath(projectDirectory);
      const target = canonicalizeAbsolutePath(action.target);
      if (project === null || target === null) {
        return false;
      }
      if (!isInsideProject(project, target)) {
        return false;
      }

      // Areas come only from the active snapshot and the lexical target. Any
      // event-supplied area is ignored by construction of StructuralAction.
      const derived = deriveAreas(activeSnapshot(), target);
      let queued = false;
      for (const area of derived) {
        const key = area.toLowerCase();
        if (injectedAreas.has(key)) {
          continue;
        }
        const existing = pendingAreas.get(key);
        if (existing === undefined) {
          pendingAreas.set(key, { area, paths: new Set([target]) });
        } else {
          existing.paths.add(target);
          pendingBlocks.delete(key);
        }
        queued = true;
      }
      return queued;
    },

    selectPendingArea(): InjectionBlock | null {
      for (const [key, pending] of pendingAreas) {
        if (injectedAreas.has(key)) {
          pendingAreas.delete(key);
          pendingBlocks.delete(key);
          continue;
        }
        const current = activeSnapshot();
        const cached = pendingBlocks.get(key);
        if (cached !== undefined) {
          const live = new Set(current.rules.map(({ id, ruleVersion }) => `${id}\0${ruleVersion}`));
          if (cached.selectedRefs.every(({ id, version }) => live.has(`${id}\0${version}`))) return cached;
          pendingBlocks.delete(key);
        }
        const input = {
          areas: [pending.area],
          paths: [...pending.paths],
          alreadyInjected: [...injectedRuleIds],
        };
        let selection: ReturnType<typeof selectAdvisoryRules>;
        try {
          selection = selectAdvisoryRules(current, input);
        } catch {
          selection = selectAllActiveAdvisoryRules(
            current,
            { alreadyInjected: [...injectedRuleIds] },
            'routing_error',
          );
        }
        const block = makeBlock('area', pending.area, selection, AREA_CHARACTERS);
        pendingBlocks.set(key, block);
        return block;
      }
      return null;
    },

    commit(block: InjectionBlock): void {
      const record = blockRecords.get(block);
      if (record === undefined || record.committed) {
        return;
      }
      const activeIds = new Set(activeSnapshot().rules.map(({ id }) => id));
      if (block.ruleIds.some((id) => !activeIds.has(id))) return;
      record.committed = true;

      for (const id of block.ruleIds) {
        injectedRuleIds.add(id);
      }
      totalCharacters = Math.min(
        SESSION_TOTAL_CHARACTERS,
        totalCharacters + block.text.length,
      );

      if (record.channel === 'area' && record.area !== null) {
        const key = record.area.toLowerCase();
        injectedAreas.add(key);
        pendingAreas.delete(key);
        pendingBlocks.delete(key);
      }

      // A committed prompt may have consumed rules cached in an uncommitted
      // area block. Recompute those blocks on the next selection.
      pendingBlocks.clear();
    },
  };
}

function isWriteAction(action: unknown): action is StructuralAction {
  if (!isRecord(action)) {
    return false;
  }
  const tool = action.tool;
  const operation = action.operation;
  const target = action.target;
  return (
    typeof tool === 'string' &&
    typeof operation === 'string' &&
    typeof target === 'string' &&
    WRITE_TOOLS.has(tool.toLowerCase()) &&
    WRITE_TOOLS.has(operation.toLowerCase())
  );
}

function deriveAreas(snapshot: AdvisorySnapshot, target: string): string[] {
  const canonicalAreas = new Map<string, string>();
  for (const rule of snapshot.rules) {
    for (const area of rule.areas) {
      const key = area.toLowerCase();
      if (!canonicalAreas.has(key)) {
        canonicalAreas.set(key, area);
      }
    }
  }

  const derived = new Map<string, string>();
  for (const rule of snapshot.rules) {
    if (rule.pathHints.some((hint) => matchesPathHint(target, hint))) {
      for (const area of rule.areas) {
        derived.set(area.toLowerCase(), area);
      }
    }
  }

  // A path segment equal to an active area name is also a safe signal: both
  // values come from the snapshot or lexical target, never from the event.
  for (const segment of target.toLowerCase().split('/')) {
    const area = canonicalAreas.get(segment);
    if (area !== undefined) {
      derived.set(segment, area);
    }
  }

  return [...derived.values()];
}

/**
 * Lexical POSIX normalization. This is not realpath and gives no symlink,
 * hard-link, bind-mount, or TOCTOU guarantee.
 */
function canonicalizeAbsolutePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACTION_PATH_CHARACTERS ||
    value.includes('\0')
  ) {
    return null;
  }
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function isInsideProject(project: string, target: string): boolean {
  if (project === '/') {
    return target.startsWith('/');
  }
  return target === project || target.startsWith(`${project}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
