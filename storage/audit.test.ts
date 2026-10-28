import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAuditAction } from './audit.ts';

const SECRET = 'SUPER_SECRET_12345';

test('redacts URL userinfo, path, query values, and fragment', () => {
  const sanitized = sanitizeAuditAction({
    tool: 'http_request',
    operation: 'http_request',
    target: `https://alice:${SECRET}@example.com/export/${SECRET}?token=${SECRET}&ok=1#${SECRET}`,
  });

  assert.equal(sanitized.tool, 'http_request');
  assert.equal(sanitized.operation, 'http_request');
  assert.equal(
    sanitized.target,
    'https://example.com/[redacted-path]?token&ok',
  );
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
  assert.equal(sanitized.target.includes('alice'), false);
});

test('redacts non-http schemes while keeping only host and query key names', () => {
  const sanitized = sanitizeAuditAction({
    tool: 'db',
    operation: 'http_request',
    target: `postgres://user:${SECRET}@db.internal:5432/prod/db?sslmode=require&token=${SECRET}#${SECRET}`,
  });

  assert.equal(
    sanitized.target,
    'postgres://db.internal:5432/[redacted-path]?sslmode&token',
  );
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test('omits fragments and opaque non-hierarchical URL payloads', () => {
  const fragmentOnly = sanitizeAuditAction({
    tool: 'webfetch',
    operation: 'http_request',
    target: `https://example.com/path#${SECRET}`,
  });
  assert.equal(fragmentOnly.target, 'https://example.com/[redacted-path]');

  const opaque = sanitizeAuditAction({
    tool: 'mail',
    operation: 'http_request',
    target: `mailto:${SECRET}@example.com`,
  });
  assert.equal(opaque.target, 'mailto://[redacted-host]/[redacted-path]');
  assert.equal(JSON.stringify(opaque).includes(SECRET), false);
});

test('caps retained query keys to bound audit growth', () => {
  const query = Array.from({ length: 40 }, (_, index) => `k${index}=${SECRET}`).join(
    '&',
  );
  const sanitized = sanitizeAuditAction({
    tool: 'http_request',
    operation: 'http_request',
    target: `https://example.com/export?${query}`,
  });

  assert.match(sanitized.target, /\[truncated\]$/);
  assert.equal(sanitized.target.includes('k32'), false);
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test('unparseable URL-like targets degrade to a fixed marker', () => {
  const sanitized = sanitizeAuditAction({
    tool: 'webfetch',
    operation: 'http_request',
    target: `https://[${SECRET}`,
  });

  assert.equal(sanitized.target, '[unparseable-url]');
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test('shell and unknown operations never retain command text', () => {
  const shell = sanitizeAuditAction({
    tool: 'bash',
    operation: 'shell_input',
    target: `echo ${SECRET}`,
  });
  assert.deepEqual(shell, {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  });

  const unknown = sanitizeAuditAction({
    tool: 'mystery',
    operation: 'unknown',
    target: `opaque ${SECRET}`,
  });
  assert.deepEqual(unknown, {
    tool: 'mystery',
    operation: 'unknown',
    target: 'unknown',
  });
});

test('unknown non-file shapes are redacted instead of echoed', () => {
  const sanitized = sanitizeAuditAction({
    tool: 'custom',
    operation: 'custom_operation',
    target: `opaque ${SECRET}`,
  });

  assert.equal(sanitized.target, '[redacted-target]');
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test('ordinary file paths remain while control characters are escaped', () => {
  const sanitized = sanitizeAuditAction({
    tool: 'read',
    operation: 'file_read',
    target: '/srv/project/a\nb\u0000c',
  });

  assert.equal(
    sanitized.target,
    '/srv/project/a\\u000ab\\u0000c',
  );
  assert.equal(/[\u0000-\u001f\u007f]/.test(sanitized.target), false);

  const unknownFallback = sanitizeAuditAction({
    tool: 'read',
    operation: 'file_read',
    target: 'unknown',
  });
  assert.equal(unknownFallback.target, 'unknown');
});

test('hostile tool and operation names are replaced by fixed identifiers', () => {
  const sanitized = sanitizeAuditAction({
    tool: `read ${SECRET}`,
    operation: `file_read\n${SECRET}`,
    target: '/srv/project/a.ts',
  });

  assert.deepEqual(sanitized, {
    tool: '[redacted-tool]',
    operation: '[redacted-operation]',
    target: '[redacted-target]',
  });
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});

test('sanitization never throws or leaks the target through an error', () => {
  const hostile = {
    get tool(): string {
      throw new Error(`boom ${SECRET}`);
    },
    operation: 'file_read',
    target: `/srv/project/${SECRET}`,
  } as unknown as Parameters<typeof sanitizeAuditAction>[0];

  let sanitized: ReturnType<typeof sanitizeAuditAction> | undefined;
  assert.doesNotThrow(() => {
    sanitized = sanitizeAuditAction(hostile);
  });

  assert.ok(sanitized);
  assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
});
