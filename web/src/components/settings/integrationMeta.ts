import type { Component } from 'vue'
import {
  CreditCard,
  Database,
  Github,
  Plug,
  Slack,
  TrendingUp,
} from 'lucide-vue-next'
import type { Integration } from '@/types'

const shortFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const longFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/**
 * Provider marks are deliberately monochrome lucide glyphs: the demo should not
 * imply an official brand relationship, and the chrome stays instrument-like.
 */
export function integrationIcon(integration: Integration): Component {
  const key = `${integration.id} ${integration.name}`.toLowerCase()
  if (key.includes('google') || key.includes('analytics')) return TrendingUp
  if (key.includes('stripe')) return CreditCard
  if (key.includes('github')) return Github
  if (key.includes('slack')) return Slack
  if (key.includes('postgres') || key.includes('database') || key.includes('sql')) {
    return Database
  }
  return Plug
}

export function formatLastSynced(value: string, long = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return (long ? longFormatter : shortFormatter).format(date)
}

export function syncLabel(integration: Integration): string {
  if (!integration.connected) return 'Demo only'
  if (!integration.lastSynced) return 'Not synced yet'
  return `Demo timestamp ${formatLastSynced(integration.lastSynced)}`
}
