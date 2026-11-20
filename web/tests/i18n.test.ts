import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import zhCN, { type MessageTree } from '../src/i18n/zh-CN.js'
import enUS from '../src/i18n/en-US.js'
import { detectLocale, getLocale, isLocale, setLocale, t } from '../src/i18n/index.js'
import { auditEventLabel, proposalStatusLabel, proposalStatuses, roleLabel } from '../src/i18n/labels.js'
import { usePreferencesStore } from '../src/stores/preferences.js'
import { isPlainRecord, readStoredJson, removeStored, writeStoredJson } from '../src/lib/storage.js'
import type { GovernanceEventKind } from '../src/types/index.js'

const PREFERENCES = 'amos:console:preferences'

function flatten(tree: MessageTree, prefix = '', into = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') into.set(prefix + key, value)
    else flatten(value, `${prefix}${key}.`, into)
  }
  return into
}
const placeholders = (message: string) => [...new Set(message.match(/\{\w+\}/g) ?? [])].sort()

test('every locale has exactly the Chinese keys, non-empty messages and the same placeholders', () => {
  const zh = flatten(zhCN), en = flatten(enUS)
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort())
  for (const [key, source] of zh) {
    const target = en.get(key)!
    assert.ok(source.trim() && target.trim(), `empty message: ${key}`)
    assert.deepEqual(placeholders(target), placeholders(source), `placeholder mismatch: ${key}`)
    assert.equal(source.includes('|'), false, `Chinese has no plural forms: ${key}`)
    if (target.includes('|')) assert.ok(placeholders(target).includes('{count}'), `plural forms need {count}: ${key}`)
  }
})

test('t interpolates parameters, selects English plural forms and follows the active locale', () => {
  setLocale('en-US')
  assert.equal(t('home.attention.pending', { count: 1 }), '1 request awaits review')
  assert.equal(t('home.attention.pending', { count: 3 }), '3 requests await review')
  assert.equal(t('common.loadFailed', { error: 'offline' }), 'Failed to load: offline')
  assert.equal(t('common.version', {}), 'Version {version}')
  setLocale('zh-CN')
  assert.equal(getLocale(), 'zh-CN')
  assert.equal(t('home.attention.pending', { count: 1 }), '1 个申请等待审批')
  assert.equal(t('home.mode.on'), '正在管理')
  assert.equal(t('home.mode.off'), '仅记录')
  assert.throws(() => setLocale('fr-FR' as never), RangeError)
  assert.equal(getLocale(), 'zh-CN')
})

test('the system language picks the first supported locale and falls back to English', () => {
  assert.equal(detectLocale(['zh-CN']), 'zh-CN')
  assert.equal(detectLocale(['zh']), 'zh-CN')
  assert.equal(detectLocale(['en-GB', 'zh-CN']), 'en-US')
  assert.equal(detectLocale(['ja-JP', 'zh-Hans-CN', 'en-US']), 'zh-CN')
  assert.equal(detectLocale(['fr-FR']), 'en-US')
  assert.equal(detectLocale([]), 'en-US')
  assert.equal(isLocale('en-US'), true)
  assert.equal(isLocale('en'), false)
})

test('the language preference applies immediately and persists only an explicit choice', () => {
  removeStored(PREFERENCES)
  setActivePinia(createPinia())
  const followsSystem = usePreferencesStore()
  assert.equal(followsSystem.locale, detectLocale())
  assert.equal(getLocale(), detectLocale())
  followsSystem.setTheme('dark')
  assert.equal(readStoredJson(PREFERENCES, isPlainRecord)?.locale, null)

  followsSystem.setLocale('en-US')
  assert.equal(getLocale(), 'en-US')
  assert.equal(readStoredJson(PREFERENCES, isPlainRecord)?.locale, 'en-US')
  assert.throws(() => followsSystem.setLocale('de-DE' as never))
  assert.equal(followsSystem.locale, 'en-US')

  writeStoredJson(PREFERENCES, { theme: 'light', sidebarCollapsed: false, compact: false, locale: 'zh-CN' })
  setActivePinia(createPinia())
  const restored = usePreferencesStore()
  assert.equal(restored.locale, 'zh-CN')
  assert.equal(getLocale(), 'zh-CN')
  removeStored(PREFERENCES)
})

test('closed server enums have labels in every locale and unknown values pass through', () => {
  const kinds: GovernanceEventKind[] = ['global_config_updated', 'project_created', 'project_config_updated', 'proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_withdrawn', 'proposal_expired', 'version_published', 'temporary_tightening_applied', 'temporary_tightening_expired', 'probe_run_recorded', 'rollout_promoted', 'rollout_promotion_held']
  for (const locale of ['zh-CN', 'en-US'] as const) {
    setLocale(locale)
    for (const kind of kinds) assert.notEqual(auditEventLabel(kind), kind)
    for (const status of proposalStatuses) assert.notEqual(proposalStatusLabel(status), status)
  }
  assert.deepEqual(proposalStatuses, ['pending', 'approved', 'rejected', 'withdrawn', 'expired'])
  assert.equal(auditEventLabel('future_event'), 'future_event')
  assert.equal(proposalStatusLabel('draft'), 'draft')
  setLocale('en-US')
  assert.equal(roleLabel('human'), 'Human')
  assert.equal(roleLabel(undefined), 'Authenticated')
  setLocale('zh-CN')
  assert.equal(roleLabel('agent'), 'Agent')
})
