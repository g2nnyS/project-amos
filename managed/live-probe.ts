/**
 * Explicit, opt-in live Harness probe for the managed Jev path.
 *
 * The probe exercises the real production path: a real SQLite governance
 * publication, the published `.pi/activation.json`, a real Pi AgentSession
 * with the compiled Amos extension, real file effects, and the Jev managed
 * reviewer. It is not part of `npm test` and never prints credentials or
 * requirement text. Failure output is a fixed code only.
 *
 * Preconditions are explicit. If any is missing or invalid the probe prints
 * `live probe SKIPPED: <fixed_code>` plus the missing/invalid item codes and
 * exits 0. Assertion failures exit 1 with a fixed code only.
 *
 * Run after `npm run build`:
 *   npm run probe:live
 *
 * Environment:
 *   AMOS_LIVE_JEV_CONFIG       Jev config JSON; default ~/.config/amos/jev.local.json
 *   AMOS_LIVE_REVIEW_POLICY    JSON {reviewer:"jev",policy,calibration,ceilingDigest}
 *   AMOS_LOCAL_LLAMA_URL       Pi session model endpoint (required)
 *   AMOS_LOCAL_LLAMA_KEY_FILE  credential file; default ~/.config/llama-server/api-key
 *   AMOS_LOCAL_LLAMA_MODEL     default gemma-4-e4b
 *
 * The local llama endpoint serves the Pi session model only. The reviewer is
 * Jev and reads AMOS_LIVE_JEV_CONFIG. The adapter captures the direct user
 * prompt into
 * $XDG_STATE_HOME/amos-governance/requirement-registry/<projectId>.json;
 * the probe redirects XDG_STATE_HOME to its temp root and asserts the registry
 * structure afterwards without printing the text.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import type { PublishedVersion, RuleRecord } from '../control-plane/contracts.ts';
import { readRuntimeStatus } from '../control-plane/runtime-status.ts';
import { startServe } from '../control-plane/cli.ts';
import { loadJevConfig, type LoadedJevConfig } from '../decision/config.ts';
import { JEV_QUESTION_SET_VERSION } from '../decision/jev.ts';
import {
  defaultRequirementRegistryPath,
  REQUIREMENT_REGISTRY_FORMAT,
  REQUIREMENT_REGISTRY_VERSION,
} from '../decision/requirement-registry.ts';
import {
  isValidPolicy,
  validateCalibration,
  type CalibrationEvidence,
  type ReviewerPolicy,
} from '../review/calibration.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');
const ADAPTER = join(ROOT, 'dist', 'adapters', 'pi', 'index.js');
const JEV_CONFIG_PATH = resolve(
  process.env.AMOS_LIVE_JEV_CONFIG?.trim() ||
    join(homedir(), '.config', 'amos', 'jev.local.json'),
);
const REVIEW_POLICY_PATH = process.env.AMOS_LIVE_REVIEW_POLICY?.trim() ?? '';
const ENDPOINT = process.env.AMOS_LOCAL_LLAMA_URL?.trim() ?? '';
const KEY_FILE = resolve(
  process.env.AMOS_LOCAL_LLAMA_KEY_FILE?.trim() ||
    join(homedir(), '.config', 'llama-server', 'api-key'),
);
const MODEL = process.env.AMOS_LOCAL_LLAMA_MODEL ?? 'gemma-4-e4b';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface ReviewFile {
  readonly reviewer: 'jev';
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence;
  readonly ceilingDigest: string;
}

interface PreflightValue {
  readonly jevConfigPath: string;
  readonly review: ReviewFile;
  readonly endpoint: string;
  readonly apiKey: string;
}

type PreflightResult =
  | { readonly ok: true; readonly value: PreflightValue }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly missing: readonly string[];
      readonly invalid: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skip(reason: string, invalid: readonly string[]): PreflightResult {
  return { ok: false, reason, missing: [], invalid };
}

function preflight(): PreflightResult {
  const missing: string[] = [];
  if (!existsSync(JEV_CONFIG_PATH)) missing.push('jev_config_file');

  if (REVIEW_POLICY_PATH.length === 0) {
    missing.push('review_policy_path');
  } else if (!existsSync(resolve(REVIEW_POLICY_PATH))) {
    missing.push('review_policy_file');
  }

  if (ENDPOINT.length === 0) {
    missing.push('local_llama_url');
  }

  let apiKey = '';
  if (!existsSync(KEY_FILE)) {
    missing.push('local_llama_credential');
  } else {
    try {
      apiKey = readFileSync(KEY_FILE, 'utf8').trim();
    } catch {
      apiKey = '';
    }
    if (apiKey.length === 0) missing.push('local_llama_credential');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'preconditions_unmet',
      missing,
      invalid: [],
    };
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(ENDPOINT);
  } catch {
    return skip('local_llama_url_invalid', ['local_llama_url']);
  }
  if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
    return skip('local_llama_url_invalid', ['local_llama_url']);
  }

  let jev: LoadedJevConfig;
  try {
    jev = loadJevConfig(JEV_CONFIG_PATH);
  } catch {
    return skip('jev_config_invalid', ['jev_config']);
  }

  const reviewPath = resolve(REVIEW_POLICY_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reviewPath, 'utf8'));
  } catch {
    return skip('review_policy_invalid', ['review_policy']);
  }
  if (
    !isRecord(parsed) ||
    parsed.reviewer !== 'jev' ||
    Object.keys(parsed).sort().join(',') !==
      'calibration,ceilingDigest,policy,reviewer'
  ) {
    return skip('review_policy_invalid', ['review_policy']);
  }

  const policyValue = parsed.policy;
  if (!isValidPolicy(policyValue)) {
    return skip('policy_invalid', ['policy']);
  }
  const policy = policyValue;

  const calibrationValue = parsed.calibration;
  if (!isRecord(calibrationValue)) {
    return skip('calibration_malformed', ['calibration']);
  }
  // validateCalibration performs the structural check; the cast only bridges
  // the parsed JSON record to its declared shape.
  const calibration = calibrationValue as unknown as CalibrationEvidence;

  const ceilingDigest = parsed.ceilingDigest;
  if (
    typeof ceilingDigest !== 'string' ||
    !DIGEST_PATTERN.test(ceilingDigest)
  ) {
    return skip('ceiling_digest_invalid', ['ceiling_digest']);
  }

  if (policy.questionVersion !== JEV_QUESTION_SET_VERSION) {
    return skip('policy_question_version_mismatch', ['policy']);
  }
  if (policy.requirementEgress !== 'allowed') {
    return skip('policy_requirement_egress_denied', ['policy']);
  }
  if (policy.targetEgress !== 'workspace-relative') {
    return skip('policy_target_egress_denied', ['policy']);
  }
  if (policy.model !== jev.config.defaultModel) {
    return skip('policy_model_mismatch', ['policy']);
  }

  const calibrationResult = validateCalibration(policy, calibration, Date.now());
  if (!calibrationResult.ok) {
    const code =
      calibrationResult.code === 'expired'
        ? 'calibration_expired'
        : `calibration_${calibrationResult.code}`;
    return skip(code, ['calibration']);
  }

  return {
    ok: true,
    value: {
      jevConfigPath: JEV_CONFIG_PATH,
      review: {
        reviewer: 'jev',
        policy,
        calibration,
        ceilingDigest,
      },
      endpoint: ENDPOINT,
      apiKey,
    },
  };
}

function source(id: string) {
  return {
    repo: 'live-probe',
    rev: 'v1',
    path: 'scripts/live-probe.ts',
    section: 'synthetic live probe',
    lines: '1',
    quote: `Synthetic live probe rule ${id}.`,
  };
}

function rule(
  id: string,
  onHit: 'deny' | 'confirm' | 'log',
  operation: string,
  target: string,
  dimension = 'live',
  narrative = `Live probe rule ${id}.`,
): RuleRecord {
  return {
    id,
    dimension,
    level: 1,
    expressivity: 'deterministic',
    policy_class: 'security',
    enforcement: 'runtime',
    predicate: [
      { op: 'op_in', args: { operations: [operation] } },
      { op: 'target_glob', args: { patterns: [`\${SESSION_WORKSPACE}/${target}`] } },
    ],
    narrative,
    on_hit: onHit,
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: source(id),
    probe: `Synthetic live probe action for ${id}.`,
  };
}

function assertRequirementRegistry(
  projectId: string,
  expectedSessionIds: readonly string[],
): {
  readonly activeSessions: number;
  readonly revisions: number;
} {
  const path = defaultRequirementRegistryPath(projectId, process.env);
  if (!existsSync(path)) throw new Error('requirement_registry_missing');

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('requirement_registry_unreadable');
  }
  if (
    !isRecord(raw) ||
    raw.format !== REQUIREMENT_REGISTRY_FORMAT ||
    raw.version !== REQUIREMENT_REGISTRY_VERSION ||
    raw.projectId !== projectId ||
    !Array.isArray(raw.sessions)
  ) {
    throw new Error('requirement_registry_invalid');
  }

  let activeSessions = 0;
  let revisions = 0;
  const matched = new Set<string>();
  for (const session of raw.sessions) {
    if (!isRecord(session)) throw new Error('requirement_session_invalid');
    if (session.state !== 'active' || !Array.isArray(session.revisions)) {
      continue;
    }
    if (session.revisions.length < 1) {
      throw new Error('requirement_revision_missing');
    }
    for (const revision of session.revisions) {
      if (
        !isRecord(revision) ||
        typeof revision.version !== 'number' ||
        !Number.isSafeInteger(revision.version) ||
        revision.version < 1 ||
        typeof revision.digest !== 'string' ||
        !DIGEST_PATTERN.test(revision.digest)
      ) {
        throw new Error('requirement_revision_invalid');
      }
    }
    if (typeof session.sessionId === 'string') {
      matched.add(session.sessionId);
    }
    activeSessions += 1;
    revisions = Math.max(revisions, session.revisions.length);
  }
  const expected = expectedSessionIds.filter((id) => id.length > 0);
  if (expected.length > 0) {
    if (expected.some((id) => !matched.has(id))) {
      throw new Error('requirement_registry_session_missing');
    }
  } else if (activeSessions < 1) {
    throw new Error('requirement_registry_no_active_session');
  }
  return { activeSessions, revisions };
}

async function main(): Promise<number> {
  if (!existsSync(ADAPTER)) {
    console.error('live probe: build_required');
    return 2;
  }

  const pre = preflight();
  if (!pre.ok) {
    console.log(`live probe SKIPPED: ${pre.reason}`);
    if (pre.missing.length > 0) {
      console.log(`missing: ${pre.missing.join(', ')}`);
    }
    if (pre.invalid.length > 0) {
      console.log(`invalid: ${pre.invalid.join(', ')}`);
    }
    return 0;
  }
  const { jevConfigPath, review, endpoint, apiKey } = pre.value;

  const root = mkdtempSync(join(tmpdir(), 'amos-live-probe-'));
  const workspace = join(root, 'workspace');
  const auditDir = join(root, 'audit');
  const agentDir = join(root, 'agent');
  const stateHome = join(root, 'state-home');
  process.env.XDG_STATE_HOME = stateHome;
  for (const dir of [
    workspace,
    join(workspace, 'src'),
    join(workspace, '.pi', 'extensions'),
    auditDir,
    agentDir,
    stateHome,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(workspace, 'src', 'input.txt'), 'HELLO_FROM_LOCAL_MODEL\n');
  writeFileSync(join(workspace, 'src', 'input.py'), 'print("PY_INPUT")\n');

  const governance = await startServe({
    rootDir: ROOT,
    dataDir: join(root, 'state'),
    workspace,
    port: 0,
    now: () => Date.now(),
  });
  const base = governance.url;
  let cookie = '';
  let csrf = '';
  const captureCookie = (response: Response): void => {
    const values = response.headers.getSetCookie?.() ?? [];
    const raw = values[0] ?? response.headers.get('set-cookie') ?? '';
    const first = raw.split(';', 1)[0] ?? '';
    if (first.length > 0) cookie = first;
  };
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      origin: base,
      ...(cookie.length === 0 ? {} : { cookie }),
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    captureCookie(response);
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error?: { code?: unknown } }).error?.code ?? 'http')
          : 'http';
      throw new Error(`governance_${response.status}_${code}`);
    }
    return payload as Record<string, unknown>;
  };

  try {
    const anonymous = await call('GET', '/api/session');
    csrf = String(anonymous.csrfToken ?? '');
    const humanToken = readFileSync(governance.paths.humanTokenPath, 'utf8').trim();
    const login = await call('POST', '/api/login', { token: humanToken });
    csrf = String(login.csrfToken ?? '');
    const project = (await call('POST', '/api/projects', {
      name: 'Live probe',
      workspace,
    })) as { id: string };
    await call('POST', `/api/projects/${project.id}/config`, {
      managed: {
        enabled: true,
        requirementEgress: 'allowed',
        grantTtlMs: 20_000,
        reviewer: review.reviewer,
        jevConfigPath,
        reviewPolicy: review.policy,
        reviewCalibration: review.calibration,
        ceilingDigest: review.ceilingDigest,
      },
    });
    const candidate = {
      rules: [
        rule('live-read', 'log', 'file_read', 'src/**'),
        rule('live-confirm', 'confirm', 'file_write', 'src/confirm.txt'),
        rule('live-deny', 'deny', 'file_write', 'src/deny.txt'),
        rule('live-ts', 'log', 'file_read', 'src/**/*.ts', 'typescript', 'TypeScript live guidance.'),
        rule('live-python', 'log', 'file_read', 'src/**/*.py', 'python', 'Python live guidance.'),
      ],
      activation: { includedRuleIds: null, excludedRuleIds: [] },
      injection: { baselineRuleIds: [], routes: [] },
    };
    const proposal = (await call('POST', `/api/projects/${project.id}/proposals`, {
      title: 'Live probe publication',
      rationale: 'Synthetic live probe; no production data.',
      baseVersion: 0,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      candidate,
    })) as { id: string; digest: string };
    await call('POST', `/api/proposals/${proposal.id}/decision`, {
      decision: 'approve',
      note: 'live probe',
      expectedDigest: proposal.digest,
    });
    const published = (await call('GET', `/api/projects/${project.id}/versions/1`)) as unknown as PublishedVersion;
    if (published.version !== 1) throw new Error('publish_failed');
    const activation = published.snapshot.activationSnapshot;

    writeFileSync(
      join(workspace, '.pi', 'amos.json'),
      `${JSON.stringify({
        mode: 'log-only',
        rulesPath: RULES,
        schemaPath: SCHEMA,
        logPath: join(auditDir, 'shadow.jsonl'),
        activation: { snapshotPath: '.pi/activation.json', projectId: project.id },
      })}\n`,
    );
    writeFileSync(
      join(workspace, '.pi', 'extensions', 'amos.js'),
      `export { default } from ${JSON.stringify(ADAPTER)};\n`,
    );

    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('local-llama', {
      name: 'Local llama.cpp',
      api: 'openai-completions',
      baseUrl: endpoint,
      apiKey,
      authHeader: true,
      models: [
        {
          id: MODEL,
          name: MODEL,
          api: 'openai-completions',
          input: ['text'],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        },
      ],
    });
    const model = runtime.getModel('local-llama', MODEL);
    if (!model) throw new Error('local_model_unavailable');

    const sessionFor = async () =>
      createAgentSession({
        cwd: workspace,
        agentDir,
        model,
        modelRuntime: runtime,
        settingsManager: SettingsManager.inMemory(),
        sessionManager: SessionManager.inMemory(workspace),
        tools: ['read', 'write'],
      });

    // 1) Real model completes a read + confirm-approved write exactly once.
    const first = await sessionFor();
    const firstSessionId = first.session.sessionManager.getSessionId();
    await first.session.prompt(
      'This is a typescript task. Read src/input.txt with the read tool, then create src/confirm.txt with the write tool using exactly the same content. Use only read and write tools. Never use bash.',
      { expandPromptTemplates: false },
    );
    const confirmPath = join(workspace, 'src', 'confirm.txt');
    if (!existsSync(confirmPath)) throw new Error('approved_write_missing');
    const confirmed = readFileSync(confirmPath, 'utf8');
    // The model may normalize a trailing newline; the meaningful independent
    // check is that the written text is the input text and not model narration.
    if (confirmed.trimEnd() !== 'HELLO_FROM_LOCAL_MODEL') {
      throw new Error('approved_write_content_mismatch');
    }
    const system = first.session.agent.state.messages[0] as unknown as {
      sections?: Record<string, string>;
    };
    const guidance = system.sections?.['amos-workflow-guidance'] ?? '';
    if (!guidance.includes(activation.activationDigest)) {
      throw new Error('injection_snapshot_mismatch');
    }
    if (!guidance.includes('live-ts')) throw new Error('typescript_guidance_missing');
    if (guidance.includes('live-python')) throw new Error('unrelated_guidance_present');
    first.session.dispose();

    // 2) Real model hits a deterministic deny; no target side effect.
    const second = await sessionFor();
    const secondSessionId = second.session.sessionManager.getSessionId();
    await second.session.prompt(
      'Write src/deny.txt with the text FORBIDDEN using the write tool. Use only the write tool. Never use bash.',
      { expandPromptTemplates: false },
    );
    if (existsSync(join(workspace, 'src', 'deny.txt'))) throw new Error('denied_write_happened');
    second.session.dispose();

    // 3) Different task routing selects different injection; execution rules unchanged.
    const third = await sessionFor();
    const thirdSessionId = third.session.sessionManager.getSessionId();
    await third.session.prompt(
      'This is a python task. Read src/input.py with the read tool only.',
      { expandPromptTemplates: false },
    );
    const pythonSystem = third.session.agent.state.messages[0] as unknown as {
      sections?: Record<string, string>;
    };
    const pythonGuidance = pythonSystem.sections?.['amos-workflow-guidance'] ?? '';
    if (!pythonGuidance.includes('live-python')) throw new Error('python_guidance_missing');
    third.session.dispose();

    const status = readRuntimeStatus(workspace, published);
    if (status.status !== 'loaded') throw new Error(`runtime_status_${status.status}`);
    const runtimeApi = await call('GET', `/api/projects/${project.id}/runtime`);
    if (runtimeApi.status !== 'loaded') {
      throw new Error(`runtime_http_status_${String(runtimeApi.status)}`);
    }
    const runtimeApiReport = runtimeApi.runtime as { activationDigest?: unknown } | null;
    if (runtimeApiReport?.activationDigest !== activation.activationDigest) {
      throw new Error('runtime_http_digest_mismatch');
    }

    const journalPath = join(
      governance.paths.dataDir,
      'managed-audit',
      `${project.id}.jsonl`,
    );
    if (!existsSync(journalPath)) throw new Error('journal_missing');
    const journal = readFileSync(journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const confirmAuthorization = journal.filter(
      (entry) =>
        entry.event === 'authorization' &&
        Array.isArray(entry.matchedRuleIds) &&
        entry.matchedRuleIds.includes('live-confirm'),
    );
    const denyAuthorization = journal.filter(
      (entry) =>
        entry.event === 'authorization' &&
        Array.isArray(entry.matchedRuleIds) &&
        entry.matchedRuleIds.includes('live-deny'),
    );
    if (confirmAuthorization.length !== 1 || confirmAuthorization[0]?.decision !== 'allow') {
      throw new Error('confirm_authorization_not_single');
    }
    if (denyAuthorization.length < 1 || denyAuthorization.some((entry) => entry.decision !== 'deny')) {
      throw new Error('deny_authorization_missing');
    }

    const confirm = confirmAuthorization[0];
    if (confirm === undefined) throw new Error('confirm_authorization_missing');
    const requirementVersion = confirm.requirementVersion;
    if (
      typeof requirementVersion !== 'number' ||
      !Number.isSafeInteger(requirementVersion) ||
      requirementVersion < 1
    ) {
      throw new Error('requirement_version_missing');
    }
    const requirementDigest = confirm.requirementDigest;
    if (
      typeof requirementDigest !== 'string' ||
      !DIGEST_PATTERN.test(requirementDigest)
    ) {
      throw new Error('requirement_digest_missing');
    }

    const reviewBlock = confirm.review;
    if (!isRecord(reviewBlock)) throw new Error('review_block_missing');
    const reviewModel = reviewBlock.model;
    const reviewQuestionVersion = reviewBlock.questionVersion;
    const reviewResultCode = reviewBlock.resultCode;
    if (
      typeof reviewModel !== 'string' ||
      reviewModel.length === 0 ||
      typeof reviewQuestionVersion !== 'string' ||
      reviewQuestionVersion.length === 0 ||
      typeof reviewResultCode !== 'string' ||
      reviewResultCode.length === 0
    ) {
      throw new Error('review_block_invalid');
    }
    if (reviewModel !== review.policy.model) {
      throw new Error('review_model_mismatch');
    }
    if (reviewQuestionVersion !== review.policy.questionVersion) {
      throw new Error('review_question_version_mismatch');
    }
    if (reviewBlock.policyDigest !== review.policy.policyDigest) {
      throw new Error('review_policy_binding_mismatch');
    }
    if (reviewBlock.requirementDigest !== requirementDigest) {
      throw new Error('review_requirement_binding_mismatch');
    }
    if (reviewResultCode !== 'approved') {
      throw new Error('review_result_not_approved');
    }

    const requirementRegistry = assertRequirementRegistry(project.id, [
      firstSessionId,
      secondSessionId,
      thirdSessionId,
    ]);

    const evidence = {
      root,
      workspace,
      projectId: project.id,
      version: published.version,
      activationDigest: activation.activationDigest,
      runtimeStatus: status.status,
      runtimeHttpStatus: runtimeApi.status,
      guidanceDigestPresent: guidance.includes(activation.activationDigest),
      confirmedBytes: Buffer.byteLength(confirmed),
      denyBlocked: !existsSync(join(workspace, 'src', 'deny.txt')),
      review: {
        model: reviewModel,
        questionVersion: reviewQuestionVersion,
        resultCode: reviewResultCode,
      },
      requirement: {
        version: requirementVersion,
        digest: requirementDigest,
        activeSessions: requirementRegistry.activeSessions,
        revisions: requirementRegistry.revisions,
      },
      journalAuthorizationCount: journal.filter((entry) => entry.event === 'authorization').length,
      model: MODEL,
    };
    writeFileSync(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  } finally {
    await governance.close();
  }
}

const invoked = process.argv[1];
if (typeof invoked === 'string' && invoked.endsWith('live-probe.js')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(message)
        ? message
        : 'unexpected_error';
      console.error(`live probe failed: ${code}`);
      process.exitCode = 1;
    },
  );
}
