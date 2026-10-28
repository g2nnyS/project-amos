import type { AuditAction } from './jsonl.ts';

const FILE_OPERATIONS = new Set([
  'file_read',
  'file_write',
  'file_search',
  'file_list',
  'file_stat',
  'file_delete',
  'file_rename',
  'file_mkdir',
  'file_perm',
  'file_link',
  'file_truncate',
]);

/**
 * Matches an absolute URL-like target: a scheme followed by `:` and, for the
 * hierarchical forms we care about, `//`. Bare schemes such as `mailto:` and
 * `data:` are included so their opaque payload is never retained.
 */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/g;

const MAX_QUERY_KEY_LENGTH = 64;
const MAX_QUERY_KEYS = 32;

const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/;

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
    ? value
    : fallback;
}

function escapeControlChars(value: string): string {
  return value.replace(CONTROL_CHAR, (character) => {
    const code = character.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function safeQueryKey(key: string): string {
  const encoded = encodeURIComponent(escapeControlChars(key));
  if (encoded.length === 0) {
    return '[empty-key]';
  }
  return encoded.length > MAX_QUERY_KEY_LENGTH ? '[redacted-key]' : encoded;
}

/**
 * Rebuild a URL without any secret-bearing component.
 *
 * Userinfo, path, query values, and the fragment are always dropped. The host
 * is retained because rule matching and review both need it, and query key
 * names are listed without values.
 */
function sanitizeUrlTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!URL_SCHEME.test(trimmed)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '[unparseable-url]';
  }

  const protocol = url.protocol.endsWith(':')
    ? url.protocol
    : `${url.protocol}:`;
  const host = url.host.length > 0 ? url.host : '[redacted-host]';

  const keys: string[] = [];
  let truncated = false;
  for (const key of url.searchParams.keys()) {
    const safe = safeQueryKey(key);
    if (keys.includes(safe)) {
      continue;
    }
    if (keys.length >= MAX_QUERY_KEYS) {
      truncated = true;
      break;
    }
    keys.push(safe);
  }
  const query =
    keys.length > 0
      ? `?${keys.join('&')}${truncated ? '&[truncated]' : ''}`
      : '';

  return `${protocol}//${host}/[redacted-path]${query}`;
}

/**
 * Return an audit-safe copy of an adapter action.
 *
 * Tool and operation are controlled enums produced by the adapters, so they
 * are preserved as-is. Targets are classified as URLs, file paths, or opaque
 * shapes and reduced to a form that cannot retain command text or secrets.
 *
 * This function never throws and never includes the input target in an error
 * message; a hostile or malformed action degrades to a fully redacted shape.
 */
export function sanitizeAuditAction(action: AuditAction): AuditAction {
  try {
    const tool = safeIdentifier(action.tool, '[redacted-tool]');
    const operation = safeIdentifier(action.operation, '[redacted-operation]');
    const target = typeof action.target === 'string' ? action.target : '';

    // Shell and fully unknown operations never retain command text.
    if (operation === 'shell_input' || operation === 'unknown') {
      return { tool, operation, target: 'unknown' };
    }

    const urlTarget = sanitizeUrlTarget(target);
    if (urlTarget !== null) {
      return { tool, operation, target: urlTarget };
    }

    // Any non-file operation may carry opaque harness input rather than a
    // normalized path; do not echo it.
    if (!FILE_OPERATIONS.has(operation)) {
      return { tool, operation, target: '[redacted-target]' };
    }

    // The adapters use `unknown` as the already-redacted fallback target.
    if (target === 'unknown') {
      return { tool, operation, target: 'unknown' };
    }

    return { tool, operation, target: escapeControlChars(target) };
  } catch {
    return {
      tool: 'unknown',
      operation: 'unknown',
      target: '[redacted-target]',
    };
  }
}
