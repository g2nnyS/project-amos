/**
 * Deterministic guidance rendering.
 *
 * Rendering is a pure string transform over static pack metadata. It has no
 * access to the prompt, target paths, environment, model output, or policy
 * decisions, so it cannot echo caller text. Output is byte-bounded so a broken
 * or hostile pack list cannot inflate the pre-run context.
 */

import type { GuidancePack } from './types.ts';

/** Hard upper bound for rendered guidance, in UTF-8 bytes. */
export const GUIDANCE_RENDER_LIMIT_BYTES = 8 * 1024;

const TRUNCATION_MARKER = '\n[guidance truncated at the 8 KiB limit]\n';

const HEADER = [
  '# Engineering guidance (versioned, in-repo)',
  '',
  'Advisory pre-run guidance. It is not a security verdict, approval, capability, or enforcement mechanism; the deterministic engine remains authoritative.',
  '',
].join('\n') + '\n';

const MAX_RULES_PER_PACK = 8;
const MAX_TEXT_CHARACTERS = 320;
const MAX_ID_CHARACTERS = 64;
const MAX_TITLE_CHARACTERS = 120;
const MAX_SUMMARY_CHARACTERS = 240;

export function renderGuidance(packs: readonly GuidancePack[]): string {
  const budget = GUIDANCE_RENDER_LIMIT_BYTES - byteLength(TRUNCATION_MARKER);
  const seen = new Set<string>();

  let output = HEADER;
  let truncated = false;

  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!isRecord(pack)) {
      continue;
    }
    const block = renderPack(pack, seen);
    if (block === undefined) {
      continue;
    }
    if (byteLength(output + block) > budget) {
      truncated = true;
      break;
    }
    output += block;
  }

  if (truncated) {
    output += TRUNCATION_MARKER;
  }

  return output;
}

function renderPack(
  pack: Record<string, unknown>,
  seen: Set<string>,
): string | undefined {
  const id = clean(pack.id, MAX_ID_CHARACTERS);
  const version = clean(pack.version, MAX_ID_CHARACTERS);
  if (id.length === 0 || version.length === 0 || seen.has(id)) {
    return undefined;
  }
  seen.add(id);

  const title = clean(pack.title, MAX_TITLE_CHARACTERS) || id;
  const summary = clean(pack.summary, MAX_SUMMARY_CHARACTERS);
  const area = clean(pack.area, MAX_ID_CHARACTERS) || 'unknown';
  const rules = Array.isArray(pack.rules) ? pack.rules : [];

  const lines = [
    `## ${title} [${id} v${version}]`,
    `area: ${area}`,
  ];
  if (summary.length > 0) {
    lines.push(summary);
  }

  let renderedRules = 0;
  for (const rule of rules) {
    if (renderedRules >= MAX_RULES_PER_PACK) {
      break;
    }
    const rendered = renderRule(rule);
    if (rendered === undefined) {
      continue;
    }
    lines.push(rendered);
    renderedRules += 1;
  }

  return `${lines.join('\n')}\n\n`;
}

function renderRule(rule: unknown): string | undefined {
  if (!isRecord(rule)) {
    return undefined;
  }
  const text = clean(rule.text, MAX_TEXT_CHARACTERS);
  if (text.length === 0) {
    return undefined;
  }
  const id = clean(rule.id, MAX_ID_CHARACTERS);
  const source = clean(rule.source, MAX_TITLE_CHARACTERS);

  const attribution = [id, source].filter((value) => value.length > 0).join('; ');
  return attribution.length === 0 ? `- ${text}` : `- ${text} [${attribution}]`;
}

/** Collapse whitespace and control characters; bound before and after cleaning. */
function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .slice(0, MAX_TEXT_CHARACTERS * 8)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
