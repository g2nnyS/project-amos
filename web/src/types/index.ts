export type * from '../../../control-plane/contracts.ts'
export type { ObservationReport, ObservationSourceReport } from '../../../control-plane/observations.ts'
export type { ReviewRecord, ReviewQueue } from '../../../storage/audit-review.ts'

export type ThemePreference = 'dark' | 'light' | 'system'
export interface BrowserSession {
  authenticated: boolean
  role?: 'human' | 'agent'
  csrfToken: string
  expiresAt?: number
}
export interface RuntimeStatus {
  mode: 'log-only'
  enforcement: false
  trustBoundary: false
  projectCount?: number
}
export type ToastVariant = 'success' | 'error' | 'info'
export interface ToastItem { id: string; title: string; description?: string; variant: ToastVariant }
