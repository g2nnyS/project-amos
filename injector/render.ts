/**
 * Pure advisory block renderer.
 *
 * The renderer sees snapshot metadata and selected rule text only. It never
 * receives the prompt, an action target, command text, area names, path hints,
 * or file contents, so it cannot echo them. Bounds are whole-block character
 * counts: a rule that does not fit is dropped entirely and reported by id.
 */

import type { AdvisoryRule, AdvisorySnapshot } from './snapshot.ts';

export const DEFAULT_MAX_RULES_PER_BLOCK = 6;
export const DEFAULT_MAX_CHARACTERS = 1_800;

const WARNING =
  'Conventions are advisory, not permissions. The gate decides every action.';
const MAX_RULE_TEXT_CHARACTERS = 8_192;

export interface RenderAdvisoryBlockInput {
  readonly snapshot: AdvisorySnapshot;
  readonly rules: readonly AdvisoryRule[];
  readonly maxRulesPerBlock?: number;
  readonly maxCharacters?: number;
}

export interface RenderedAdvisoryBlock {
  readonly text: string;
  readonly ruleIds: readonly string[];
  readonly droppedRuleIds: readonly string[];
}

/**
 * Render one independent `<amos-guidance>` block. The block is self-contained
 * so a harness can attach it without trusting surrounding markup.
 */
export function renderAdvisoryBlock(
  input: RenderAdvisoryBlockInput,
): RenderedAdvisoryBlock {
  const snapshot = input.snapshot;
  const maxRules = boundInteger(
    input.maxRulesPerBlock,
    DEFAULT_MAX_RULES_PER_BLOCK,
    0,
    64,
  );
  const maxCharacters = boundInteger(
    input.maxCharacters,
    DEFAULT_MAX_CHARACTERS,
    0,
    1_000_000,
  );

  const snapshotById = new Map(
    snapshot.rules.map((rule) => [rule.id, rule] as const),
  );
  const unique: AdvisoryRule[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(input.rules) ? input.rules : []) {
    const id = candidate !== null && typeof candidate === 'object' ? candidate.id : '';
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      dropped.push(id);
      continue;
    }
    seen.add(id);
    const canonical = snapshotById.get(id);
    if (canonical === undefined) {
      dropped.push(id);
      continue;
    }
    unique.push(canonical);
  }

  // Preserve the caller's order. Selection already returns score-ordered
  // candidates, so re-sorting here would silently discard that ranking and
  // change which rules survive a bounded block.
  const prefix = `<amos-guidance policy="${escapeXml(snapshot.policyVersion)}" digest="${escapeXml(snapshot.advisoryDigest)}" mode="advisory">\n`;
  const suffix = '\n</amos-guidance>';
  const base = `${prefix}${WARNING}${suffix}`;

  if (maxCharacters < base.length) {
    for (const rule of unique) {
      dropped.push(rule.id);
    }
    return Object.freeze({
      text: '',
      ruleIds: Object.freeze([]),
      droppedRuleIds: Object.freeze(dropped),
    });
  }

  const lines: string[] = [];
  const included: string[] = [];
  for (const rule of unique) {
    if (included.length >= maxRules) {
      dropped.push(rule.id);
      continue;
    }
    const line = renderRule(rule);
    if (line.length === 0) {
      dropped.push(rule.id);
      continue;
    }
    const candidate = `${prefix}${WARNING}\n${[...lines, line].join('\n')}${suffix}`;
    if (candidate.length > maxCharacters) {
      dropped.push(rule.id);
      continue;
    }
    lines.push(line);
    included.push(rule.id);
  }

  const text =
    lines.length === 0
      ? base
      : `${prefix}${WARNING}\n${lines.join('\n')}${suffix}`;

  return Object.freeze({
    text,
    ruleIds: Object.freeze([...included]),
    droppedRuleIds: Object.freeze([...dropped]),
  });
}

function renderRule(rule: AdvisoryRule): string {
  const id = escapeXml(clean(rule.id));
  const narrative = escapeXml(clean(rule.narrative));
  const source = escapeXml(clean(rule.source));
  if (id.length === 0 || narrative.length === 0) {
    return '';
  }
  return `- [${id}] ${narrative} (${source})`;
}

function clean(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .slice(0, MAX_RULE_TEXT_CHARACTERS)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function boundInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
