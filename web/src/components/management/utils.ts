import type { Goal, Report, TeamMember } from '@/types'

export const REPORT_TYPES: readonly Report['type'][] = ['Revenue', 'Audience', 'Conversion', 'Custom']
export const GOAL_METRICS: readonly Goal['metric'][] = ['Revenue', 'Users', 'Conversion', 'Events']
export const TEAM_ROLES: readonly TeamMember['role'][] = ['Owner', 'Admin', 'Member', 'Viewer']
export const INVITE_ROLES: readonly Exclude<TeamMember['role'], 'Owner'>[] = ['Admin', 'Member', 'Viewer']

const ROLE_ORDER: Record<TeamMember['role'], number> = {
  Owner: 0,
  Admin: 1,
  Member: 2,
  Viewer: 3,
}

export interface ReportCreateValues {
  name: string
  type: Report['type']
  description: string
}

export interface GoalFormValues {
  name: string
  owner: string
  deadline: string
  current: number
  target: number
  metric: Goal['metric']
}

export interface InviteFormValues {
  name: string
  email: string
  role: TeamMember['role']
}

export function roleRank(role: TeamMember['role']): number {
  return ROLE_ORDER[role]
}

export function isReportType(value: string): value is Report['type'] {
  return (REPORT_TYPES as readonly string[]).includes(value)
}

export function isGoalMetric(value: string): value is Goal['metric'] {
  return (GOAL_METRICS as readonly string[]).includes(value)
}

export function isTeamRole(value: string): value is TeamMember['role'] {
  return (TEAM_ROLES as readonly string[]).includes(value)
}

export function isInviteRole(value: string): value is Exclude<TeamMember['role'], 'Owner'> {
  return (INVITE_ROLES as readonly string[]).includes(value)
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function parseDateValue(value: string | null | undefined): Date | null {
  if (!value) return null
  const candidate = DATE_ONLY.test(value) ? `${value}T12:00:00` : value
  const parsed = new Date(candidate)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDateOnly(value: string | null | undefined): string {
  const parsed = parseDateValue(value)
  if (!parsed) return '\u2014'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed)
}

export function toDateInputValue(value: string | null | undefined): string {
  const parsed = parseDateValue(value)
  if (!parsed) return ''
  const year = parsed.getFullYear()
  const month = `${parsed.getMonth() + 1}`.padStart(2, '0')
  const day = `${parsed.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isOverdue(value: string, reference: Date = new Date()): boolean {
  const parsed = parseDateValue(value)
  if (!parsed) return false
  const deadline = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime()
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime()
  return deadline < today
}

export function formatMetricValue(value: number, metric: Goal['metric']): string {
  const safe = Number.isFinite(value) ? value : 0
  if (metric === 'Revenue') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Number.isInteger(safe) ? 0 : 2,
    }).format(safe)
  }
  if (metric === 'Conversion') {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(safe)}%`
  }
  return new Intl.NumberFormat('en-US').format(safe)
}

export function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  return `${Math.round(safe)}%`
}

export interface GoalProgressView {
  percent: number
  barPercent: number
  overTarget: boolean
}

export function goalProgress(current: number, target: number): GoalProgressView {
  const safeTarget = Number.isFinite(target) && target > 0 ? target : 0
  const safeCurrent = Number.isFinite(current) ? Math.max(current, 0) : 0
  const percent = safeTarget > 0 ? (safeCurrent / safeTarget) * 100 : 0
  return {
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    overTarget: safeTarget > 0 && safeCurrent > safeTarget,
  }
}

export function parseNumberInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]?.charAt(0) ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? '' : ''
  const initials = `${first}${last}`.toUpperCase()
  return initials || '?'
}

export function slugify(value: string, fallback = 'export'): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

export function csvTimestamp(reference: Date = new Date()): string {
  const year = reference.getFullYear()
  const month = `${reference.getMonth() + 1}`.padStart(2, '0')
  const day = `${reference.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function reportCsvRows(reports: Report[]): Record<string, unknown>[] {
  return reports.map((report) => ({
    Name: report.name,
    Type: report.type,
    Owner: report.owner,
    'Updated at': report.updatedAt,
    Description: report.description,
  }))
}

export function focusById(id: string): void {
  if (typeof document === 'undefined') return
  const element = document.getElementById(id)
  if (element instanceof HTMLElement) element.focus()
}
