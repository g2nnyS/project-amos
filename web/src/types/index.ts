import type { SaveJevSettingsInput } from '../../../control-plane/contracts.ts'

export type * from '../../../control-plane/contracts.ts'
export type { JevProviderId, JevPublicConfig } from '../../../decision/config.ts'
export type { ObservationReport, ObservationSourceReport } from '../../../control-plane/observations.ts'
export type JevSettingsInput = SaveJevSettingsInput
export type { ReviewRecord, ReviewQueue } from '../../../storage/audit-review.ts'

export type ThemePreference = 'dark' | 'light' | 'system'
export interface BrowserSession {
  authenticated: boolean
  role?: 'human' | 'agent'
  csrfToken: string
  expiresAt?: number
}
export interface RuntimeStatus {
  mode: 'managed-opt-in'
  /** Enforcement is available, not necessarily enabled for every session. */
  enforcement: true
  defaultEnabled: false
  trustBoundary: false
  projectCount?: number
}
export type HarnessRuntimeState = 'loaded' | 'loaded-unverified' | 'stale' | 'never' | 'invalid' | 'unpublished'
export type HarnessId = 'pi' | 'opencode'
export interface HarnessRuntimeReport {
  format: 'amos-harness-runtime'
  version: 1 | 2
  projectId: string
  activationDigest: string
  epoch: number
  policyVersion: string
  loadedAt: string
  lastToolAt?: string
  harness: HarnessId
  mode: 'enforcing' | 'log-only' | 'disabled'
  configDigest?: string
  capabilities: Record<string, unknown>
}
export interface ManagedProjectionStatus {
  status: 'written' | 'missing' | 'invalid' | 'stale'
  projectId: string | null
  activationDigest: string | null
  epoch: number | null
  policyVersion: string | null
  configDigest: string | null
}
export interface HarnessRuntimeObservation {
  status: HarnessRuntimeState
  runtime: HarnessRuntimeReport | null
}
export interface HarnessRuntimeStatus {
  status: HarnessRuntimeState
  runtime: HarnessRuntimeReport | null
  published: { version: number; activationDigest: string; policyVersion?: string } | null
  projection: ManagedProjectionStatus
  /** Latest load report per harness, not every running session. */
  harnesses: Record<HarnessId, HarnessRuntimeObservation>
}
export type ToastVariant = 'success' | 'error' | 'info'
export interface ToastItem { id: string; title: string; description?: string; variant: ToastVariant }
