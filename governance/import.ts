/**
 * One-way import of the existing configuration sources into a candidate.
 *
 * Preview is full-equivalence: every YAML rule, every guidance seed, and every
 * mapped non-secret setting is represented. Nothing is defaulted, dropped, or
 * silently merged. Import never writes the database; the caller must create a
 * proposal, approve it, and publish it.
 */

import { Ajv } from 'ajv';
import { parse as parseYaml } from 'yaml';
import { assertValidTable } from '../engine/engine.ts';
import { canonicalJson, deepFreeze, digest } from '../activation/json.ts';
import {
  GUIDANCE_RULE_MIGRATION,
} from '../catalog/migration-map.ts';
import { validateGuidanceMigrationMap } from '../catalog/migration.ts';
import type { GuidancePack } from '../guidance/types.ts';
import {
  digestCandidate,
  isSecretReference,
  secretReferenceName,
  type CandidateRecord,
  type RuleRecord,
  type SettingEntry,
} from './contracts.ts';
import { fail } from './errors.ts';

export interface ImportSources {
  readonly rulesYaml: string;
  readonly ruleSchema: string;
  readonly guidance: readonly GuidancePack[];
  readonly piConfig?: unknown;
  readonly opencodeOptions?: unknown;
  readonly jevConfig?: unknown;
}

export interface ImportCurrentState {
  readonly ruleDigests?: Readonly<Record<string, string>>;
  readonly guidanceDigests?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface ImportIssue {
  readonly code: string;
  readonly path: string;
}

export interface ImportPreview {
  readonly ok: boolean;
  readonly schemaDigest: string;
  readonly rules: {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  };
  readonly guidance: {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  };
  readonly settings: readonly { readonly key: string; readonly changed: boolean }[];
  readonly issues: readonly ImportIssue[];
  readonly candidateDigest: string;
}

interface Analysis {
  readonly preview: ImportPreview;
  readonly candidate: CandidateRecord;
}

const SECRET_FIELD = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|auth[_-]?token|secret|password|passwd|credential|credentials|authorization)$/i;

export function previewImport(
  sources: ImportSources,
  current?: ImportCurrentState,
): ImportPreview {
  return analyze(sources, current).preview;
}

/**
 * Produce the exact candidate object whose digest preview reported. Apply via
 * `store.createProposal({ candidate })`; this function never writes.
 */
export function buildImportCandidate(sources: ImportSources): CandidateRecord {
  const analysis = analyze(sources, undefined);
  if (!analysis.preview.ok) fail('import_invalid');
  return analysis.candidate;
}

function analyze(sources: ImportSources, current?: ImportCurrentState): Analysis {
  const issues: ImportIssue[] = [];
  const source = readRecord(sources, ['rulesYaml', 'ruleSchema', 'guidance', 'piConfig', 'opencodeOptions', 'jevConfig']);
  if (source === null) {
    const candidate = emptyCandidate();
    return {
      candidate,
      preview: previewOf(candidate, issues, current, [], new Map()),
    };
  }

  const rulesYaml = typeof source.rulesYaml === 'string' ? source.rulesYaml : '';
  const ruleSchema = typeof source.ruleSchema === 'string' ? source.ruleSchema : '';
  if (rulesYaml.length === 0) issues.push({ code: 'invalid_yaml', path: 'rulesYaml' });
  if (ruleSchema.length === 0) issues.push({ code: 'invalid_schema', path: 'ruleSchema' });

  let rules: readonly RuleRecord[] = [];
  if (rulesYaml.length > 0 && ruleSchema.length > 0) {
    rules = parseRules(rulesYaml, ruleSchema, issues);
  }

  const packs = Array.isArray(source.guidance)
    ? (source.guidance as readonly GuidancePack[])
    : [];
  if (!Array.isArray(source.guidance) || packs.length === 0) {
    issues.push({ code: 'invalid_guidance', path: 'guidance' });
  }
  const guidanceIds = validateGuidance(packs, new Set(rules.map((rule) => rule.id)), issues);
  const guidanceRefs = packs.map((pack) => deepFreeze({
    id: pack.id,
    version: pack.version,
    area: pack.area,
    digest: digest('amos-governance-guidance-v1', pack),
  }));

  const settings = collectSettings(source, issues);
  const seedDigests = new Map<string, string>();
  for (const pack of packs) {
    for (const seed of pack.rules) {
      seedDigests.set(
        seed.id,
        digest('amos-governance-guidance-seed-v1', {
          packId: pack.id,
          packVersion: pack.version,
          area: pack.area,
          seed,
        }),
      );
    }
  }

  const candidate = deepFreeze({
    type: 'rules',
    rules,
    guidance: guidanceRefs,
    settings,
    schemaDigest: ruleSchema.length === 0
      ? digest('amos-governance-rule-schema-v1', '')
      : digest('amos-governance-rule-schema-v1', ruleSchema),
    activation: {
      selectedRuleRefs: [
        ...rules.map((rule) => ({ id: rule.id, version: 1 })),
        ...guidanceIds.map((id) => ({ id, version: 1 })),
      ],
      excludedRuleIds: [],
      advisoryBaselineRuleIds: guidanceIds,
      routes: [],
    },
  }) as CandidateRecord;

  return {
    candidate,
    preview: previewOf(candidate, issues, current, rules, seedDigests),
  };
}

