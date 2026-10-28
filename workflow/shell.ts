/**
 * Pure, I/O-free dangerous-shell assessment for the workflow gate.
 *
 * This is a parse-and-classify gate over a deliberately CLOSED bash subset: a
 * literal command word, literal arguments, `;` / newline / `&&` / `||` / `&`,
 * single `|` pipelines, and literal redirections. Anything outside that subset
 * (expansions, substitutions, globs, braces, heredocs, compound syntax,
 * assignments, `cd`, control characters, exhausted limits) is reported as
 * `opaque` and therefore at least `confirm`.
 *
 * It does not execute, resolve symlinks, inspect the filesystem, or constitute
 * a security boundary. Adapters decide how to treat `confirm` (for example, as
 * denial when non-interactive). The raw command string is never placed in the
 * result: errors and reasons are fixed codes, and operations expose only a
 * canonical program name and normalized redirect targets.
 */

import {
  classifyCommand,
  verdictRank,
  type ShellAssessment,
  type ShellCommand,
  type ShellKind,
  type ShellOperation,
  type ShellReason,
  type ShellVerdict,
} from './shell-policy.ts';

export type {
  ShellAssessment,
  ShellEffect,
  ShellKind,
  ShellOperation,
  ShellReason,
  ShellVerdict,
} from './shell-policy.ts';

export type ShellDialect = 'bash' | 'powershell';

export interface AssessShellOptions {
  readonly cwd: string;
  readonly dialect?: ShellDialect;
  readonly shellPath?: string;
  readonly commandPrefix?: string;
}

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_WORDS = 256;
const MAX_COMMANDS = 32;
const MAX_TOKENS = 2048;

const ALLOWED_SHELL_PATHS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  '/bin/bash',
  '/bin/sh',
  '/usr/bin/bash',
  '/usr/bin/sh',
  '/usr/local/bin/bash',
  '/usr/local/bin/sh',
  '/opt/homebrew/bin/bash',
  '/opt/homebrew/bin/sh',
]);

const POWERSHELL_NAMES: ReadonlySet<string> = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/;

const DIRECTORY_BUILTINS: ReadonlySet<string> = new Set([
  'cd',
  'pushd',
  'popd',
  'dirs',
]);

const COMPOUND_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  'in',
]);

class LexError extends Error {
  readonly reason: ShellReason;

  constructor(reason: ShellReason) {
    super(reason);
    this.name = 'LexError';
    this.reason = reason;
  }
}

type Operator = ';' | '\n' | '&&' | '||' | '&' | '|';

type RedirectMode = 'read' | 'write' | 'append';

type Token =
  | { readonly type: 'word'; readonly value: string }
  | { readonly type: 'operator'; readonly op: Operator }
  | { readonly type: 'redirect'; readonly mode: RedirectMode };

interface ParsedRedirect {
  readonly mode: RedirectMode;
  readonly target: string;
}

interface ParsedCommand {
  readonly words: string[];
  readonly redirections: ParsedRedirect[];
}

interface ResolvedTarget {
  readonly path: string;
  readonly insideCwd: boolean;
}

/**
 * Assess one shell command for workflow gating.
 *
 * The result is deeply frozen. Unknown input shapes fail closed as
 * `opaque`/`confirm`; the function never throws and never echoes the command.
 */
export function assessShellCommand(
  command: string,
  options: AssessShellOptions,
): ShellAssessment {
  try {
    return assess(command, options);
  } catch (error) {
    if (error instanceof LexError) {
      return makeResult('opaque', 'confirm', error.reason, []);
    }
    return makeResult('opaque', 'confirm', 'invalid_input', []);
  }
}

