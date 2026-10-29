/**
 * In-memory advisory injection session.
 *
 * A session owns deduplication and budgets only. It performs no I/O, calls no
 * model, and does not decide whether the adapter actually showed a block:
 * `commit` must be called by the adapter only after successful emission.
 * Process-restart reconstruction from audit records is future work.
 */

import { renderAdvisoryBlock } from './render.ts';
import { matchesPathHint, selectAdvisoryRules } from './select.ts';
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
}

export interface InjectorSession {
  selectPrompt(prompt: string): InjectionBlock;
  /** Returns true only when a write/edit target queued at least one area. */
  queueAction(action: StructuralAction, projectDirectory: string): boolean;
  selectPendingArea(): InjectionBlock | null;
  commit(block: InjectionBlock): void;
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

export function createInjectorSession(snapshot: AdvisorySnapshot): InjectorSession {
  const injectedRuleIds = new Set<string>();
  const injectedAreas = new Set<string>();
  const pendingAreas = new Map<string, PendingArea>();
  const pendingBlocks = new Map<string, InjectionBlock>();
  const blockRecords = new WeakMap<InjectionBlock, BlockRecord>();
  let totalCharacters = 0;

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
    });
    blockRecords.set(block, { channel, area, committed: false });
    return block;
  };

  return {
    selectPrompt(prompt: string): InjectionBlock {
      const input: InjectionInput = {
        prompt: typeof prompt === 'string' ? prompt : '',
        alreadyInjected: [...injectedRuleIds],
      };
      const selection = selectAdvisoryRules(snapshot, input);
      const budget = selection.usedFallback
        ? PROMPT_FALLBACK_CHARACTERS
        : PROMPT_CHARACTERS;
      return makeBlock('prompt', null, selection, budget);
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
      const derived = deriveAreas(snapshot, target);
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
        const cached = pendingBlocks.get(key);
        if (cached !== undefined) {
          return cached;
        }
        const selection = selectAdvisoryRules(snapshot, {
          areas: [pending.area],
          paths: [...pending.paths],
          alreadyInjected: [...injectedRuleIds],
        });
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
