/**
 * Bounded, local-only preparation of Git diff text for a later optional
 * engineering assessment.
 *
 * This module is deliberately pure: it performs no I/O, makes no model calls,
 * and never executes a command. It is a review filter, not a security
 * boundary. In particular, secret detection is heuristic and incomplete:
 * callers must not treat an `eligible` result as proof that a diff is free of
 * secrets. Possible indicators make the diff ineligible rather than relying on
 * regex redaction.
 */

import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

/** Maximum total bytes included in a prepared diff. */
export const MAX_DIFF_BYTES = 256 * 1024;

/** Maximum bytes for one file's diff section before it is omitted. */
export const MAX_FILE_DIFF_BYTES = 128 * 1024;

/** Maximum number of omission marker lines written into a prepared diff. */
export const MAX_DIFF_MARKER_ENTRIES = 50;

export type OmissionReason =
  | 'sensitive_path'
  | 'binary_file'
  | 'oversized_file'
  | 'unsafe_path'
  | 'symlink'
  | 'unreadable'
  | 'diff_limit'
  | 'possible_secret';

export interface Omission {
  readonly path: string;
  readonly reason: OmissionReason;
}

export type SecretIndicator =
  | 'private_key_block'
  | 'bearer_token'
  | 'api_key_assignment'
  | 'sk_like_token'
  | 'known_token_prefix';

export type EgressReason =
  | 'eligible'
  | 'no_changes'
  | 'no_eligible_changes'
  | 'possible_secret'
  | 'truncated';

export interface DiffEgressResult {
  readonly eligible: boolean;
  readonly reason: EgressReason;
  readonly diff?: string;
  readonly digest: string;
  readonly truncated: boolean;
  readonly omittedFiles: readonly string[];
}

export interface PrepareDiffOptions {
  /** Files already omitted before the raw diff was assembled. */
  readonly omitted?: readonly Omission[];
  /** The raw diff itself was cut short by a bounded process read. */
  readonly inputTruncated?: boolean;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

const GENERATED_SEGMENTS = new Set(['node_modules', 'dist', '.git']);

const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  'snapshots',
]);

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  'auth.json',
  'auth.yaml',
  'auth.yml',
  'credential.json',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'secret.json',
  'secrets.json',
  'secret.yaml',
  'secret.yml',
  'secrets.yaml',
  'secrets.yml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'kdbx',
]);

const SENSITIVE_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.gpg',
  '.asc',
];

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/i;

