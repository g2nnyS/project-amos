/**
 * Deterministic canonical JSON and domain-separated sha256 helpers used by the
 * check binding and finding batch contracts.
 *
 * The canonical form is a local copy of the small canonicalization already used
 * by other delivery modules. It is intentionally strict about inert data:
 * getters, prototypes, symbol keys and non-finite numbers are not accepted.
 */

import { createHash } from 'node:crypto';

export const MAX_CANONICAL_ITEMS = 10_000;
export const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

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
    if (prototype !== Array.prototype || value.length > MAX_CANONICAL_ITEMS) {
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
  if (keys.length > MAX_CANONICAL_ITEMS) throw new Error('invalid_json');
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

/** `sha256:` digest binding a domain string and canonical JSON content. */
export function digest(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(`${domain}\0${canonicalJson(value)}`, 'utf8')
    .digest('hex')}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** `sha256:<64 lowercase hex characters>` */
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
