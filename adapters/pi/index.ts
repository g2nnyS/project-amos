import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
  UserBashEvent,
} from '@earendil-works/pi-coding-agent';

import {
  buildJevAssessmentAudit,
  buildUserLiteralGrantAudit,
} from '../../decision/audit.ts';
import {
  combineWithAssessment,
  type CombinedAssessmentResult,
} from '../../decision/combine.ts';
import {
  loadJevConfig,
  type JevConfigLoadOptions,
  type LoadedJevConfig,
} from '../../decision/config.ts';
import {
  applyUserLiteralGrant,
  type UserLiteralGrant,
} from '../../decision/grant.ts';
import type { RequirementFrame } from '../../decision/requirement.ts';
import { createRequirementSessionStore } from '../../decision/session.ts';
import type { AssessmentContext } from '../../decision/types.ts';
import {
  createInjectorSession,
  getProjectSeedSnapshot,
  guidancePacksForRuleIds,
  type InjectionBlock,
  type InjectorSession,
} from '../../injector/index.ts';
import {
  createChangeReview,
  type ChangeReviewOptions,
  type ChangeReviewResult,
} from '../../workflow/change-review.ts';
import {
  parseWorkflowGateConfig,
  type WorkflowGateConfig,
} from '../../workflow/config.ts';
import {
  reviewEngineeringChange,
  type EngineeringReviewInput,
  type EngineeringReviewResult,
} from '../../workflow/engineering-review.ts';
import {
  assessShellCommand,
  type AssessShellOptions,
  type ShellAssessment,
  type ShellDialect,
} from '../../workflow/shell.ts';
import {
  createLogOnlyRecorder,
  type LogOnlyRecorder,
} from '../shared/log-only.ts';
import type { ActionNormalization } from '../shared/types.ts';
import {
  normalizePiToolCall,
  normalizePiUserBash,
} from './normalize.ts';

export interface PiAmosConfig {
  mode: 'log-only';
  rulesPath: string;
  schemaPath: string;
  logPath: string;
}

/** Fixed, non-secret codes returned by the opt-in workflow gate. */
export const WORKFLOW_SHELL_DENIED = 'workflow_shell_denied';
export const WORKFLOW_SHELL_CONFIRMATION_REQUIRED =
  'workflow_shell_confirmation_required';
export const WORKFLOW_CONFIG_ERROR = 'workflow_config_error';

/** Namespaced system-prompt section and custom-message type. */
export const WORKFLOW_GUIDANCE_SECTION = 'amos-workflow-guidance';
export const WORKFLOW_REVIEW_CUSTOM_TYPE = 'amos-workflow-review';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read a tool name for the engine_error fallback without trusting getters. */
function fallbackToolName(event: unknown): string {
  try {
    if (isRecord(event)) {
      const tool = event.toolName;
      if (isNonBlankString(tool)) {
        return tool;
      }
    }
  } catch {
    // A throwing getter cannot contribute a tool name.
  }
  return 'unknown';
}

/**
 * Read `.pi/amos.json` relative to the explicit Pi session directory.
 *
 * Returns null for every invalid shape so callers can degrade to a no-op
 * recorder without letting configuration errors reach a tool call.
 */
export function readPiConfig(directory: string): PiAmosConfig | null {
  if (!isNonBlankString(directory) || !isAbsolute(directory)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, '.pi', 'amos.json'), 'utf8'));
  } catch {
    return null;
  }

  if (!isRecord(raw)) {
    return null;
  }
  if (raw.mode !== 'log-only') {
    return null;
  }

  const { rulesPath, schemaPath, logPath } = raw;
  if (
    !isNonBlankString(rulesPath) ||
    !isNonBlankString(schemaPath) ||
    !isNonBlankString(logPath)
  ) {
    return null;
  }

  return {
    mode: 'log-only',
    rulesPath: resolve(directory, rulesPath),
    schemaPath: resolve(directory, schemaPath),
    logPath: resolve(directory, logPath),
  };
}

export interface PiWorkflowGateState {
  readonly status: 'absent' | 'enabled' | 'error';
  readonly config: WorkflowGateConfig | null;
}

/**
 * Read only the optional `workflowGate` field from `.pi/amos.json`.
 *
 * A missing file, missing field, or explicit `enabled: false` is inert. A
 * present but malformed gate is reported as `error` so the caller can fail
 * closed without ever exposing the path, raw configuration, or secret values.
 */
