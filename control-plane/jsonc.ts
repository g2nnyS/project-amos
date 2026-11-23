/**
 * String- and comment-aware JSONC helpers for harness config files.
 *
 * The scanner never interprets comment markers inside string literals, so a
 * URL such as `"https://example.test"` survives untouched. It is deliberately
 * small: JSONC has no schema, only string, comment, and delimiter handling.
 *
 * Offsets returned by `locateTopLevelPluginsArray` point at the literal `[`
 * and `]` characters of the top-level `"plugins"` value. Absence is not an
 * error (`found: false`); `null` means the document could not be scanned at
 * all, such as a non-object root, an unbalanced container or a `plugins` value
 * that is not an array.
 */

export class JsoncError extends Error {
  constructor() {
    super('invalid_jsonc');
    this.name = 'JsoncError';
  }
}

export interface TopLevelPluginsArray {
  readonly found: boolean;
  /** Offset of `[`; -1 when `found` is false. */
  readonly arrayStart: number;
  /** Offset of `]`; -1 when `found` is false. */
  readonly arrayEnd: number;
  readonly hasEntries: boolean;
}

export interface AmosPluginEntryMatch {
  readonly present: boolean;
  readonly identical: boolean;
  /** Pretty-printed existing entry, or null when absent. */
  readonly entryText: string | null;
}

const AMOS_OPENCODE_ADAPTER_SEGMENT = 'adapters/opencode-v2';

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipTrivia(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const ch = text[i]!;
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new JsoncError();
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

interface StringToken {
  readonly raw: string;
  readonly end: number;
}

function readStringToken(text: string, index: number): StringToken {
  if (text[index] !== '"') throw new JsoncError();
  let i = index + 1;
  let raw = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      if (i + 1 >= text.length) throw new JsoncError();
      raw += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return { raw, end: i + 1 };
    raw += ch;
    i += 1;
  }
  throw new JsoncError();
}

/** Return the offset after the container that starts at `index`. */
function skipContainer(text: string, index: number): number {
  const open = text[index];
  if (open !== '{' && open !== '[') throw new JsoncError();
  let depth = 0;
  let i = index;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new JsoncError();
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      i = readStringToken(text, i).end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) throw new JsoncError();
    }
    i += 1;
  }
  throw new JsoncError();
}

/** Return the offset after a string, container, number or literal value. */
function skipValue(text: string, index: number): number {
  const i = skipTrivia(text, index);
  const ch = text[i];
  if (ch === undefined) throw new JsoncError();
  if (ch === '"') return readStringToken(text, i).end;
  if (ch === '{' || ch === '[') return skipContainer(text, i);
  let j = i;
  while (j < text.length) {
    const current = text[j]!;
    if (
      current === ',' ||
      current === '}' ||
      current === ']' ||
      isWhitespace(current) ||
      current === '/'
    ) {
      break;
    }
    j += 1;
  }
  if (j === i) throw new JsoncError();
  return j;
}

function firstSignificantIndex(text: string, start: number, end: number): number {
  const i = skipTrivia(text, start);
  return i < end ? i : -1;
}

function lastSignificantIndex(text: string, start: number, end: number): number {
  let last = -1;
  let i = start;
  while (i < end) {
    const ch = text[i]!;
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < end && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > end) throw new JsoncError();
      i = close + 2;
      continue;
    }
    if (ch === '"') {
      const token = readStringToken(text, i);
      last = token.end - 1;
      i = token.end;
      continue;
    }
    last = i;
    i += 1;
  }
  return last;
}

/** Leading whitespace of the line that contains `index`. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  const match = /^[ \t]*/.exec(prefix);
  return match === null ? '' : match[0];
}

function indentContinuation(value: string, indent: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n');
}

function findRootClosingBrace(text: string): number {
  const open = skipTrivia(text, 0);
  if (text[open] !== '{') throw new JsoncError();
  const close = skipContainer(text, open) - 1;
  const trailing = skipTrivia(text, close + 1);
  if (trailing !== text.length) throw new JsoncError();
  return close;
}

export function stripJsoncComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const token = readStringToken(text, i);
      result += text.slice(i, token.end);
      i = token.end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new JsoncError();
      i = end + 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncComments(text)) as unknown;
}

export function locateTopLevelPluginsArray(
  text: string,
): TopLevelPluginsArray | null {
  let i = skipTrivia(text, 0);
  if (text[i] !== '{') return null;
  i = skipTrivia(text, i + 1);

  while (i < text.length) {
    if (text[i] === '}') {
      return { found: false, arrayStart: -1, arrayEnd: -1, hasEntries: false };
    }
    if (text[i] !== '"') return null;
    const key = readStringToken(text, i);
    i = skipTrivia(text, key.end);
    if (text[i] !== ':') return null;

    const valueStart = skipTrivia(text, i + 1);
    const valueEnd = skipValue(text, valueStart);

    if (key.raw === 'plugins') {
      if (text[valueStart] !== '[') return null;
      const arrayEnd = valueEnd - 1;
      const firstEntry = firstSignificantIndex(text, valueStart + 1, arrayEnd);
      return {
        found: true,
        arrayStart: valueStart,
        arrayEnd,
        hasEntries: firstEntry !== -1 && firstEntry < arrayEnd,
      };
    }

    i = skipTrivia(text, valueEnd);
    if (text[i] === ',') {
      i = skipTrivia(text, i + 1);
      continue;
    }
    if (text[i] === '}') {
      return { found: false, arrayStart: -1, arrayEnd: -1, hasEntries: false };
    }
    return null;
  }

  return null;
}

