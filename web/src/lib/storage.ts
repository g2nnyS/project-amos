/**
 * Defensive local persistence helpers.
 *
 * - Works in an SSR/Node context where `window` does not exist.
 * - Falls back to an in-process Map when localStorage is missing, blocked or
 *   over quota, so the demo keeps functioning for the current session.
 * - Never stores credentials; callers are expected to persist only demo
 *   workspace/preference state.
 */

const memoryFallback = new Map<string, string>()

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    const storage = window.localStorage
    if (!storage) return null
    const probe = 'amos:console:probe'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}

export function readStoredJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  let raw: string | null | undefined
  try {
    const storage = browserStorage()
    raw = memoryFallback.get(key) ?? (storage ? storage.getItem(key) : undefined)
  } catch {
    raw = memoryFallback.get(key)
  }
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isValid(parsed)) {
      removeStored(key)
      return null
    }
    return parsed
  } catch {
    removeStored(key)
    return null
  }
}

export function writeStoredJson(key: string, value: unknown): boolean {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  try {
    const storage = browserStorage()
    if (storage) {
      storage.setItem(key, serialized)
      memoryFallback.delete(key)
      return true
    }
  } catch {
    // Fall through to the in-memory copy.
  }
  memoryFallback.set(key, serialized)
  return false
}

export function removeStored(key: string): void {
  try {
    const storage = browserStorage()
    if (storage) storage.removeItem(key)
  } catch {
    // Ignore storage teardown failures.
  }
  memoryFallback.delete(key)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Exposed for tests and diagnostics; does not include stored values. */
export function hasPersistentStorage(): boolean {
  return browserStorage() !== null
}