function previewOf(
  candidate: CandidateRecord,
  issues: readonly ImportIssue[],
  current: ImportCurrentState | undefined,
  rules: readonly RuleRecord[],
  guidanceDigests: ReadonlyMap<string, string>,
): ImportPreview {
  const ruleDigests = new Map<string, string>();
  for (const rule of rules) ruleDigests.set(rule.id, digest('amos-governance-rule-v1', rule));
  const settings = candidate.settings ?? [];

  return deepFreeze({
    ok: issues.length === 0 && rules.length > 0 && guidanceDigests.size > 0,
    schemaDigest: typeof candidate.schemaDigest === 'string' ? candidate.schemaDigest : '',
    rules: diff(ruleDigests, current?.ruleDigests),
    guidance: diff(guidanceDigests, current?.guidanceDigests),
    settings: settings.map((entry) => ({
      key: entry.key,
      changed: changedSetting(entry, current?.settings),
    })),
    issues: [...issues],
    candidateDigest: digestCandidate(candidate),
  });
}

function parseRules(
  rulesYaml: string,
  ruleSchema: string,
  issues: ImportIssue[],
): readonly RuleRecord[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(rulesYaml);
  } catch {
    issues.push({ code: 'invalid_yaml', path: 'rulesYaml' });
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    issues.push({ code: 'invalid_yaml', path: 'rulesYaml' });
    return [];
  }

  const startIssues = issues.length;
  let validate: ((value: unknown) => boolean) & { errors?: unknown };
  try {
    const schema: unknown = JSON.parse(ruleSchema);
    validate = new Ajv({ allErrors: true, strict: false }).compile(schema as never) as typeof validate;
  } catch {
    issues.push({ code: 'invalid_schema', path: 'ruleSchema' });
    return [];
  }

  let valid = true;
  if (!validate(parsed)) {
    valid = false;
    const errors = Array.isArray(validate.errors) ? validate.errors : [];
    for (const raw of errors.slice(0, 64)) {
      const error = raw as { instancePath?: unknown; keyword?: unknown };
      const instancePath = typeof error.instancePath === 'string' ? error.instancePath : '';
      const keyword = typeof error.keyword === 'string' ? error.keyword : '';
      const path = instancePath.length === 0 ? 'rules' : instancePath;
      if (path.includes('/predicate')) {
        issues.push({ code: 'invalid_predicate', path });
      } else if (keyword === 'additionalProperties' || keyword === 'required') {
        issues.push({ code: 'unknown_field', path });
      } else {
        issues.push({ code: 'invalid_rule', path });
      }
    }
  }

  try {
    assertValidTable(parsed);
  } catch {
    valid = false;
    issues.push({ code: 'invalid_rule', path: 'rules' });
  }

  const seen = new Set<string>();
  parsed.forEach((value, index) => {
    const id = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).id
      : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) issues.push({ code: 'duplicate_id', path: `/rules/${index}/id` });
      seen.add(id);
    }
  });

  if (!valid || issues.length !== startIssues) return [];
  return deepFreeze(parsed as RuleRecord[]);
}

