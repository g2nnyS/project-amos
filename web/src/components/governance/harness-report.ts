import { t } from '@/i18n'
import type { HarnessId, HarnessRuntimeObservation, HarnessRuntimeReport, ManagedProjectionStatus } from '@/types'

export type StatusTone = 'positive' | 'info' | 'warning' | 'danger' | 'neutral'
export interface StatusView { label: string; tone: StatusTone; description: string }

export const harnessDefinitions: ReadonlyArray<{ id: HarnessId; name: string }> = [
  { id: 'pi', name: 'Pi' },
  { id: 'opencode', name: 'OpenCode' },
]

export const toneClasses: Readonly<Record<StatusTone, string>> = {
  positive: 'border-positive/30 bg-positive/5 text-positive',
  info: 'border-info/30 bg-info/5 text-info',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  danger: 'border-destructive/30 bg-destructive/5 text-destructive',
  neutral: 'border-border bg-muted/60 text-muted-foreground',
}

export function reportModeLabel(report: HarnessRuntimeReport): string {
  if (report.mode === 'enforcing') return t('harness.reportModes.enforcing')
  if (report.mode === 'log-only') return t('harness.reportModes.logOnly')
  return t('harness.reportModes.disabled')
}

/** What the latest receipt of one Harness proves about the current configuration. */
export function reportView(observation: HarnessRuntimeObservation | null): StatusView {
  if (!observation) return { label: t('harness.report.unavailable'), tone: 'neutral', description: t('harness.report.unavailableNote') }
  const report = observation.runtime
  if (observation.status === 'loaded-unverified' && report) {
    const lacksDigest = report.version === 1 || !report.configDigest
    return {
      label: t('harness.report.unverified'),
      tone: 'info',
      description: lacksDigest ? t('harness.report.unverifiedLegacy') : t('harness.report.unverifiedDigest'),
    }
  }
  if (observation.status === 'loaded' && report) {
    if (report.mode === 'enforcing') return { label: t('harness.report.enforcing'), tone: 'positive', description: t('harness.report.enforcingNote') }
    if (report.mode === 'log-only') return { label: t('harness.report.logOnly'), tone: 'info', description: t('harness.report.logOnlyNote') }
    return { label: t('harness.report.disabled'), tone: 'neutral', description: t('harness.report.disabledNote') }
  }
  if (observation.status === 'stale') return { label: t('harness.report.stale'), tone: 'warning', description: t('harness.report.staleNote') }
  if (observation.status === 'never') return { label: t('harness.report.never'), tone: 'neutral', description: t('harness.report.neverNote') }
  if (observation.status === 'invalid') return { label: t('harness.report.invalid'), tone: 'danger', description: t('harness.report.invalidNote') }
  if (observation.status === 'unpublished') return { label: t('harness.report.unpublished'), tone: 'neutral', description: t('harness.report.unpublishedNote') }
  return { label: t('harness.report.missing'), tone: 'warning', description: t('harness.report.missingNote') }
}

/** Whether the generated host file matches the current effective configuration. */
export function projectionView(status: ManagedProjectionStatus['status'] | undefined): StatusView {
  switch (status) {
    case 'written': return { label: t('harness.projection.written'), tone: 'positive', description: t('harness.projection.writtenNote') }
    case 'missing': return { label: t('harness.projection.missing'), tone: 'warning', description: t('harness.projection.missingNote') }
    case 'stale': return { label: t('harness.projection.stale'), tone: 'warning', description: t('harness.projection.staleNote') }
    case 'invalid': return { label: t('harness.projection.invalid'), tone: 'danger', description: t('harness.projection.invalidNote') }
    default: return { label: t('harness.projection.unknown'), tone: 'neutral', description: t('harness.projection.unknownNote') }
  }
}