function assess(command: string, options: AssessShellOptions): ShellAssessment {
  const raw = options as unknown;
  if (!isRecord(raw)) {
    return makeResult('opaque', 'confirm', 'invalid_input', []);
  }

  const cwdValue = raw.cwd;
  const cwd =
    typeof cwdValue === 'string' ? normalizeAbsolutePath(cwdValue) : null;
  if (cwd === null) {
    return makeResult('opaque', 'confirm', 'invalid_input', []);
  }

  const dialect = raw.dialect;
  if (
    dialect !== undefined &&
    dialect !== 'bash' &&
    dialect !== 'powershell'
  ) {
    return makeResult('unsupported', 'confirm', 'unsupported_dialect', []);
  }
  if (dialect === 'powershell') {
    return makeResult('unsupported', 'confirm', 'unsupported_dialect', []);
  }

  const shellPath = raw.shellPath;
  if (shellPath !== undefined) {
    if (typeof shellPath !== 'string' || shellPath.length === 0) {
      return makeResult('opaque', 'confirm', 'invalid_input', []);
    }
    if (POWERSHELL_NAMES.has(basename(shellPath).toLowerCase())) {
      return makeResult('unsupported', 'confirm', 'unsupported_dialect', []);
    }
    if (!ALLOWED_SHELL_PATHS.has(shellPath)) {
      return makeResult('opaque', 'confirm', 'custom_shell', []);
    }
  }

  const commandPrefix = raw.commandPrefix;
  if (commandPrefix !== undefined) {
    if (typeof commandPrefix !== 'string') {
      return makeResult('opaque', 'confirm', 'invalid_input', []);
    }
    if (commandPrefix.length > 0) {
      return makeResult('opaque', 'confirm', 'custom_command_prefix', []);
    }
  }

  if (typeof command !== 'string') {
    return makeResult('opaque', 'confirm', 'invalid_input', []);
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return makeResult('opaque', 'confirm', 'limits_exceeded', []);
  }

  // A trailing newline is ordinary shell formatting; CRLF and other control
  // characters are not normalized and are rejected by the lexer below.
  const text = command.replace(/\n+$/u, '');
  if (text.length === 0) {
    return makeResult('opaque', 'confirm', 'empty_command', []);
  }

  const tokens = lex(text);
  const parsed = parse(tokens);

  for (const simple of parsed) {
    const first = simple.words[0] ?? '';
    if (first.trim().length === 0) {
      throw new LexError('empty_command');
    }
    if (ASSIGNMENT_WORD.test(first)) {
      throw new LexError('opaque_assignment');
    }
    if (DIRECTORY_BUILTINS.has(first)) {
      throw new LexError('opaque_directory_change');
    }
    if (COMPOUND_KEYWORDS.has(first)) {
      throw new LexError('opaque_compound');
    }
  }

  const commands = parsed.map((simple) => toShellCommand(simple, cwd));

  const operations: ShellOperation[] = [];
  let verdict: ShellVerdict = 'allow';
  let reason: ShellReason = 'safe_workflow_command';

  for (const descriptor of commands) {
    const classification = classifyCommand(descriptor);
    const operation: ShellOperation = {
      program: classification.program,
      effect: classification.effect,
      targets: classification.targets,
      verdict: classification.verdict,
      reason: classification.reason,
    };
    operations.push(operation);

    if (verdictRank(operation.verdict) > verdictRank(verdict)) {
      verdict = operation.verdict;
      reason = operation.reason;
    }
  }

  return makeResult('plan', verdict, reason, operations);
}