export function readPiWorkflowGateState(
  directory: string,
): PiWorkflowGateState {
  if (!isNonBlankString(directory) || !isAbsolute(directory)) {
    return { status: 'absent', config: null };
  }

  const configPath = join(directory, '.pi', 'amos.json');
  if (!existsSync(configPath)) {
    return { status: 'absent', config: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    // An existing but unreadable/malformed configuration cannot prove that the
    // gate was disabled, so gated actions must fail closed.
    return { status: 'error', config: null };
  }

  if (
    !isRecord(raw) ||
    !Object.prototype.hasOwnProperty.call(raw, 'workflowGate')
  ) {
    return { status: 'absent', config: null };
  }

  try {
    const config = parseWorkflowGateConfig(raw.workflowGate, directory);
    if (config === null || !config.enabled) {
      return { status: 'absent', config: null };
    }
    return { status: 'enabled', config };
  } catch {
    return { status: 'error', config: null };
  }
}

export interface PiShellSettings {
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}

/**
 * Dependency seam for the opt-in workflow gate. Production uses the real
 * modules; tests can inject bounded fakes so no test invokes npm, Jev, or a
 * model. UI access still comes from Pi's `ctx`, which tests also supply.
 */
export interface PiWorkflowDependencies {
  /** Create one advisory injector session; production uses the seed snapshot. */
  createSession(): InjectorSession;
  assessShellCommand(
    command: string,
    options: AssessShellOptions,
  ): ShellAssessment;
  createChangeReview(options: ChangeReviewOptions): Promise<ChangeReviewResult>;
  loadJevConfig(
    path: string,
    options?: JevConfigLoadOptions,
  ): LoadedJevConfig;
  reviewEngineeringChange(
    input: EngineeringReviewInput,
  ): Promise<EngineeringReviewResult>;
  getSettings(): PiShellSettings;
}

export type PiWorkflowOverrides = Partial<PiWorkflowDependencies>;

type GateDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'block'; readonly code: string };

const ALLOW: GateDecision = { action: 'allow' };

function block(code: string): GateDecision {
  return { action: 'block', code };
}

function createDefaultDependencies(pi: ExtensionAPI): PiWorkflowDependencies {
  return {
    createSession: () => createInjectorSession(getProjectSeedSnapshot()),
    assessShellCommand,
    createChangeReview,
    loadJevConfig,
    reviewEngineeringChange,
    getSettings() {
      const settings = pi.getSettings();
      return {
        ...(typeof settings.shellPath === 'string'
          ? { shellPath: settings.shellPath }
          : {}),
        ...(typeof settings.shellCommandPrefix === 'string'
          ? { shellCommandPrefix: settings.shellCommandPrefix }
          : {}),
      };
    },
  };
}

const MAX_GUIDANCE_SESSIONS = 32;
const MAX_QUEUED_TOOL_CALLS = 256;
/** Bound the safe semantic context so compound commands stay reviewable. */
const MAX_ASSESSMENT_CONTEXT_OPERATIONS = 16;

interface GuidanceSessionState {
  readonly injector: InjectorSession;
  readonly committedRuleIds: Set<string>;
}

/**
 * Pi log-only extension plus an optional engineering workflow gate.
 *
 * The security audit path is unchanged. The workflow gate is enabled only by
 * the separate `workflowGate` field in `.pi/amos.json`; when it is absent or
 * disabled this adapter records and returns exactly as before.
 */
