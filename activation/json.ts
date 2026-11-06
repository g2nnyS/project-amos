import { createHash } from 'node:crypto';

export const MAX_ITEMS = 1_024;
export const MAX_BYTES = 2_000_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Copy only inert JSON data, without invoking getters or toJSON hooks. */
export function copyJson(value: unknown, depth = 0): Json {
  if (depth > 64) throw new Error('invalid_json');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) throw new Error('invalid_json');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > MAX_ITEMS) {
      throw new Error('invalid_json');
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new Error('invalid_json');
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new Error('invalid_json');
      return copyJson(descriptor.value, depth + 1);
    });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid_json');
  }
  const result: { [key: string]: Json } = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_ITEMS) throw new Error('invalid_json');
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid_json');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('invalid_json');
    }
    result[key] = copyJson(descriptor.value, depth + 1);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function boundedCopy(value: unknown): Json {
  const copied = copyJson(value);
  if (Buffer.byteLength(canonicalJson(copied), 'utf8') > MAX_BYTES) {
    throw new Error('payload_too_large');
  }
  return copied;
}

export function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(`${domain}\0${canonicalJson(value)}`).digest('hex')}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_record');
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) {
    throw new Error('invalid_fields');
  }
  return result;
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160 || value.includes('\0')) {
    throw new Error('invalid_text');
  }
  return value;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('invalid_array');
  return value;
}

export function uniqueStrings(value: unknown): string[] {
  const values = list(value).map(text);
  if (new Set(values).size !== values.length) throw new Error('duplicate_id');
  return values;
}

/** Lexical binding only, matching the existing loader; not real object identity. */
export function workspace(value: unknown): string {
  if (
    typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') ||
    value.includes('//') || (value.length > 1 && value.endsWith('/')) ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) throw new Error('invalid_workspace');
  return value;
}
