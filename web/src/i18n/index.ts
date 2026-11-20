/**
 * Console localisation.
 *
 * The Simplified Chinese catalog defines the message keys; every other catalog
 * is type-checked against the same shape, so a missing or extra key fails the
 * build. `t()` reads a reactive locale, so templates and computed values that
 * call it re-render when the language changes. Messages use `{name}`
 * placeholders; a message holding `singular | plural` forms selects one with
 * the `count` parameter.
 */
import { ref } from 'vue'
import zhCN, { type MessageTree } from './zh-CN.js'
import enUS from './en-US.js'

export type Locale = 'zh-CN' | 'en-US'
export const locales: readonly Locale[] = ['zh-CN', 'en-US']
/** Each language in its own script; never translated. */
export const localeNames: Readonly<Record<Locale, string>> = { 'zh-CN': '简体中文', 'en-US': 'English' }

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>
}[keyof T & string]
export type MessageKey = Leaves<typeof zhCN>
export type MessageParams = Readonly<Record<string, string | number>>

function flatten(tree: MessageTree, prefix = '', into = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') into.set(prefix + key, value)
    else flatten(value, `${prefix}${key}.`, into)
  }
  return into
}

const catalogs: Readonly<Record<Locale, ReadonlyMap<string, string>>> = { 'zh-CN': flatten(zhCN), 'en-US': flatten(enUS) }

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en-US'
}

function preferredLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  return languages.filter((value): value is string => typeof value === 'string')
}

/** The first supported language in the user's ordered preferences; English otherwise. */
export function detectLocale(languages: readonly string[] = preferredLanguages()): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase()
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh-CN'
    if (tag === 'en' || tag.startsWith('en-')) return 'en-US'
  }
  return 'en-US'
}

const current = ref<Locale>(detectLocale())

export function getLocale(): Locale {
  return current.value
}

export function setLocale(value: Locale): void {
  if (!isLocale(value)) throw new RangeError('unsupported locale')
  current.value = value
}

export function t(key: MessageKey, params?: MessageParams): string {
  const locale = current.value
  let message = catalogs[locale].get(key) ?? key
  if (params === undefined) return message
  const count = params.count
  if (typeof count === 'number' && message.includes('|')) {
    const [one = message, other = one] = message.split('|').map(form => form.trim())
    message = new Intl.PluralRules(locale).select(count) === 'one' ? one : other
  }
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => Object.hasOwn(params, name) ? String(params[name]) : placeholder)
}