export default function amosPiLogOnly(
  pi: ExtensionAPI,
  overrides?: PiWorkflowOverrides,
): void {
  const dependencies: PiWorkflowDependencies = {
    ...createDefaultDependencies(pi),
    ...(overrides ?? {}),
  };

  const recorders = new Map<string, LogOnlyRecorder>();
  // One bounded, memory-only requirement capture per extension. Frames are
  // keyed by session and only ever created from the direct user prompt.
  const requirementStore = createRequirementSessionStore();
  const guidanceSessions = new Map<string, GuidanceSessionState>();
  const queuedToolCalls = new Map<string, string>();
  const repairContinuedSessions = new Set<string>();
  const reviewedCompletionDigests = new Map<string, string>();
  let configErrorLogged = false;
  let auditErrorLogged = false;
  let workflowConfigErrorLogged = false;

  function reportConfigErrorOnce(): void {
    if (configErrorLogged) {
      return;
    }
    configErrorLogged = true;
    console.error(
      'Amos Pi adapter: configuration error; constraint logging is disabled until the configuration is repaired.',
    );
  }

  function reportAuditErrorOnce(): void {
    if (auditErrorLogged) {
      return;
    }
    auditErrorLogged = true;
    console.error(
      'Amos Pi adapter: audit write failed; the tool call was not blocked.',
    );
  }

  function reportWorkflowConfigErrorOnce(): void {
    if (workflowConfigErrorLogged) {
      return;
    }
    workflowConfigErrorLogged = true;
    console.error(
      'Amos Pi adapter: workflow gate configuration error; workflow shell actions stay blocked until the configuration is repaired.',
    );
  }

  function ensureRecorder(directory: string): LogOnlyRecorder | null {
    // Do not cache configuration failures: a user may repair .pi/amos.json
    // during the session. The diagnostic is still emitted once per process.
    const existing = recorders.get(directory);
    if (existing !== undefined) {
      return existing;
    }

    const config = readPiConfig(directory);
    if (config === null) {
      reportConfigErrorOnce();
      return null;
    }

    try {
      const recorder = createLogOnlyRecorder({
        rulesPath: config.rulesPath,
        schemaPath: config.schemaPath,
        logPath: config.logPath,
        sessionWorkspace: directory,
        onDiagnostic: reportAuditErrorOnce,
      });
      recorders.set(directory, recorder);
      return recorder;
    } catch {
      reportConfigErrorOnce();
      return null;
    }
  }

  function forgetQueuedCalls(key: string): void {
    for (const [composite, owner] of queuedToolCalls) {
      if (owner === key) {
        queuedToolCalls.delete(composite);
      }
    }
  }

  /**
   * Queue keys include the session because Pi call IDs are only unique within
   * a session. The length prefix keeps the pair encoding unambiguous.
   */
  function queuedCallKey(key: string, toolCallId: string): string {
    return `${key.length}:${key}${toolCallId}`;
  }

  function rememberGuidanceSession(
    key: string,
    state: GuidanceSessionState,
  ): GuidanceSessionState {
    guidanceSessions.delete(key);
    guidanceSessions.set(key, state);
    while (guidanceSessions.size > MAX_GUIDANCE_SESSIONS) {
      const oldest = guidanceSessions.keys().next().value;
      if (oldest === undefined || oldest === key) {
        break;
      }
      guidanceSessions.delete(oldest);
      forgetQueuedCalls(oldest);
    }
    return state;
  }

  /** One advisory injector session per real session key. */
  function guidanceSession(key: string): GuidanceSessionState {
    const existing = guidanceSessions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    return rememberGuidanceSession(key, {
      injector: dependencies.createSession(),
      committedRuleIds: new Set<string>(),
    });
  }

  function commitGuidance(
    state: GuidanceSessionState,
    block: InjectionBlock,
  ): void {
    state.injector.commit(block);
    for (const id of block.ruleIds) {
      state.committedRuleIds.add(id);
    }
  }

  function rememberQueuedCall(key: string, toolCallId: string): void {
    const composite = queuedCallKey(key, toolCallId);
    queuedToolCalls.delete(composite);
    queuedToolCalls.set(composite, key);
    while (queuedToolCalls.size > MAX_QUEUED_TOOL_CALLS) {
      const oldest = queuedToolCalls.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      queuedToolCalls.delete(oldest);
    }
  }

  function guidanceIsEnabled(ctx: ExtensionContext): boolean {
    const state = readPiWorkflowGateState(ctx.cwd);
    if (state.status === 'error') {
      reportWorkflowConfigErrorOnce();
      return false;
    }
    return (
      state.status === 'enabled' &&
      state.config !== null &&
      state.config.guidance
    );
  }

  /**
   * Advisory area queueing runs in its own guard: no injector failure may
   * affect the audit record or a shell gate decision.
   */
  function queueAdvisory(
    normalized: ActionNormalization | null,
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): void {
    try {
      if (normalized === null || normalized.kind !== 'action') {
        return;
      }
      const { tool, operation, target } = normalized.action;
      const normalizedTool = tool.toLowerCase();
      if (
        operation !== 'file_write' ||
        (normalizedTool !== 'write' &&
          normalizedTool !== 'edit' &&
          normalizedTool !== 'file_write')
      ) {
        return;
      }
      if (!guidanceIsEnabled(ctx)) {
        return;
      }

      const toolCallId = readToolCallId(event);
      if (toolCallId === null) {
        return;
      }
      const key = sessionKey(ctx);
      const state = guidanceSession(key);
      if (state.injector.queueAction({ tool, operation, target }, ctx.cwd)) {
        rememberQueuedCall(key, toolCallId);
      }
    } catch {
      // Advisory only: a throw must not change recording or the shell decision.
    }
  }

  function recordToolCall(
    normalized: ActionNormalization | null,
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): void {
    const now = Date.now();
    const started = performance.now();
    const fallback: ActionNormalization = {
      kind: 'error',
      error: 'engine_error',
      action: {
        tool: fallbackToolName(event),
        operation: 'unknown',
        target: 'unknown',
      },
    };
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder !== null) {
        recorder.record(normalized ?? fallback, now, started);
      }
    } catch {
      try {
        // Unexpected normalization/recording failures still leave an audit
        // trail. Configuration failures have no recorder and stay silent.
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.record(fallback, now, started);
        }
      } catch {
        // Pi blocks a tool call when a hook throws. Log-only stays passive.
      }
    }
  }

  function recordUserBash(event: UserBashEvent, ctx: ExtensionContext): void {
    const now = Date.now();
    const started = performance.now();
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder !== null) {
        recorder.record(normalizePiUserBash(event, ctx.cwd), now, started);
      }
    } catch {
      try {
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.record(
            {
              kind: 'error',
              error: 'engine_error',
              action: {
                tool: 'user_bash',
                operation: 'unknown',
                target: 'unknown',
              },
            },
            now,
            started,
          );
        }
      } catch {
        // A user shell must run exactly as it would without this extension.
      }
    }
  }

  function sessionKey(ctx: ExtensionContext): string {
    try {
      const id = ctx.sessionManager?.getSessionId();
      if (isNonBlankString(id)) {
        return id;
      }
    } catch {
      // Fall back to the session workspace below.
    }
    return ctx.cwd;
  }

  function readToolCallId(event: unknown): string | null {
    try {
      if (isRecord(event) && isNonBlankString(event.toolCallId)) {
        return event.toolCallId;
      }
    } catch {
      // A throwing getter cannot identify a queued call.
    }
    return null;
  }

  function readCommand(event: unknown): string | null {
    try {
      if (!isRecord(event) || !isRecord(event.input)) {
        return null;
      }
      const command = event.input.command;
      return typeof command === 'string' && command.length > 0
        ? command
        : null;
    } catch {
      return null;
    }
  }

  function confirmationMessage(command: string): string {
    // The raw command is intentionally confined to this interactive prompt.
    return `Amos workflow gate: this shell command requires confirmation.\n\n${command}`;
  }

  type ShellGateEvaluation =
    | { readonly outcome: 'allow' }
    | { readonly outcome: 'block'; readonly code: string }
    | {
        readonly outcome: 'assessed';
        readonly config: WorkflowGateConfig;
        readonly assessment: ShellAssessment;
      };

  /**
   * Deterministic part of the shell gate. Returns the assessed plan (or an
   * ordinary allow/block) without any confirmation prompt or semantic
   * assessment, so the direct-user literal path can reuse it.
   */
  async function evaluateShellGate(
    command: string | null,
    dialect: ShellDialect,
    ctx: ExtensionContext,
  ): Promise<ShellGateEvaluation> {
    const state = readPiWorkflowGateState(ctx.cwd);
    if (state.status === 'absent') {
      return { outcome: 'allow' };
    }
    if (state.status === 'error' || state.config === null) {
      reportWorkflowConfigErrorOnce();
      return { outcome: 'block', code: WORKFLOW_CONFIG_ERROR };
    }
    if (!state.config.shellGate) {
      return { outcome: 'allow' };
    }
    if (command === null) {
      return { outcome: 'block', code: WORKFLOW_SHELL_DENIED };
    }

    let settings: PiShellSettings;
    try {
      settings = dependencies.getSettings();
    } catch {
      reportWorkflowConfigErrorOnce();
      return { outcome: 'block', code: WORKFLOW_CONFIG_ERROR };
    }

    let assessment: ShellAssessment;
    try {
      assessment = dependencies.assessShellCommand(command, {
        cwd: ctx.cwd,
        dialect,
        ...(settings.shellPath === undefined
          ? {}
          : { shellPath: settings.shellPath }),
        ...(settings.shellCommandPrefix === undefined
          ? {}
          : { commandPrefix: settings.shellCommandPrefix }),
      });
    } catch {
      reportWorkflowConfigErrorOnce();
      return { outcome: 'block', code: WORKFLOW_CONFIG_ERROR };
    }

    return { outcome: 'assessed', config: state.config, assessment };
  }

  async function confirmShell(
    command: string,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    try {
      return (
        ctx.hasUI === true &&
        (await ctx.ui.confirm(
          'Amos workflow gate',
          confirmationMessage(command),
        )) === true
      );
    } catch {
      return false;
    }
  }

  function sessionRequirement(
    ctx: ExtensionContext,
  ): RequirementFrame | null {
    try {
      return requirementStore.current(sessionKey(ctx));
    } catch {
      return null;
    }
  }

  function modelAction(dialect: ShellDialect) {
    return {
      tool: dialect,
      operation: 'shell_input',
      target: 'unknown',
    };
  }

  /**
   * Safe semantic context: only the assessment classification and bounded
   * canonical operation descriptors. Raw command text, arguments, redirect
   * targets, prompt text, file contents, and credentials never enter here.
   */
  function modelActionContext(
    assessment: ShellAssessment,
  ): AssessmentContext {
    const source = assessment.operations.slice(
      0,
      MAX_ASSESSMENT_CONTEXT_OPERATIONS,
    );
    const operations = source.map((operation) => ({
      program: operation.program,
      effect: operation.effect,
      reason: operation.reason,
    }));

    // Keep a compact summary of the strictest operation for simple readers.
    let strictest: (typeof source)[number] | undefined;
    let strictestRank = -1;
    for (const operation of source) {
      const rank = operationVerdictRank(operation.verdict);
      if (rank > strictestRank) {
        strictest = operation;
        strictestRank = rank;
      }
    }

    return {
      assessment: {
        kind: assessment.kind,
        reason: assessment.reason,
      },
      operation:
        strictest === undefined
          ? { program: 'unknown', effect: 'unknown' }
          : { program: strictest.program, effect: strictest.effect },
      operations,
    };
  }

  function operationVerdictRank(
    verdict: ShellAssessment['verdict'],
  ): number {
    return verdict === 'deny' ? 2 : verdict === 'confirm' ? 1 : 0;
  }

  /** Best-effort provenance entry; never changes the gate decision. */
  function recordActionAssessment(
    ctx: ExtensionContext,
    dialect: ShellDialect,
    shellAssessment: ShellAssessment,
    result: CombinedAssessmentResult,
    requirement: RequirementFrame | null,
    assessmentRequired?: boolean,
  ): void {
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder === null) {
        return;
      }
      recorder.recordAssessment(
        modelAction(dialect),
        buildJevAssessmentAudit({
          requirement,
          shellAssessment,
          result,
          assessmentRequired,
        }),
      );
    } catch {
      // Audit is a separate best-effort path.
    }
  }

  /**
   * Optional Jev sensor for a model-authored shell action.
   *
   * The provider is only called when a current requirement frame exists, and
   * its facts must be bound to that exact frame. Required assessments fail
   * closed on every missing frame, configuration, provider, or egress error.
   */
  async function assessModelAction(
    shellAssessment: ShellAssessment,
    config: WorkflowGateConfig,
    dialect: ShellDialect,
    ctx: ExtensionContext,
  ): Promise<ShellAssessment['verdict']> {
    const requirement = sessionRequirement(ctx);

    let loaded: LoadedJevConfig;
    try {
      if (config.jevConfigPath === null) {
        throw new Error('workflow_config_error');
      }
      loaded = dependencies.loadJevConfig(config.jevConfigPath);
    } catch {
      recordActionAssessment(
        ctx,
        dialect,
        shellAssessment,
        { verdict: 'deny', error: 'assessment_failed' },
        requirement,
      );
      return 'deny';
    }

    if (requirement === null) {
      const verdict = loaded.config.assessmentRequired
        ? 'deny'
        : shellAssessment.verdict;
      // No error/facts: the builder records `requirement_unavailable`.
      recordActionAssessment(
        ctx,
        dialect,
        shellAssessment,
        { verdict },
        null,
        loaded.config.assessmentRequired,
      );
      return verdict;
    }

    const result = await combineWithAssessment({
      deterministic: shellAssessment.verdict,
      provider: loaded.assessmentProvider,
      action: modelAction(dialect),
      context: modelActionContext(shellAssessment),
      requirement,
      policy: loaded.config.policy,
      assessmentRequired: loaded.config.assessmentRequired,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    recordActionAssessment(
      ctx,
      dialect,
      shellAssessment,
      result,
      requirement,
      loaded.config.assessmentRequired,
    );

    // `log` is non-blocking and only reachable from a malformed combination;
    // treat it as allow in the shell vocabulary.
    return result.verdict === 'log' ? 'allow' : result.verdict;
  }

  async function decideShell(
    command: string | null,
    dialect: ShellDialect,
    ctx: ExtensionContext,
  ): Promise<GateDecision> {
    const gate = await evaluateShellGate(command, dialect, ctx);
    if (gate.outcome === 'allow') {
      return ALLOW;
    }
    if (gate.outcome === 'block') {
      return block(gate.code);
    }

    const { config, assessment } = gate;
    if (assessment.verdict === 'deny') {
      return block(WORKFLOW_SHELL_DENIED);
    }

    let verdict: ShellAssessment['verdict'] = assessment.verdict;
    if (config.actionAssessment && assessment.kind === 'plan') {
      verdict = await assessModelAction(assessment, config, dialect, ctx);
    }

    if (verdict === 'deny') {
      return block(WORKFLOW_SHELL_DENIED);
    }
    if (verdict !== 'confirm') {
      return ALLOW;
    }
    return (await confirmShell(command ?? '', ctx))
      ? ALLOW
      : block(WORKFLOW_SHELL_CONFIRMATION_REQUIRED);
  }

  function requestReviewContinuation(
    ctx: ExtensionContext,
    issues: readonly string[],
  ): AgentBeforeSettleEventResult | undefined {
    const key = sessionKey(ctx);
    if (repairContinuedSessions.has(key)) {
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(
            'Amos workflow review: repair cycle already used; manual review is required.',
            'warning',
          );
        }
      } catch {
        // Notification is best effort. No additional continuation is allowed.
      }
      return undefined;
    }
    repairContinuedSessions.add(key);

    const feedback = buildReviewFeedback(issues);
    return {
      entries: [
        {
          type: 'custom_message',
          customType: WORKFLOW_REVIEW_CUSTOM_TYPE,
          content: feedback,
          display: false,
        },
      ],
      continue: true,
    };
  }

  async function evaluateCompletion(
    ctx: ExtensionContext,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const state = readPiWorkflowGateState(ctx.cwd);
    if (state.status === 'absent') {
      return undefined;
    }
    if (state.status === 'error' || state.config === null) {
      reportWorkflowConfigErrorOnce();
      return requestReviewContinuation(ctx, ['workflow_configuration_error']);
    }
    if (!state.config.completionReview) {
      return undefined;
    }

    let review: ChangeReviewResult;
    try {
      review = await dependencies.createChangeReview({
        cwd: ctx.cwd,
        runChecks: true,
      });
    } catch {
      return requestReviewContinuation(ctx, ['change_review_unavailable']);
    }

    const session = sessionKey(ctx);
    if (reviewedCompletionDigests.get(session) === review.digest) {
      return undefined;
    }
    reviewedCompletionDigests.set(session, review.digest);

    const issues: string[] = [];
    for (const check of Array.isArray(review.checks) ? review.checks : []) {
      if (check.ok !== true) {
        issues.push(`local_check_failed: ${check.id}`);
      }
    }

    if (issues.length === 0) {
      if (review.egress.reason === 'no_changes') {
        return undefined;
      }
      if (review.egress.eligible !== true) {
        issues.push(`change_review_ineligible: ${review.egress.reason}`);
      } else {
        await appendEngineeringIssues(ctx, review, state.config, issues);
      }
    }

    if (issues.length === 0) {
      return undefined;
    }
    return requestReviewContinuation(ctx, issues);
  }

  /**
   * Jev still consumes guidance packs. Convert the committed injected rule IDs
   * for this session only; no second selection path exists.
   */
  function reviewGuidance(ctx: ExtensionContext) {
    try {
      const state = guidanceSessions.get(sessionKey(ctx));
      if (state === undefined) {
        return guidancePacksForRuleIds([]);
      }
      return guidancePacksForRuleIds([...state.committedRuleIds]);
    } catch {
      return guidancePacksForRuleIds([]);
    }
  }

  async function appendEngineeringIssues(
    ctx: ExtensionContext,
    review: ChangeReviewResult,
    config: WorkflowGateConfig,
    issues: string[],
  ): Promise<void> {
    if (config.jevConfigPath === null) {
      issues.push('engineering_review_error: config');
      return;
    }

    let loaded: LoadedJevConfig;
    try {
      loaded = dependencies.loadJevConfig(config.jevConfigPath);
    } catch {
      // A load failure must hold for review; it is not a pass.
      issues.push('engineering_review_error: config');
      return;
    }

    const guidance = reviewGuidance(ctx);

    let result: EngineeringReviewResult;
    try {
      result = await dependencies.reviewEngineeringChange({
        client: loaded.systemOneClient,
        diff: review.egress,
        guidance,
        policy: loaded.config.policy,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch {
      issues.push('engineering_review_error: assessment_failed');
      return;
    }

    if (result.status !== 'pass') {
      issues.push(`engineering_review_${result.status}: ${result.reason}`);
    }
  }

  pi.on('session_start', (event, ctx) => {
    try {
      ensureRecorder(ctx.cwd);
    } catch {
      // Initialization is best-effort; tool hooks retry ensure if needed.
    }
    try {
      // Only a genuinely new session resets advisory state. A reload or resume
      // keeps the existing injector session for this key when one exists.
      if (!isRecord(event) || event.reason !== 'new') {
        return;
      }
      const key = sessionKey(ctx);
      guidanceSessions.delete(key);
      forgetQueuedCalls(key);
      requirementStore.clear(key);
    } catch {
      // A failed reset leaves the previous advisory state in place.
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      if (event.messageType !== 'user') {
        // Custom-message runs are never touched by this extension.
        return undefined;
      }

      const rawSections = event.systemPromptOptions?.sections;
      const sections = isRecord(rawSections) ? rawSections : null;
      const removeSection = (): void => {
        if (sections !== null) {
          delete sections[WORKFLOW_GUIDANCE_SECTION];
        }
      };

      const state = readPiWorkflowGateState(ctx.cwd);
      if (state.status === 'error') {
        reportWorkflowConfigErrorOnce();
      }

      // Capture the direct user turn before any advisory selection. Only a
      // real user message creates a frame; invalid or oversized turns drop the
      // old one so it can never be reused for a later action.
      const key = sessionKey(ctx);
      const actionAssessmentConfig =
        state.status === 'enabled' &&
        state.config !== null &&
        state.config.actionAssessment
          ? state.config
          : null;
      if (actionAssessmentConfig === null) {
        requirementStore.clear(key);
      } else {
        try {
          requirementStore.captureUserMessage(
            key,
            typeof event.prompt === 'string' ? event.prompt : '',
            actionAssessmentConfig.requirementEgress,
          );
        } catch {
          requirementStore.clear(key);
        }
      }

      if (
        state.status !== 'enabled' ||
        state.config === null ||
        !state.config.guidance
      ) {
        removeSection();
        return undefined;
      }

      const guidance = guidanceSession(key);
      const block = guidance.injector.selectPrompt(
        typeof event.prompt === 'string' ? event.prompt : '',
      );
      if (block.text.length === 0 || sections === null) {
        // No new text: remove only our stale namespaced section.
        removeSection();
        return undefined;
      }

      // Overwrite only this namespaced entry, then commit only if the write
      // actually landed. Every other section and custom message stays as is.
      sections[WORKFLOW_GUIDANCE_SECTION] = block.text;
      if (sections[WORKFLOW_GUIDANCE_SECTION] !== block.text) {
        return undefined;
      }
      commitGuidance(guidance, block);
    } catch {
      // Guidance is advisory and must never echo the prompt or block the run.
    }
    return undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    // Normalize once and reuse the result for the audit record and advisory
    // queue. A normalization failure still produces the engine_error record.
    let normalized: ActionNormalization | null = null;
    try {
      normalized = normalizePiToolCall(event, ctx.cwd);
    } catch {
      normalized = null;
    }

    recordToolCall(normalized, event, ctx);
    queueAdvisory(normalized, event, ctx);

    const tool = fallbackToolName(event);
    if (tool !== 'bash' && tool !== 'powershell') {
      return undefined;
    }

    const decision = await decideShell(
      readCommand(event),
      tool === 'powershell' ? 'powershell' : 'bash',
      ctx,
    );
    return decision.action === 'block'
      ? { block: true, reason: decision.code }
      : undefined;
  });

  pi.on('tool_result', (event: ToolResultEvent, ctx: ExtensionContext) => {
    try {
      const toolCallId = readToolCallId(event);
      if (toolCallId === null) {
        return undefined;
      }
      const key = sessionKey(ctx);
      const composite = queuedCallKey(key, toolCallId);
      const owner = queuedToolCalls.get(composite);
      if (owner === undefined) {
        return undefined;
      }
      queuedToolCalls.delete(composite);
      // The composite key already binds the session; keep the identity check
      // as a defensive guard before touching that session's injector state.
      if (owner !== key) {
        return undefined;
      }

      const state = guidanceSessions.get(owner);
      if (state === undefined) {
        return undefined;
      }

      const block = state.injector.selectPendingArea();
      if (block === null) {
        return undefined;
      }
      if (block.text.length === 0 || block.ruleIds.length === 0) {
        // Retire an empty area block without emitting anything. Committing it
        // marks the area injected so it is never selected again.
        commitGuidance(state, block);
        return undefined;
      }

      const content = event.content;
      if (!Array.isArray(content)) {
        return undefined;
      }
      // Append one independent text block; every existing block is untouched.
      const appended = [
        ...content,
        { type: 'text' as const, text: block.text },
      ];
      const result: ToolResultEventResult = { content: appended };
      // Returning only `content` would drop structured content in Pi.
      if (event.structuredContent !== undefined) {
        result.structuredContent = event.structuredContent;
      }

      // Commit only after the appended result is fully formed.
      commitGuidance(state, block);
      return result;
    } catch {
      // Advisory injection never changes the tool result or a gate verdict.
      return undefined;
    }
  });

  pi.on('user_bash', async (event, ctx) => {
    recordUserBash(event, ctx);

    let command: string | null = null;
    try {
      command = isRecord(event) && isNonBlankString(event.command)
        ? event.command
        : null;
    } catch {
      command = null;
    }

    const gate = await evaluateShellGate(command, 'bash', ctx);
    if (gate.outcome === 'allow') {
      return undefined;
    }
    if (gate.outcome === 'block') {
      // Pi has no first-class block result for user_bash, so a fixed-code
      // error is the only non-leaking way to stop local execution.
      throw new Error(gate.code);
    }

    const assessment = gate.assessment;
    if (assessment.verdict === 'deny') {
      throw new Error(WORKFLOW_SHELL_DENIED);
    }

    // Direct-user literal commands are a structural path: never Jev, and only
    // the command the human typed can bind to the freshly captured frame.
    const key = sessionKey(ctx);
    let grant: UserLiteralGrant | null = null;
    try {
      grant = requirementStore.captureUserLiteral(key, command ?? '').grant;
    } catch {
      // A failed literal capture must not leave an older prompt available for
      // a later model action.
      requirementStore.clear(key);
      grant = null;
    }

    if (grant !== null) {
      const finalVerdict = applyUserLiteralGrant(grant, assessment, key);
      try {
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.recordAssessment(
            { tool: 'user_bash', operation: 'shell_input', target: 'unknown' },
            buildUserLiteralGrantAudit({
              grant,
              shellAssessment: assessment,
              finalVerdict,
              requirement: sessionRequirement(ctx),
            }),
          );
        }
      } catch {
        // The grant is harness-captured; audit stays best effort.
      }

      if (finalVerdict === 'deny') {
        throw new Error(WORKFLOW_SHELL_DENIED);
      }
      // A valid literal grant resolves every non-deny verdict; no UI prompt.
      return undefined;
    }

    // Capture or binding failure falls back to ordinary confirmation behavior
    // without consulting any older frame.
    if (assessment.verdict === 'confirm') {
      const confirmed = await confirmShell(command ?? '', ctx);
      if (!confirmed) {
        throw new Error(WORKFLOW_SHELL_CONFIRMATION_REQUIRED);
      }
    }
    return undefined;
  });

  pi.on('agent_before_settle', async (event, ctx) => {
    if (!isRecord(event) || event.outcome !== 'completed') {
      return undefined;
    }

    try {
      return await evaluateCompletion(ctx);
    } catch {
      return requestReviewContinuation(ctx, ['workflow_review_internal_error']);
    }
  });
}

function buildReviewFeedback(issues: readonly string[]): string {
  const safeIssues = issues
    .filter((issue): issue is string => typeof issue === 'string')
    .slice(0, 8)
    .map((issue) => `- ${issue.slice(0, 120)}`);

  return [
    'Amos workflow review: completion is held for one local repair cycle.',
    'This feedback is advisory and is not an approval or a security verdict.',
    ...safeIssues,
    'Address the findings, then finish the run again.',
  ].join('\n');
}