function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  let wordCount = 0;

  const pushWord = (): void => {
    if (!inWord) {
      return;
    }
    tokens.push({ type: 'word', value: word });
    word = '';
    inWord = false;
    wordCount += 1;
    if (wordCount > MAX_WORDS) {
      throw new LexError('limits_exceeded');
    }
    if (tokens.length > MAX_TOKENS) {
      throw new LexError('limits_exceeded');
    }
  };

  const pushOperator = (op: Operator): void => {
    pushWord();
    const last = tokens[tokens.length - 1];
    if (
      op === '\n' &&
      last !== undefined &&
      last.type === 'operator' &&
      last.op === '\n'
    ) {
      return;
    }
    tokens.push({ type: 'operator', op });
    if (tokens.length > MAX_TOKENS) {
      throw new LexError('limits_exceeded');
    }
  };

  const pushRedirect = (mode: RedirectMode): void => {
    tokens.push({ type: 'redirect', mode });
    if (tokens.length > MAX_TOKENS) {
      throw new LexError('limits_exceeded');
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === ' ' || char === '\t') {
      pushWord();
      index += 1;
      continue;
    }

    if (char === '\n') {
      pushOperator('\n');
      index += 1;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new LexError('opaque_control_character');
    }

    if (char === '#') {
      throw new LexError('opaque_comment');
    }

    if (char === '\\') {
      if (index + 1 >= text.length) {
        throw new LexError('unbalanced_quote');
      }
      const next = text[index + 1];
      if (hasControlCharacter(next)) {
        throw new LexError('opaque_control_character');
      }
      word += next;
      inWord = true;
      index += 2;
      continue;
    }

    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) {
        throw new LexError('unbalanced_quote');
      }
      const segment = text.slice(index + 1, end);
      if (hasControlCharacter(segment)) {
        throw new LexError('opaque_control_character');
      }
      if (segment.includes('`')) {
        throw new LexError('opaque_substitution');
      }
      if (segment.includes('$')) {
        throw new LexError('opaque_expansion');
      }
      word += segment;
      inWord = true;
      index = end + 1;
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      let segment = '';
      let closed = false;
      while (cursor < text.length) {
        const inner = text[cursor];
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === '$') {
          throw new LexError('opaque_expansion');
        }
        if (inner === '`') {
          throw new LexError('opaque_substitution');
        }
        if (inner === '\\') {
          if (cursor + 1 >= text.length) {
            throw new LexError('unbalanced_quote');
          }
          const next = text[cursor + 1];
          if (hasControlCharacter(next)) {
            throw new LexError('opaque_control_character');
          }
          if (next === '$' || next === '`') {
            throw new LexError('opaque_expansion');
          }
          segment += next;
          cursor += 2;
          continue;
        }
        if (hasControlCharacter(inner)) {
          throw new LexError('opaque_control_character');
        }
        segment += inner;
        cursor += 1;
      }
      if (!closed) {
        throw new LexError('unbalanced_quote');
      }
      word += segment;
      inWord = true;
      index = cursor + 1;
      continue;
    }

    if (char === '$') {
      throw new LexError('opaque_expansion');
    }
    if (char === '`') {
      throw new LexError('opaque_substitution');
    }
    if (char === '*' || char === '?') {
      throw new LexError('opaque_glob');
    }
    if (char === '{') {
      // A standalone `{}` is literal in bash (find's replacement token) and
      // is not brace expansion. Other brace forms stay outside the subset.
      if (text[index + 1] === '}') {
        word += '{}';
        inWord = true;
        index += 2;
        continue;
      }
      throw new LexError('opaque_brace');
    }
    if (char === '}') {
      throw new LexError('opaque_brace');
    }
    if (
      char === '(' ||
      char === ')' ||
      char === '[' ||
      char === ']'
    ) {
      throw new LexError('opaque_compound');
    }
    if (char === '~' && !inWord) {
      throw new LexError('opaque_expansion');
    }
    if (char === '!') {
      throw new LexError('opaque_expansion');
    }

    if (char === '&') {
      const next = text[index + 1];
      if (next === '&') {
        pushOperator('&&');
        index += 2;
        continue;
      }
      if (next === '>') {
        pushWord();
        if (text[index + 2] === '>') {
          pushRedirect('append');
          index += 3;
        } else if (text[index + 2] === '(') {
          throw new LexError('opaque_process_substitution');
        } else {
          pushRedirect('write');
          index += 2;
        }
        continue;
      }
      pushOperator('&');
      index += 1;
      continue;
    }

    if (char === '|') {
      const next = text[index + 1];
      if (next === '|') {
        pushOperator('||');
        index += 2;
        continue;
      }
      if (next === '&') {
        throw new LexError('opaque_compound');
      }
      pushOperator('|');
      index += 1;
      continue;
    }

    if (char === ';') {
      if (text[index + 1] === ';') {
        throw new LexError('opaque_compound');
      }
      pushOperator(';');
      index += 1;
      continue;
    }

    if (char === '<') {
      pushWord();
      const next = text[index + 1];
      if (next === '<') {
        throw new LexError('opaque_heredoc');
      }
      if (next === '(') {
        throw new LexError('opaque_process_substitution');
      }
      if (next === '&' || next === '>' || next === '|') {
        throw new LexError('opaque_redirect');
      }
      pushRedirect('read');
      index += 1;
      continue;
    }

    if (char === '>') {
      pushWord();
      const next = text[index + 1];
      if (next === '>') {
        if (text[index + 2] === '(') {
          throw new LexError('opaque_process_substitution');
        }
        pushRedirect('append');
        index += 2;
        continue;
      }
      if (next === '(') {
        throw new LexError('opaque_process_substitution');
      }
      if (next === '&' || next === '|') {
        throw new LexError('opaque_redirect');
      }
      pushRedirect('write');
      index += 1;
      continue;
    }

    if (!inWord && isAsciiDigit(char)) {
      let cursor = index;
      while (cursor < text.length && isAsciiDigit(text[cursor])) {
        cursor += 1;
      }
      const operator = text[cursor];
      if (operator === '>' || operator === '<') {
        const descriptor = Number(text.slice(index, cursor));
        if (!Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 2) {
          throw new LexError('opaque_redirect');
        }
        const next = text[cursor + 1];

        if (operator === '<') {
          if (descriptor !== 0) {
            throw new LexError('opaque_redirect');
          }
          if (next === '<') {
            throw new LexError('opaque_heredoc');
          }
          if (next === '(') {
            throw new LexError('opaque_process_substitution');
          }
          if (next === '&' || next === '>' || next === '|') {
            throw new LexError('opaque_redirect');
          }
          pushRedirect('read');
          index = cursor + 1;
          continue;
        }

        if (next === '>') {
          if (text[cursor + 2] === '(') {
            throw new LexError('opaque_process_substitution');
          }
          pushRedirect('append');
          index = cursor + 2;
          continue;
        }
        if (next === '(') {
          throw new LexError('opaque_process_substitution');
        }
        if (next === '&' || next === '|') {
          throw new LexError('opaque_redirect');
        }
        pushRedirect('write');
        index = cursor + 1;
        continue;
      }
    }

    word += char;
    inWord = true;
    index += 1;
  }

  pushWord();
  return tokens;
}

