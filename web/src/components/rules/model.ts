import type { Candidate, RulePredicate, RuleRecord } from '@/types'
import { t } from '@/i18n'

export type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] }
export type DraftRule = Mutable<RuleRecord>
export type DraftCandidate = Mutable<Candidate>
export const operators = ['op_in', 'target_glob', 'target_outside_glob', 'url_query_key_in', 'target_scheme_in', 'target_host_in', 'target_host_not_in'] as const
export type Operator = typeof operators[number]
export function predicate(op: Operator): RulePredicate {
  switch (op) {
    case 'op_in': return { op, args: { operations: [] } }
    case 'target_glob': case 'target_outside_glob': return { op, args: { patterns: [] } }
    case 'url_query_key_in': return { op, args: { keys: [] } }
    case 'target_scheme_in': return { op, args: { schemes: [] } }
    case 'target_host_in': case 'target_host_not_in': return { op, args: { hosts: [] } }
  }
}
export function values(p: RulePredicate): string[] { return Object.values(p.args)[0] ?? [] }
export function newRule(id: string): DraftRule {
  // Start from a schema-valid project rule so "add" never produces a draft
  // that can only be fixed by filling every provenance field by hand.
  return {
    id,
    dimension: 'project',
    level: 1,
    expressivity: 'deterministic',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    narrative: 'Project-specific rule; edit before publishing.',
    on_hit: 'log',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: {
      repo: 'local-project',
      rev: 'v1',
      path: '.pi/amos.json',
      section: 'project rule',
      lines: '1',
      quote: 'Project-authored rule.',
    },
    probe: 'Project-authored rule.',
    policy_class: 'security',
    enforcement: 'runtime',
  }
}
export function clone(candidate: Candidate): DraftCandidate {
  // Reactive proxies cannot be structuredClone'd. Rule records are JSON data.
  return JSON.parse(JSON.stringify(candidate)) as DraftCandidate
}
export function activationIssues(candidate: DraftCandidate): string[] {
  const ids = candidate.rules.map(r => r.id)
  const inc = candidate.activation.includedRuleIds
  const exc = candidate.activation.excludedRuleIds
  const issues: string[] = []
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) issues.push(t('activationIssues.ids'))
  if (inc && (!inc.length || new Set(inc).size !== inc.length)) issues.push(t('activationIssues.included'))
  if (new Set(exc).size !== exc.length) issues.push(t('activationIssues.excluded'))
  if ([...(inc ?? []), ...exc].some(id => !ids.includes(id))) issues.push(t('activationIssues.unknown'))
  if (inc?.some(id => exc.includes(id))) issues.push(t('activationIssues.overlap'))
  if (!ids.some(id => (inc === null || inc.includes(id)) && !exc.includes(id))) issues.push(t('activationIssues.empty'))
  return issues
}
