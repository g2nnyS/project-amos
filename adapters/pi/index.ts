import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  UserBashEvent,
} from '@earendil-works/pi-coding-agent';

import {
  loadJevConfig,
  type JevConfigLoadOptions,
  type LoadedJevConfig,
} from '../../decision/config.ts';
import { renderGuidance } from '../../guidance/render.ts';
import { selectGuidance } from '../../guidance/select.ts';
import type {
  GuidanceInput,
  GuidancePack,
  GuidanceSelection,
} from '../../guidance/types.ts';
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
import {
  normalizePiToolCall,
  normalizePiUserBash,
} from './normalize.ts';

export interface PiAtmosConfig {
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
export const WORKFLOW_GUIDANCE_SECTION = 'atmos-workflow-guidance';
export const WORKFLOW_REVIEW_CUSTOM_TYPE = 'atmos-workflow-review';

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
 * Read `.pi/atmos.json` relative to the explicit Pi session directory.
 *
 * Returns null for every invalid shape so callers can degrade to a no-op
 * recorder without letting configuration errors reach a tool call.
 */
export function readPiConfig(directory: string): PiAtmosConfig | null {
  if (!isNonBlankString(directory) || !isAbsolute(directory)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, '.pi', 'atmos.json'), 'utf8'));
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
 * Read only the optional `workflowGate` field from `.pi/atmos.json`.
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

  const configPath = join(directory, '.pi', 'atmos.json');
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
  selectGuidance(input?: GuidanceInput | null): GuidanceSelection;
  renderGuidance(packs: readonly GuidancePack[]): string;
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
    selectGuidance,
    renderGuidance,
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

/**
 * Pi log-only extension plus an optional engineering workflow gate.
 *
 * The security audit path is unchanged. The workflow gate is enabled only by
 * the separate `workflowGate` field in `.pi/atmos.json`; when it is absent or
 * disabled this adapter records and returns exactly as before.
 */
export default function atmosPiLogOnly(
  pi: ExtensionAPI,
  overrides?: PiWorkflowOverrides,
): void {
  const dependencies: PiWorkflowDependencies = {
    ...createDefaultDependencies(pi),
    ...(overrides ?? {}),
  };

  const recorders = new Map<string, LogOnlyRecorder>();
  const selectedGuidance = new Map<string, readonly GuidancePack[]>();
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
      'Atmos Pi adapter: configuration error; constraint logging is disabled until the configuration is repaired.',
    );
  }

  function reportAuditErrorOnce(): void {
    if (auditErrorLogged) {
      return;
    }
    auditErrorLogged = true;
    console.error(
      'Atmos Pi adapter: audit write failed; the tool call was not blocked.',
    );
  }

  function reportWorkflowConfigErrorOnce(): void {
    if (workflowConfigErrorLogged) {
      return;
    }
    workflowConfigErrorLogged = true;
    console.error(
      'Atmos Pi adapter: workflow gate configuration error; workflow shell actions stay blocked until the configuration is repaired.',
    );
  }

  function ensureRecorder(directory: string): LogOnlyRecorder | null {
    // Do not cache configuration failures: a user may repair .pi/atmos.json
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

  function recordToolCall(event: ToolCallEvent, ctx: ExtensionContext): void {
    const now = Date.now();
    const started = performance.now();
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder !== null) {
        recorder.record(normalizePiToolCall(event, ctx.cwd), now, started);
      }
    } catch {
      try {
        // Unexpected normalization/recording failures still leave an audit
        // trail. Configuration failures have no recorder and stay silent.
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.record(
            {
              kind: 'error',
              error: 'engine_error',
              action: {
                tool: fallbackToolName(event),
                operation: 'unknown',
                target: 'unknown',
              },
            },
            now,
            started,
          );
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
    return `Atmos workflow gate: this shell command requires confirmation.\n\n${command}`;
  }

  async function decideShell(
    command: string | null,
    dialect: ShellDialect,
    ctx: ExtensionContext,
  ): Promise<GateDecision> {
    const state = readPiWorkflowGateState(ctx.cwd);
    if (state.status === 'absent') {
      return ALLOW;
    }
    if (state.status === 'error' || state.config === null) {
      reportWorkflowConfigErrorOnce();
      return block(WORKFLOW_CONFIG_ERROR);
    }
    if (!state.config.shellGate) {
      return ALLOW;
    }
    if (command === null) {
      return block(WORKFLOW_SHELL_DENIED);
    }

    let settings: PiShellSettings;
    try {
      settings = dependencies.getSettings();
    } catch {
      reportWorkflowConfigErrorOnce();
      return block(WORKFLOW_CONFIG_ERROR);
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
      return block(WORKFLOW_CONFIG_ERROR);
    }

    if (assessment.verdict === 'deny') {
      return block(WORKFLOW_SHELL_DENIED);
    }
    if (assessment.verdict !== 'confirm') {
      return ALLOW;
    }

    let confirmed = false;
    try {
      confirmed =
        ctx.hasUI === true &&
        (await ctx.ui.confirm(
          'Atmos workflow gate',
          confirmationMessage(command),
        )) === true;
    } catch {
      confirmed = false;
    }
    return confirmed
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
            'Atmos workflow review: repair cycle already used; manual review is required.',
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

    const guidance =
      selectedGuidance.get(sessionKey(ctx)) ??
      dependencies.selectGuidance().packs;

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

  pi.on('session_start', (_event, ctx) => {
    try {
      ensureRecorder(ctx.cwd);
    } catch {
      // Initialization is best-effort; tool hooks retry ensure if needed.
    }
  });

  pi.on('before_agent_start', (event, ctx) => {
    try {
      if (event.messageType !== 'user') {
        return undefined;
      }

      const state = readPiWorkflowGateState(ctx.cwd);
      if (state.status === 'error') {
        reportWorkflowConfigErrorOnce();
        return undefined;
      }
      if (
        state.status !== 'enabled' ||
        state.config === null ||
        !state.config.guidance
      ) {
        return undefined;
      }

      const selection = dependencies.selectGuidance({ prompt: event.prompt });
      const rendered = dependencies.renderGuidance(selection.packs);
      if (typeof rendered !== 'string' || rendered.length === 0) {
        return undefined;
      }

      const sections = event.systemPromptOptions?.sections;
      if (isRecord(sections)) {
        // A namespaced entry leaves every other section untouched.
        sections[WORKFLOW_GUIDANCE_SECTION] = rendered;
        selectedGuidance.set(sessionKey(ctx), selection.packs);
      }
    } catch {
      // Guidance is advisory and must never echo the prompt or block the run.
    }
    return undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    recordToolCall(event, ctx);

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

    const decision = await decideShell(command, 'bash', ctx);
    if (decision.action === 'block') {
      // Pi has no first-class block result for user_bash, so a fixed-code
      // error is the only non-leaking way to stop local execution.
      throw new Error(decision.code);
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
    'Atmos workflow review: completion is held for one local repair cycle.',
    'This feedback is advisory and is not an approval or a security verdict.',
    ...safeIssues,
    'Address the findings, then finish the run again.',
  ].join('\n');
}
