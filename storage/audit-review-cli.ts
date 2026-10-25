import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  buildReviewQueue,
  renderReviewMarkdown,
  type ReviewRuleInput,
  type ReviewSource,
} from './audit-review.ts';

export interface ReviewCliOptions {
  readonly rules: string;
  readonly logs: readonly string[];
  readonly output: string;
}

const USAGE =
  'usage: audit-review --rules <rules.yaml> --log <audit.jsonl> [--log <audit.jsonl> ...] --output <review.md>';

export function parseReviewCliArgs(
  argv: readonly string[],
): ReviewCliOptions {
  let rules: string | undefined;
  let output: string | undefined;
  const logs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg !== '--rules' && arg !== '--log' && arg !== '--output') {
      if (arg.startsWith('-')) {
        throw new Error(`unknown option: ${arg}`);
      }
      throw new Error(`unexpected argument: ${arg}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new Error(`missing value for ${arg}`);
    }
    index += 1;

    if (arg === '--rules') {
      if (rules !== undefined) {
        throw new Error('--rules may only be specified once');
      }
      rules = value;
    } else if (arg === '--output') {
      if (output !== undefined) {
        throw new Error('--output may only be specified once');
      }
      output = value;
    } else {
      logs.push(value);
    }
  }

  if (rules === undefined) {
    throw new Error('missing required --rules <path>');
  }
  if (logs.length === 0) {
    throw new Error('missing required --log <path>');
  }
  if (output === undefined) {
    throw new Error('missing required --output <path>');
  }

  return { rules, logs, output };
}

export function runReviewCli(argv: readonly string[]): void {
  const options = parseReviewCliArgs(argv);
  const outputPath = resolve(options.output);
  const rulesPath = resolve(options.rules);
  const logPaths = options.logs.map((log) => resolve(log));

  if (outputPath === rulesPath) {
    throw new Error('refusing to write output over the rules file');
  }
  for (const logPath of logPaths) {
    if (outputPath === logPath) {
      throw new Error('refusing to write output over a log file');
    }
  }

  const rules = readRules(rulesPath);
  const sources: ReviewSource[] = logPaths.map((logPath) => ({
    name: logPath,
    lines: readFileSync(logPath, 'utf8').split(/\r?\n/),
  }));

  const queue = buildReviewQueue(sources, rules);
  const markdown = renderReviewMarkdown(queue);

  mkdirSync(dirname(outputPath), { recursive: true });
  // 'wx' creates the worksheet exclusively. Never add a --force path: an
  // existing file may already contain human review notes.
  writeFileSync(outputPath, markdown, { encoding: 'utf8', flag: 'wx' });
}

function readRules(path: string): ReviewRuleInput[] {
  const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('rules file must contain a YAML sequence');
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`rule at index ${index} must be an object`);
    }
    const id = entry.id;
    const level = entry.level;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`rule at index ${index} has no valid id`);
    }
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 0
    ) {
      throw new Error(`rule ${id} has no valid level`);
    }
    return {
      id,
      level,
      on_hit: typeof entry.on_hit === 'string' ? entry.on_hit : undefined,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  try {
    runReviewCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error(USAGE);
    process.exitCode = 1;
  }
}
