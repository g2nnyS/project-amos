/** Localized labels for closed server enums; unknown values are shown verbatim. */
import zhCN from './zh-CN.js'
import { t } from './index.js'

type ProposalStatusKey = keyof typeof zhCN.proposalStatus
type AuditEventKey = keyof typeof zhCN.auditEvents

export const proposalStatuses = Object.keys(zhCN.proposalStatus) as ProposalStatusKey[]

export function proposalStatusLabel(status: string): string {
  return Object.hasOwn(zhCN.proposalStatus, status) ? t(`proposalStatus.${status as ProposalStatusKey}`) : status
}

export function auditEventLabel(kind: string): string {
  return Object.hasOwn(zhCN.auditEvents, kind) ? t(`auditEvents.${kind as AuditEventKey}`) : kind
}

export function roleLabel(role: string | undefined): string {
  if (role === 'human') return t('roles.human')
  if (role === 'agent') return t('roles.agent')
  return t('roles.authenticated')
}
