import type { AdvisoryRule } from './snapshot.ts';

export interface RuleOverrides {
  readonly id: string;
  readonly narrative?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly ttl?: number | null;
  readonly narrativeVersion?: number;
  readonly specificity?: number;
  readonly priority?: number;
  readonly areas?: readonly string[];
  readonly pathHints?: readonly string[];
  readonly taskTags?: readonly string[];
  readonly keywords?: readonly string[];
  readonly tags?: readonly string[];
  readonly pairedRuleId?: string | null;
}

export function rule(overrides: RuleOverrides): Record<string, unknown> {
  return {
    narrative: `Narrative for ${overrides.id}.`,
    source: 'AGENTS.md test',
    owner: 'test-owner',
    ttl: null,
    narrativeVersion: 1,
    specificity: 1,
    priority: 0,
    areas: [],
    pathHints: [],
    taskTags: [],
    keywords: [],
    tags: [],
    pairedRuleId: null,
    ...overrides,
  };
}

export function snapshotInput(options: {
  readonly rules: readonly Record<string, unknown>[];
  readonly baselineRuleIds?: readonly string[];
  readonly routes?: readonly Record<string, unknown>[];
  readonly projectId?: string;
  readonly advisoryDigest?: string;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    policyVersion: '1.0.0',
    engineVersion: '1.0.0',
    projectId: options.projectId ?? 'project-amos',
    baselineRuleIds: options.baselineRuleIds ?? [],
    rules: options.rules,
    routes: options.routes ?? [],
  };
  if (options.advisoryDigest !== undefined) {
    input.advisoryDigest = options.advisoryDigest;
  }
  return input;
}

export function plainRules(rules: readonly { readonly id: string }[]): string[] {
  return rules.map((entry) => entry.id);
}

export type Rule = AdvisoryRule;
