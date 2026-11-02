import type { Candidate, RulePredicate, RuleRecord } from '@/types'

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
  return { id, dimension: '', level: 0, expressivity: 'deterministic', predicate: [predicate('op_in')], narrative: '', on_hit: 'log', scope: 'project', ttl: null, owner: 'human', source: { repo: '', rev: '', path: '', section: '', lines: '', quote: '' }, probe: '', policy_class: 'security', enforcement: 'runtime' }
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
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) issues.push('规则 ID 必须非空且唯一，候选至少包含一条规则。')
  if (inc && (!inc.length || new Set(inc).size !== inc.length)) issues.push('显式包含列表必须非空且不能重复。')
  if (new Set(exc).size !== exc.length) issues.push('排除列表不能重复。')
  if ([...(inc ?? []), ...exc].some(id => !ids.includes(id))) issues.push('激活列表只能引用候选中的规则 ID。')
  if (inc?.some(id => exc.includes(id))) issues.push('包含与排除列表不能重叠。')
  if (!ids.some(id => (inc === null || inc.includes(id)) && !exc.includes(id))) issues.push('激活结果至少需要一条规则。')
  return issues
}