function parse(tokens: Token[]): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  let current: ParsedCommand | null = null;
  let pending: RedirectMode | null = null;
  let requireCommand = false;

  for (const token of tokens) {
    if (token.type === 'redirect') {
      if (current === null || pending !== null) {
        throw new LexError('opaque_redirect');
      }
      pending = token.mode;
      continue;
    }

    if (token.type === 'word') {
      if (current === null) {
        current = { words: [], redirections: [] };
        commands.push(current);
        if (commands.length > MAX_COMMANDS) {
          throw new LexError('limits_exceeded');
        }
      }
      if (pending !== null) {
        current.redirections.push({ mode: pending, target: token.value });
        pending = null;
      } else {
        current.words.push(token.value);
      }
      requireCommand = false;
      continue;
    }

    if (pending !== null) {
      throw new LexError('opaque_redirect');
    }

    const operator = token.op;
    if (operator === '\n') {
      if (current !== null) {
        if (current.words.length === 0) {
          throw new LexError('empty_command');
        }
        current = null;
      }
      continue;
    }

    if (current === null) {
      throw new LexError('trailing_operator');
    }
    if (current.words.length === 0) {
      throw new LexError('empty_command');
    }
    current = null;
    requireCommand = true;
  }

  if (pending !== null) {
    throw new LexError('opaque_redirect');
  }
  if (requireCommand) {
    throw new LexError('trailing_operator');
  }
  if (commands.length === 0) {
    throw new LexError('empty_command');
  }
  for (const command of commands) {
    if (command.words.length === 0) {
      throw new LexError('empty_command');
    }
  }

  return commands;
}

function toShellCommand(command: ParsedCommand, cwd: string): ShellCommand {
  const redirections = command.redirections.map((redirect) => {
    const resolved = resolveTarget(cwd, redirect.target);
    if (resolved === null) {
      throw new LexError('opaque_redirect');
    }
    return {
      mode: redirect.mode,
      target: resolved.path,
      insideCwd: resolved.insideCwd,
    };
  });

  return { words: command.words, redirections };
}

function resolveTarget(cwd: string, target: string): ResolvedTarget | null {
  if (target.length === 0) {
    return null;
  }
  const absolute = target.startsWith('/') ? target : `${cwd}/${target}`;
  const path = normalizeAbsolutePath(absolute);
  if (path === null) {
    return null;
  }
  return { path, insideCwd: isInsideCwd(cwd, path) };
}

function normalizeAbsolutePath(value: string): string | null {
  if (!value.startsWith('/') || value.includes('\0')) {
    return null;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }

  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function isInsideCwd(cwd: string, path: string): boolean {
  if (path === cwd) {
    return true;
  }
  if (cwd === '/') {
    return path.startsWith('/');
  }
  return path.startsWith(`${cwd}/`);
}

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value.slice(slash + 1);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function makeResult(
  kind: ShellKind,
  verdict: ShellVerdict,
  reason: ShellReason,
  operations: readonly ShellOperation[],
): ShellAssessment {
  const normalized = operations.map((operation) => ({
    program: operation.program,
    effect: operation.effect,
    targets: [...operation.targets],
    verdict: operation.verdict,
    reason: operation.reason,
  }));

  return deepFreeze({
    kind,
    verdict,
    reason,
    operations: normalized,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value) as T;
  }

  return value;
}