const SK_LIKE_TOKEN =
  /\bsk[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{12,}\b/;

const KNOWN_TOKEN_PREFIX =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/;

const QUOTED_KEY_ASSIGNMENT =
  /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*(["'])([^"'\n]{8,})\1/gi;

const ENV_KEY_ASSIGNMENT =
  /^[+\s]*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^\s#]{8,})\s*$/gm;

const ENV_SECRET_KEY =
  /(?:^|_)(?:API[_-]?KEY|SECRET[_-]?KEY|SECRET|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|PASSWORD|PASSWD)$/;

const PLACEHOLDER_VALUE =
  /^(?:process\.env\.|import\.meta\.|os\.environ|\$\{?|env\.|getenv|your[_-]|example|placeholder|change[_-]?me|redacted|dummy|sample|test[_-]?key|todo|none|null|undefined|<)/i;

function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || PLACEHOLDER_VALUE.test(trimmed);
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

/**
 * Return why a path is outside the review scope, or null when it is allowed.
 * Matching is intentionally conservative and lexical; it does not resolve
 * symlinks or claim object identity.
 */
export function excludedPathReason(path: string): OmissionReason | null {
  const normalized = stripLeadingDotSlash(path.replace(/\\/g, '/'));
  if (normalized.length === 0 || normalized === '.') {
    return null;
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments[lowerSegments.length - 1] ?? '';

  if (lowerSegments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return 'sensitive_path';
  }

  for (let index = 0; index + 1 < lowerSegments.length; index += 1) {
    if (lowerSegments[index] === 'spike' && lowerSegments[index + 1] === 'logs') {
      return 'sensitive_path';
    }
  }

  if (lowerSegments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) {
    return 'sensitive_path';
  }

  if (basename.startsWith('.env')) {
    return 'sensitive_path';
  }

  if (SENSITIVE_BASENAMES.has(basename)) {
    return 'sensitive_path';
  }

  if (
    basename.startsWith('id_rsa.') ||
    basename.startsWith('id_dsa.') ||
    basename.startsWith('id_ecdsa.') ||
    basename.startsWith('id_ed25519.')
  ) {
    return 'sensitive_path';
  }

  if (SENSITIVE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return 'sensitive_path';
  }

  // Snapshot archives are policy provenance, not ordinary source changes.
  // Do not match `snapshot.ts`/`snapshot.test.ts`, which are code.
  if (/^(?:snapshot|snapshots)\.(?:json|jsonl|ya?ml)$/.test(basename)) {
    return 'sensitive_path';
  }
  if (basename.endsWith('.snapshot')) {
    return 'sensitive_path';
  }

  return null;
}

export function isExcludedPath(path: string): boolean {
  return excludedPathReason(path) !== null;
}

/**
 * Heuristic binary detection based on NUL bytes and control-character density.
 * It is not a content classifier and can misclassify unusual text.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  const limit = Math.min(bytes.length, 8_000);
  let suspicious = 0;

  for (let index = 0; index < limit; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) {
      return true;
    }
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }

  if (suspicious / limit > 0.3) {
    return true;
  }

  // Invalid UTF-8 is treated as binary rather than decoded with replacement
  // characters. This intentionally also rejects some legacy text encodings.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return true;
  }

  return false;
}

/**
 * Return indicator labels only. Matched secret text is never returned, logged,
 * or embedded in a reason string.
 */
export function detectSecretIndicators(text: string): SecretIndicator[] {
  const found = new Set<SecretIndicator>();

  if (PRIVATE_KEY_BLOCK.test(text)) {
    found.add('private_key_block');
  }
  if (BEARER_TOKEN.test(text)) {
    found.add('bearer_token');
  }
  if (SK_LIKE_TOKEN.test(text)) {
    found.add('sk_like_token');
  }
  if (KNOWN_TOKEN_PREFIX.test(text)) {
    found.add('known_token_prefix');
  }

  QUOTED_KEY_ASSIGNMENT.lastIndex = 0;
  for (let match = QUOTED_KEY_ASSIGNMENT.exec(text); match !== null; match = QUOTED_KEY_ASSIGNMENT.exec(text)) {
    if (!looksLikePlaceholder(match[2]!)) {
      found.add('api_key_assignment');
      break;
    }
  }

  ENV_KEY_ASSIGNMENT.lastIndex = 0;
  for (let match = ENV_KEY_ASSIGNMENT.exec(text); match !== null; match = ENV_KEY_ASSIGNMENT.exec(text)) {
    if (ENV_SECRET_KEY.test(match[1]!) && !looksLikePlaceholder(match[2]!)) {
      found.add('api_key_assignment');
      break;
    }
  }

  return [...found];
}

export function digestDiff(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface SectionPaths {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly displayPath: string;
  readonly all: readonly string[];
}

interface QuotedPath {
  readonly value: string;
  readonly end: number;
}

function readQuotedPath(value: string, start: number): QuotedPath | null {
  if (value[start] !== '"') {
    return null;
  }

  let result = '';
  let index = start + 1;

  while (index < value.length) {
    const char = value[index]!;
    if (char === '"') {
      return { value: result, end: index + 1 };
    }
    if (char !== '\\') {
      result += char;
      index += 1;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      return null;
    }

    if (next === 'n') {
      result += '\n';
      index += 2;
    } else if (next === 't') {
      result += '\t';
      index += 2;
    } else if (next === 'r') {
      result += '\r';
      index += 2;
    } else if (next === '"' || next === '\\') {
      result += next;
      index += 2;
    } else if (/^[0-7]{3}$/.test(value.slice(index + 1, index + 4))) {
      result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 4), 8));
      index += 4;
    } else {
      result += next;
      index += 2;
    }
  }

  return null;
}

function normalizeDiffPath(value: string): string | undefined {
  let result = value.trimEnd();
  if (result.startsWith('"')) {
    const quoted = readQuotedPath(result, 0);
    if (quoted === null) {
      return undefined;
    }
    result = quoted.value;
  } else {
    const tab = result.indexOf('\t');
    if (tab >= 0) {
      result = result.slice(0, tab);
    }
  }

  if (result === '/dev/null' || result.length === 0) {
    return undefined;
  }

  return result.replace(/^[ab]\//, '');
}

function parseDiffHeaderPaths(line: string): readonly string[] {
  if (!line.startsWith('diff --git ')) {
    return [];
  }

  const rest = line.slice('diff --git '.length);

  if (rest.startsWith('"')) {
    const first = readQuotedPath(rest, 0);
    if (first === null) {
      return [];
    }
    const afterFirst = rest.slice(first.end).trimStart();
    const second = afterFirst.startsWith('"')
      ? readQuotedPath(afterFirst, 0)
      : null;
    if (second === null) {
      return [first.value.replace(/^[ab]\//, '')].filter(Boolean);
    }
    return [
      first.value.replace(/^[ab]\//, ''),
      second.value.replace(/^[ab]\//, ''),
    ].filter(Boolean);
  }

  const index = rest.lastIndexOf(' b/');
  if (index <= 0) {
    return [];
  }

  return [rest.slice(0, index), rest.slice(index + 1)]
    .map((value) => value.replace(/^[ab]\//, ''))
    .filter(Boolean);
}

function parseSectionPaths(section: string): SectionPaths {
  let oldPath: string | undefined;
  let newPath: string | undefined;

  const lines = section.split('\n');
  for (const line of lines) {
    if (line.startsWith('@@')) {
      break;
    }
    if (oldPath === undefined && line.startsWith('--- ')) {
      oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (newPath === undefined && line.startsWith('+++ ')) {
      newPath = normalizeDiffPath(line.slice(4));
    }
  }

  if (oldPath === undefined && newPath === undefined) {
    const header = lines[0] ?? '';
    const paths = parseDiffHeaderPaths(header);
    oldPath = paths[0];
    newPath = paths[1] ?? paths[0];
  }

  const all = [oldPath, newPath].filter(
    (path): path is string => path !== undefined && path.length > 0,
  );
  const displayPath = newPath ?? oldPath ?? '<unknown>';

  return { oldPath, newPath, displayPath, all };
}

function splitDiffSections(raw: string): string[] {
  if (raw.length === 0) {
    return [];
  }

  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    starts.push(match.index);
  }

  if (starts.length === 0) {
    return raw.trim().length === 0 ? [] : [raw];
  }

  const sections: string[] = [];
  const preamble = raw.slice(0, starts[0]);
  if (preamble.trim().length > 0) {
    sections.push(preamble);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const next = starts[index + 1] ?? raw.length;
    sections.push(raw.slice(starts[index], next));
  }

  return sections;
}

function isBinarySection(section: string): boolean {
  return /^(?:Binary files .* differ|GIT binary patch)$/m.test(section);
}

function escapeMarkerValue(value: string): string {
  return value
    .slice(0, 200)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function buildOmissionMarkers(
  omissions: readonly Omission[],
  truncated: boolean,
  maxBytes: number,
): string[] {
  const lines: string[] = [];
  const shown = omissions.slice(0, MAX_DIFF_MARKER_ENTRIES);
  for (const omission of shown) {
    lines.push(
      `# change-review-omitted: ${escapeMarkerValue(omission.path)} (${omission.reason})`,
    );
  }
  if (omissions.length > shown.length) {
    lines.push(
      `# change-review-omitted: ... and ${omissions.length - shown.length} more`,
    );
  }
  if (truncated) {
    lines.push(
      `# change-review-truncated: review input limited to ${maxBytes} bytes; changes may be omitted`,
    );
  }
  return lines;
}

function canonicalEnvelope(input: {
  readonly indicators: readonly SecretIndicator[];
  readonly omissions: readonly Omission[];
  readonly included: readonly string[];
  readonly truncated: boolean;
}): string {
  const lines = [
    '# change-review-envelope',
    `# possible-secret=${input.indicators.length > 0 ? 'true' : 'false'}`,
    `# truncated=${input.truncated ? 'true' : 'false'}`,
  ];
  for (const indicator of [...input.indicators].sort()) {
    lines.push(`# indicator=${indicator}`);
  }
  for (const omission of input.omissions) {
    lines.push(
      `# omitted=${escapeMarkerValue(omission.path)} (${omission.reason})`,
    );
  }
  lines.push('# included');
  lines.push(...input.included);
  return lines.join('\n');
}

/**
 * Prepare a bounded, filtered diff for optional egress to a later assessment.
 *
 * Conditions for `eligible: true`: at least one clean text section survives,
 * no possible secret indicator was found, and the payload was not truncated by
 * a size limit. Omitted sensitive or binary files are reported separately and
 * do not by themselves make an otherwise clean diff ineligible.
 */
export function prepareDiffForEgress(
  rawDiff: string,
  options: PrepareDiffOptions = {},
): DiffEgressResult {
  const raw = typeof rawDiff === 'string' ? rawDiff : '';
  const maxBytes = options.maxBytes ?? MAX_DIFF_BYTES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_DIFF_BYTES;

  const omissions: Omission[] = [];
  const omissionPaths = new Set<string>();
  const omittedPaths: string[] = [];
  const addOmission = (path: string, reason: OmissionReason): void => {
    if (omissionPaths.has(path)) {
      return;
    }
    omissionPaths.add(path);
    omittedPaths.push(path);
    omissions.push({ path, reason });
  };

  for (const omission of options.omitted ?? []) {
    addOmission(omission.path, omission.reason);
  }

  const sections = splitDiffSections(raw);
  const included: string[] = [];
  const indicators = new Set<SecretIndicator>();
  let truncated = options.inputTruncated === true;
  let totalBytes = 0;

  for (const section of sections) {
    const paths = parseSectionPaths(section);
    const excluded = paths.all
      .map((path) => ({ path, reason: excludedPathReason(path) }))
      .find((entry) => entry.reason !== null);

    if (excluded !== undefined) {
      addOmission(paths.displayPath, excluded.reason ?? 'sensitive_path');
      continue;
    }

    if (isBinarySection(section)) {
      addOmission(paths.displayPath, 'binary_file');
      continue;
    }

    const sectionIndicators = detectSecretIndicators(section);
    if (sectionIndicators.length > 0) {
      for (const indicator of sectionIndicators) {
        indicators.add(indicator);
      }
      addOmission(paths.displayPath, 'possible_secret');
      continue;
    }

    const sectionBytes = Buffer.byteLength(section, 'utf8');
    if (sectionBytes > maxFileBytes) {
      addOmission(paths.displayPath, 'oversized_file');
      truncated = true;
      continue;
    }

    if (totalBytes + sectionBytes > maxBytes) {
      addOmission(paths.displayPath, 'diff_limit');
      truncated = true;
      continue;
    }

    included.push(section);
    totalBytes += sectionBytes;
  }

  const secret = indicators.size > 0;
  let reason: EgressReason;
  if (secret) {
    reason = 'possible_secret';
  } else if (truncated) {
    reason = 'truncated';
  } else if (included.length === 0) {
    reason = raw.trim().length === 0 && omissions.length === 0
      ? 'no_changes'
      : 'no_eligible_changes';
  } else {
    reason = 'eligible';
  }

  let diff: string | undefined;
  if (!secret && included.length > 0) {
    const pieces = [...included];
    const markers = buildOmissionMarkers(omissions, truncated, maxBytes);
    if (markers.length > 0) {
      pieces.push(markers.join('\n'));
    }
    diff = pieces.join('\n');
    if (!diff.endsWith('\n')) {
      diff += '\n';
    }
  }

  const digestInput = diff !== undefined
    ? diff
    : reason === 'no_changes'
      ? ''
      : canonicalEnvelope({
        indicators: [...indicators],
        omissions,
        included,
        truncated,
      });

  return {
    eligible: reason === 'eligible',
    reason,
    ...(diff === undefined ? {} : { diff }),
    digest: digestDiff(digestInput),
    truncated,
    omittedFiles: omittedPaths,
  };
}

/**
 * Build a synthetic unified diff for an untracked text file. The content is
 * assumed to have already passed exclusion, size, and binary checks.
 */
export function createUntrackedDiff(
  path: string,
  content: string,
  mode = '100644',
): string {
  const headerPath = path.replace(/\\/g, '/');
  const lines: string[] = [
    `diff --git a/${headerPath} b/${headerPath}`,
    `new file mode ${mode}`,
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${headerPath}`,
  ];

  if (content.length === 0) {
    return `${lines.join('\n')}\n`;
  }

  const hasTrailingNewline = content.endsWith('\n');
  const body = hasTrailingNewline ? content.slice(0, -1) : content;
  const contentLines = body.split('\n');

  lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
  for (const line of contentLines) {
    lines.push(`+${line}`);
  }
  if (!hasTrailingNewline) {
    lines.push('\\ No newline at end of file');
  }

  return `${lines.join('\n')}\n`;
}
