const DEFAULT_LOCALE = 'en-US'

export function formatCurrency(
  value: number,
  currency = 'USD',
  options: Intl.NumberFormatOptions = {},
): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: 'currency',
    currency,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    ...options,
  }).format(value)
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(DEFAULT_LOCALE, options).format(value)
}

export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
    ...options,
  }).format(date)
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'
  const seconds = Math.round(totalSeconds)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