/**
 * Return `text` with `entryJson` added to the top-level `plugins` array, or
 * with a new pretty-printed `plugins` block appended before the final brace.
 *
 * Comments and whitespace outside the insertion point are preserved
 * byte-for-byte. `entryJson` should be pretty JSON (2-space indentation);
 * continuation lines are indented to match the surrounding array.
 */
export function pluginsArrayInsertion(text: string, entryJson: string): string {
  const located = locateTopLevelPluginsArray(text);
  if (located === null) throw new JsoncError();

  if (located.found) {
    if (!located.hasEntries) {
      const keyIndent = lineIndent(text, located.arrayStart);
      const entryIndent = `${keyIndent}  `;
      const entry = indentContinuation(entryJson, entryIndent);
      const block = `\n${entryIndent}${entry}\n${keyIndent}`;
      return (
        text.slice(0, located.arrayStart + 1) +
        block +
        text.slice(located.arrayEnd)
      );
    }

    const firstEntry = firstSignificantIndex(
      text,
      located.arrayStart + 1,
      located.arrayEnd,
    );
    const multiline = text
      .slice(located.arrayStart, firstEntry)
      .includes('\n');
    const entryIndent = multiline
      ? lineIndent(text, firstEntry)
      : `${lineIndent(text, located.arrayStart)}  `;
    const entry = indentContinuation(entryJson, entryIndent);
    const lastEntry = lastSignificantIndex(
      text,
      located.arrayStart + 1,
      located.arrayEnd,
    );
    if (lastEntry < 0) throw new JsoncError();

    const lastIsComma = text[lastEntry] === ',';
    const separator = multiline ? `\n${entryIndent}` : ' ';
    const insertion = `${lastIsComma ? '' : ','}${separator}${entry}`;
    const insertAt = lastEntry + 1;
    return text.slice(0, insertAt) + insertion + text.slice(insertAt);
  }

  const rootClose = findRootClosingBrace(text);
  const contentEnd = lastSignificantIndex(text, 0, rootClose) + 1;
  if (contentEnd <= 0) throw new JsoncError();
  const lastChar = text[contentEnd - 1]!;
  const needsComma = lastChar !== '{' && lastChar !== ',';

  const rootOpen = skipTrivia(text, 0);
  const firstProperty = firstSignificantIndex(text, rootOpen + 1, rootClose);
  const detectedIndent =
    firstProperty === -1 || text[firstProperty] === '}'
      ? ''
      : lineIndent(text, firstProperty);
  const keyIndent = detectedIndent.length > 0 ? detectedIndent : '  ';
  const entryIndent = `${keyIndent}  `;
  const entry = indentContinuation(entryJson, entryIndent);
  const block = `${needsComma ? ',' : ''}\n${keyIndent}"plugins": [\n${entryIndent}${entry}\n${keyIndent}]`;

  return text.slice(0, contentEnd) + block + text.slice(contentEnd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function opencodeAdapterDirFor(adapterDir: string): string {
  return adapterDir.replace(/\\/g, '/').replace(/\/+$/, '');
}

function plannedOpencodeEntry(adapterDir: string): Record<string, unknown> {
  return {
    package: adapterDir,
    options: {
      rulesPath: deriveRepoPath(adapterDir, 'constraints/rules.yaml'),
      schemaPath: deriveRepoPath(adapterDir, 'constraints/schema.json'),
      logPath: deriveRepoPath(adapterDir, 'spike/logs/opencode.jsonl'),
    },
  };
}

function deriveRepoPath(adapterDir: string, relative: string): string {
  const repoRoot = adapterDir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .slice(0, -3)
    .join('/');
  return `${repoRoot}/${relative}`;
}

/**
 * Find an amos OpenCode plugin entry in a JSONC document.
 *
 * `identical` compares the whole entry against `planned`; when omitted, the
 * planned entry is reconstructed from the standard
 * `<repo>/dist/adapters/opencode-v2` layout.
 */
export function findAmosPluginEntry(
  text: string,
  adapterDir: string,
  planned?: unknown,
): AmosPluginEntryMatch {
  const document = parseJsonc(text);
  const plugins = isRecord(document) ? document.plugins : undefined;
  if (!Array.isArray(plugins)) {
    return { present: false, identical: false, entryText: null };
  }

  for (const entry of plugins) {
    if (!isRecord(entry) || typeof entry.package !== 'string') continue;
    const normalized = opencodeAdapterDirFor(entry.package);
    if (!normalized.includes(AMOS_OPENCODE_ADAPTER_SEGMENT)) continue;
    const expected = planned ?? plannedOpencodeEntry(adapterDir);
    return {
      present: true,
      identical: deepEqual(entry, expected),
      entryText: JSON.stringify(entry, null, 2),
    };
  }

  return { present: false, identical: false, entryText: null };
}
