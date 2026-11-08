#!/usr/bin/env node
/**
 * Local language-check acceptance gate (G06/G07).
 *
 * This is a deterministic local/CI checkpoint, not a remote enforcement
 * platform and not a security boundary. It runs one fixed TypeScript compiler
 * invocation over the current tree, binds the result to that exact tree, and
 * accepts only a complete result whose coverage and identity match. Raw
 * compiler output, source text, and absolute paths are never printed.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acceptFindingBatch,
  createCheckBinding,
  createFindingBatch,
  type FindingBatch,
  type FindingBatchStatus,
} from './binding.ts';
import { digestTree, type TreeDigestResult } from './tree.ts';
import {
  runTypeScriptCheck,
  type TypeScriptCheckOptions,
  type TypeScriptCheckResult,
} from './typescript-runner.ts';

export const CHECK_GATE_PROJECT_ID = 'amos-check-gate';
export const CHECK_GATE_RULE_ID = 'typescript-check';
export const CHECK_GATE_RULE_VERSION = 1;
export const CHECK_GATE_CHECK_ID = 'typescript-check';
export const CHECK_GATE_CHECK_VERSION = '1';
export const CHECK_GATE_ANALYZER_ID = 'tsc';
export const CHECK_GATE_COMMAND_DOMAIN = 'amos-check-command-v1';

export interface CheckGateOptions {
  readonly projectRoot?: string;
  readonly tsconfigPath?: string;
  readonly tscPath?: string;
  readonly projectId?: string;
  readonly ruleId?: string;
  readonly ruleVersion?: number;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
  /** Test seams; production uses the bounded tree digest and fixed runner. */
  readonly computeTree?: (root: string) => TreeDigestResult;
  readonly runCheck?: (options: TypeScriptCheckOptions) => Promise<TypeScriptCheckResult>;
}

export interface CheckGateResult {
  readonly exitCode: number;
  readonly accepted: boolean;
  readonly acceptanceCode: string | null;
  readonly findingCount: number;
  readonly checkStatus: TypeScriptCheckResult['status'];
  readonly treeDigest: string | null;
  readonly files: number;
}

/**
 * Run the checkpoint and return a fixed summary. The caller decides how to
 * exit; `main` maps non-zero to `process.exitCode`.
 */
export async function runCheckGate(
  options: CheckGateOptions = {},
): Promise<CheckGateResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const tsconfigPath = options.tsconfigPath ?? 'tsconfig.json';
  const projectId = options.projectId ?? process.env.AMOS_CHECK_PROJECT_ID ?? CHECK_GATE_PROJECT_ID;
  const ruleId = options.ruleId ?? process.env.AMOS_CHECK_RULE_ID ?? CHECK_GATE_RULE_ID;
  const ruleVersion = options.ruleVersion ?? CHECK_GATE_RULE_VERSION;
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const computeTree = options.computeTree ?? ((root: string) => digestTree({ root }));
  const runCheck = options.runCheck ?? runTypeScriptCheck;

  const before = computeTree(projectRoot);
  const result = await runCheck({
    projectRoot,
    tsconfigPath,
    ...(options.tscPath === undefined ? {} : { tscPath: options.tscPath }),
  });
  const after = computeTree(projectRoot);

  const binding = createCheckBinding({
    format: 'amos-check-binding',
    version: 1,
    projectId,
    treeDigest: before.digest,
    ruleRef: { id: ruleId, version: ruleVersion },
    check: { id: CHECK_GATE_CHECK_ID, version: CHECK_GATE_CHECK_VERSION },
    analyzer: {
      id: CHECK_GATE_ANALYZER_ID,
      version: analyzerVersion(projectRoot),
    },
    checkpoint: 'ci',
    commandDigest: commandDigest(tsconfigPath),
    issuedAt: now(),
  });

  const status: FindingBatchStatus = result.status === 'passed' ? 'complete' : 'failed';
  const analyzersRun = result.status === 'engine_unavailable' ? 0 : 1;
  const batch: FindingBatch = createFindingBatch({
    format: 'amos-finding-batch',
    version: 1,
    bindingDigest: binding.digest,
    treeDigest: before.digest,
    status,
    coverage: {
      filesExpected: before.files,
      filesChecked: before.files,
      analyzersExpected: 1,
      analyzersRun,
    },
    findings: [],
    completedAt: now(),
  });

  const acceptance = acceptFindingBatch({
    binding,
    batch,
    currentTreeDigest: after.digest,
    expectedCheck: { id: CHECK_GATE_CHECK_ID, version: CHECK_GATE_CHECK_VERSION },
    expectedAnalyzer: {
      id: CHECK_GATE_ANALYZER_ID,
      version: analyzerVersion(projectRoot),
    },
    expectedRuleRef: { id: ruleId, version: ruleVersion },
  });

  const findingCount = batch.findings.length;
  const accepted = acceptance.accepted === true && findingCount === 0;
  const summary: Record<string, unknown> = {
    gate: 'amos-check-gate',
    status: result.status,
    accepted,
    ...(acceptance.accepted === false
      ? { acceptanceCode: acceptance.code }
      : {}),
    treeDigest: before.digest,
    files: before.files,
    findingCount,
    check: CHECK_GATE_CHECK_ID,
  };
  if ('code' in result) {
    summary.checkCode = result.code;
  } else {
    summary.exitCode = result.exitCode;
    summary.outputDigest = result.outputDigest;
  }
  write(JSON.stringify(summary));

  return {
    exitCode: accepted ? 0 : 1,
    accepted,
    acceptanceCode: acceptance.accepted === false ? acceptance.code : null,
    findingCount,
    checkStatus: result.status,
    treeDigest: before.digest,
    files: before.files,
  };
}

function commandDigest(tsconfigPath: string): string {
  const content = [
    CHECK_GATE_COMMAND_DOMAIN,
    'node',
    'typescript/bin/tsc',
    '--noEmit',
    '--pretty',
    'false',
    '-p',
    tsconfigPath,
  ].join('\0');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function analyzerVersion(projectRoot: string): string {
  try {
    const raw = readFileSync(
      join(projectRoot, 'node_modules', 'typescript', 'package.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version.slice(0, 128);
    }
  } catch {
    // The fixed id is enough for a structural binding; no path is disclosed.
  }
  return 'unknown';
}

async function main(): Promise<void> {
  try {
    const result = await runCheckGate();
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({ gate: 'amos-check-gate', accepted: false, code: 'check_error' })}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await main();
}