function validateGuidance(
  packs: readonly GuidancePack[],
  ruleIds: ReadonlySet<string>,
  issues: ImportIssue[],
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let valid = true;
  for (const [index, pack] of packs.entries()) {
    if (pack === null || typeof pack !== 'object') {
      issues.push({ code: 'invalid_guidance', path: `/guidance/${index}` });
      valid = false;
      continue;
    }
    const record = pack as unknown as Record<string, unknown>;
    const packKeys = ['id', 'version', 'area', 'title', 'summary', 'rules', 'keywords', 'pathHints'];
    if (Object.keys(record).length !== packKeys.length || packKeys.some((key) => !Object.hasOwn(record, key))) {
      issues.push({ code: 'unknown_field', path: `/guidance/${index}` });
      valid = false;
      continue;
    }
    if (
      typeof record.id !== 'string' || record.id.trim().length === 0 ||
      typeof record.version !== 'string' || record.version.trim().length === 0 ||
      typeof record.area !== 'string' || record.area.trim().length === 0 ||
      typeof record.title !== 'string' || typeof record.summary !== 'string' ||
      !Array.isArray(record.rules) || !Array.isArray(record.keywords) || !Array.isArray(record.pathHints)
    ) {
      issues.push({ code: 'invalid_guidance', path: `/guidance/${index}` });
      valid = false;
      continue;
    }
    for (const [ruleIndex, seed] of record.rules.entries()) {
      if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
        issues.push({ code: 'invalid_guidance', path: `/guidance/${index}/rules/${ruleIndex}` });
        valid = false;
        continue;
      }
      const seedRecord = seed as Record<string, unknown>;
      const seedKeys = ['id', 'text', 'source'];
      if (Object.keys(seedRecord).length !== seedKeys.length ||
        seedKeys.some((key) => !Object.hasOwn(seedRecord, key))) {
        issues.push({ code: 'unknown_field', path: `/guidance/${index}/rules/${ruleIndex}` });
        valid = false;
        continue;
      }
      const id = seedRecord.id;
      if (typeof id !== 'string' || id.trim().length === 0 || ruleIds.has(id) || seen.has(id)) {
        issues.push({ code: 'duplicate_id', path: `/guidance/${index}/rules/${ruleIndex}/id` });
        valid = false;
        continue;
      }
      if (typeof seedRecord.text !== 'string' || seedRecord.text.trim().length === 0 ||
        typeof seedRecord.source !== 'string' || seedRecord.source.trim().length === 0) {
        issues.push({ code: 'invalid_guidance', path: `/guidance/${index}/rules/${ruleIndex}` });
        valid = false;
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
  }
  if (valid) {
    try {
      validateGuidanceMigrationMap(packs, GUIDANCE_RULE_MIGRATION, new Set(ruleIds));
    } catch {
      issues.push({ code: 'invalid_guidance', path: 'guidance' });
      valid = false;
    }
  }
  return valid ? ids : [];
}

function collectSettings(source: Record<string, unknown>, issues: ImportIssue[]): readonly SettingEntry[] {
  const entries = new Map<string, SettingEntry>();
  const configs: readonly [string, unknown][] = [
    ['pi', source.piConfig],
    ['opencode', source.opencodeOptions],
    ['jev', source.jevConfig],
  ];
  for (const [prefix, config] of configs) {
    if (config === undefined) continue;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      issues.push({ code: 'invalid_config', path: prefix });
      continue;
    }
    flatten(config, prefix, entries, issues, 0);
  }
  return deepFreeze([...entries.values()].sort((left, right) => left.key.localeCompare(right.key)));
}

function flatten(
  value: unknown,
  prefix: string,
  entries: Map<string, SettingEntry>,
  issues: ImportIssue[],
  depth: number,
): void {
  if (depth > 32) {
    issues.push({ code: 'invalid_config', path: prefix });
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ code: 'invalid_config', path: prefix });
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = `${prefix}.${key}`;
    const leaf = key;
    if (SECRET_FIELD.test(leaf)) {
      if (entry === null || entry === undefined || entry === '') {
        entries.set(path, deepFreeze({ key: path, value: entry ?? null }));
        continue;
      }
      if (typeof entry !== 'string' || !isSecretReference(entry)) {
        issues.push({ code: 'secret_literal', path });
        continue;
      }
      const name = secretReferenceName(entry);
      if (name === null) {
        issues.push({ code: 'secret_literal', path });
        continue;
      }
      // Only the reference is retained; the literal never enters a candidate.
      entries.set(path, deepFreeze({ key: path, value: `{env:${name}}` }));
      continue;
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      flatten(entry, path, entries, issues, depth + 1);
      continue;
    }
    if (!isJsonValue(entry)) {
      issues.push({ code: 'invalid_config', path });
      continue;
    }
    entries.set(path, deepFreeze({ key: path, value: cloneJson(entry) }));
  }
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value));
}

function diff(
  next: ReadonlyMap<string, string>,
  current: Readonly<Record<string, string>> | undefined,
): { added: string[]; changed: string[]; removed: string[] } {
  const previous = current ?? {};
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, value] of next) {
    if (!Object.hasOwn(previous, id)) added.push(id);
    else if (previous[id] !== value) changed.push(id);
  }
  const removed = Object.keys(previous).filter((id) => !next.has(id)).sort();
  return { added: added.sort(), changed: changed.sort(), removed };
}

function changedSetting(
  entry: SettingEntry,
  current: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (current === undefined || !Object.hasOwn(current, entry.key)) return true;
  try {
    return canonicalJson(current[entry.key]) !== canonicalJson(entry.value);
  } catch {
    return true;
  }
}

function readRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) return null;
  }
  return record;
}

function emptyCandidate(): CandidateRecord {
  return deepFreeze({
    type: 'rules',
    rules: [],
    guidance: [],
    settings: [],
    schemaDigest: digest('amos-governance-rule-schema-v1', ''),
    activation: {
      selectedRuleRefs: [],
      excludedRuleIds: [],
      advisoryBaselineRuleIds: [],
      routes: [],
    },
  }) as CandidateRecord;
}
