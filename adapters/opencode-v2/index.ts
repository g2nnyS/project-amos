import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AuditAction } from "../../storage/jsonl.ts";
import {
  parseWorkflowGateConfig,
  type WorkflowGateConfig,
} from "../../workflow/config.ts";
import {
  assessShellCommand,
  type AssessShellOptions,
  type ShellAssessment,
  type ShellVerdict,
} from "../../workflow/shell.ts";
import {
  createChangeReview,
  type ChangeReviewResult,
} from "../../workflow/change-review.ts";
import {
  reviewEngineeringChange,
  type EngineeringReviewInput,
  type EngineeringReviewResult,
} from "../../workflow/engineering-review.ts";
import { loadJevConfig, type LoadedJevConfig } from "../../decision/config.ts";
import {
  combineWithAssessment,
  type CombinedAssessmentResult,
} from "../../decision/combine.ts";
import { buildJevAssessmentAudit } from "../../decision/audit.ts";
import { createRequirementSessionStore } from "../../decision/session.ts";
import type { RequirementFrame } from "../../decision/requirement.ts";
import type { Verdict } from "../../engine/engine.ts";
import {
  createInjectorSession,
  getProjectSeedSnapshot,
  guidancePacksForRuleIds,
  type InjectionBlock,
  type InjectorSession,
} from "../../injector/index.ts";
import { createLogOnlyRecorder } from "../shared/log-only.ts";
import {
  loadActivationGuidance,
  loadActivationRuntime,
} from "../shared/activation-guidance.ts";
import { readHostProjection } from "../shared/host-projection.ts";
import {
  OPENCODE_MANAGED_CAPABILITIES,
  writeHarnessRuntimeReport,
} from "../shared/runtime-report.ts";
import type { ActivationRuntime } from "../../activation/runtime.ts";
import { createHarnessGate, type HarnessGate } from "../../managed/harness.ts";
import {
  createHttpReviewProvider,
  isValidPolicy,
  type CalibrationEvidence,
  type ReviewerPolicy,
} from "../../review/index.ts";
import {
  normalizeOpenCodeAction,
  type OpenCodeNormalization,
} from "./normalize.ts";

type ToolEvent = { tool?: unknown; input?: unknown; sessionID?: unknown; id?: unknown; status?: unknown };
type Registration = { dispose(): unknown | Promise<unknown> };

/**
 * Structural view of the OpenCode V2 2.1.4 promise plugin context.
 *
 * The adapter deliberately does not depend on `@opencode/plugin`: the package
 * is supplied by the host at runtime. Only the fields this plugin uses are
 * modelled here, and every optional domain is checked before registration so a
 * reduced host cannot silently disable the audit hook.
 */
type ShellCreateEvent = {
  command?: unknown;
  cwd?: unknown;
  timeout?: unknown;
  shell?: unknown;
  env?: unknown;
  /** Present on hosts that bind shell creation to a session. */
  sessionID?: unknown;
};

type PermissionEvent = {
  sessionID?: unknown;
  agent?: unknown;
  action?: unknown;
  resources?: unknown;
  metadata?: unknown;
  source?: unknown;
  effect?: unknown;
  message?: unknown;
};

type PromptEvent = {
  sessionID?: unknown;
  messageID?: unknown;
  prompt?: unknown;
  metadata?: unknown;
  delivery?: unknown;
};

type SystemPart = { type?: unknown; text?: unknown };

type ContextEvent = {
  sessionID?: unknown;
  model?: unknown;
  agent?: unknown;
  system?: SystemPart[];
  messages?: unknown;
  options?: unknown;
  tools?: unknown;
};

type InstructionEntry = {
  sessionID: string;
  key: string;
  value: string;
};

interface HookDomain<Events extends Record<string, unknown>> {
  hook<Name extends keyof Events & string>(
    name: Name,
    callback: (event: Events[Name]) => void | Promise<void>,
  ): Promise<Registration>;
}

interface SessionDomain {
  hook: {
    (
      name: "prompt",
      callback: (event: PromptEvent) => void | Promise<void>,
    ): Promise<Registration>;
    (
      name: "context",
      callback: (event: ContextEvent) => void | Promise<void>,
    ): Promise<Registration>;
  };
  instructions?: {
    entry?: {
      put?: (input: InstructionEntry) => Promise<unknown>;
    };
  };
}

type PluginContext = {
  location: { directory: string };
  options: Record<string, unknown>;
  tool: HookDomain<{ "execute.before": ToolEvent; "execute.after": ToolEvent }>;
  shell?: HookDomain<{ "create.before": ShellCreateEvent }>;
  permission?: HookDomain<{ evaluate: PermissionEvent }>;
  session?: SessionDomain;
};

type AuditConfig = {
  directory: string;
  rulesPath: string;
  schemaPath: string;
  logPath: string;
};

const WORKFLOW_GATE_SHELL_DENIED = "amos_workflow_gate_shell_denied";
const WORKFLOW_GATE_SHELL_CONFIRM_UNAVAILABLE =
  "amos_workflow_gate_shell_confirm_unavailable";
const WORKFLOW_GATE_TOOL_BLOCKED = "amos_workflow_gate_tool_blocked";
const WORKFLOW_GATE_CONFIG_ERROR = "amos_workflow_gate_config_error";

/**
 * Fixed code for an explicit `mode: "strict"` option. Strict mode requires the
 * separate controlled host entrypoint; setup rejects before registering any
 * hook so the ordinary observer plugin never runs unguarded.
 */
const AMOS_STRICT_REQUIRES_CONTROLLED_HOST =
  "amos_strict_requires_controlled_host";

const GUIDANCE_INSTRUCTION_KEY = "amos.workflow.guidance";
const MAX_GUIDANCE_SESSIONS = 64;
const MAX_REVIEWED_SESSIONS = 64;
const MAX_AREA_FLUSH = 64;
const MAX_SYSTEM_FEEDBACK_BYTES = 2 * 1024;
const MAX_RESOURCE_STRINGS = 8;

/** Tools that can execute arbitrary code without going through the shell hook. */
const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "execute",
  "eval",
  "code",
  "repl",
]);

const DEFAULT_REVIEW_POLICY = Object.freeze({ reviewRisk: 0.7 });

/**
 * The bounded, non-identifying action shape disclosed to the semantic assessor
 * for shell actions. It never carries the command, arguments, or redirects.
 */
const SHELL_ASSESSMENT_ACTION = Object.freeze({
  tool: "shell",
  operation: "shell_input",
  target: "unknown",
});

export interface WorkflowGateDeps {
  /** Test seam; production uses the pure workflow assessor. */
  readonly assessShellCommand?: (
    command: string,
    options: AssessShellOptions,
  ) => ShellAssessment;
  /** Test seam; production uses the bounded local Git review. */
  readonly createChangeReview?: (options: {
    cwd: string;
    runChecks?: boolean;
  }) => Promise<ChangeReviewResult>;
  /** Test seam; production uses `reviewEngineeringChange` plus Jev config. */
  readonly reviewEngineeringChange?: (
    input: EngineeringReviewInput,
  ) => Promise<EngineeringReviewResult>;
  /** Test seam for Jev configuration loading. */
  readonly loadJevConfig?: (path: string) => LoadedJevConfig;
  /** Test seam; production uses a per-session advisory injector. */
  readonly createInjectorSession?: () => InjectorSession;
  /** Receives fixed diagnostic codes only; never paths, commands, or prompts. */
  readonly onDiagnostic?: (code: string) => void;
}

type GateState = {
  /** The user asked for a workflow gate, including a malformed request. */
  requested: boolean;
  /** Parsed configuration; null when disabled or malformed. */
  config: WorkflowGateConfig | null;
  /** Gate parsing/setup failure makes gated shell actions fail closed. */
  configError: boolean;
  /** Completion review is unavailable, but shell governance still works. */
  jevError: boolean;
  /** Action assessment config is unavailable, so gated shell actions fail closed. */
  actionAssessmentError: boolean;
  shellHookAvailable: boolean;
  /**
   * The host's `permission.evaluate` hook registered successfully. Only then can
   * a plan-class confirm be handed to the native approval path.
   */
  permissionHookAvailable: boolean;
  /** The single loaded Jev configuration, shared by all Jev consumers. */
  jev: LoadedJevConfig | null;
};

function requiredPath(
  options: Record<string, unknown>,
  key: string,
  directory: string,
): string {
  const value = options[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be explicitly configured`);
  }
  return resolve(directory, value);
}

/**
 * The security adapter remains Stage A `log-only`. The engineering workflow
 * gate is a separate, explicitly opt-in option and never changes this mode.
 */
function readConfig(
  options: Record<string, unknown>,
  directory: string,
): AuditConfig {
  // An explicit strict request is never handled here: setup must reject before
  // any hook is registered rather than silently continuing in log-only mode.
  if (options.mode === "strict") {
    throw new Error(AMOS_STRICT_REQUIRES_CONTROLLED_HOST);
  }
  if (!isAbsolute(directory)) throw new Error("OpenCode location must be absolute");
  if (options.mode !== "log-only") throw new Error("Only log-only mode is enabled in stage A");
  return {
    directory,
    rulesPath: requiredPath(options, "rulesPath", directory),
    schemaPath: requiredPath(options, "schemaPath", directory),
    logPath: requiredPath(options, "logPath", directory),
  };
}

const ACTIVATION_GUIDANCE_ERROR = "amos_activation_guidance_error";

interface ActivationGuidanceConfig {
  readonly snapshotPath: string;
  readonly projectId: string;
  readonly expected?: {
    readonly activationDigest: string;
    readonly epoch: number;
    readonly policyVersion: string;
  };
}

type ActivationGuidanceState =
  | { readonly status: "absent" }
  | { readonly status: "enabled"; readonly config: ActivationGuidanceConfig }
  | { readonly status: "error" };

/**
 * Optional, explicit migration bridge to an activation-backed advisory
 * session. A malformed configuration is reported as an error instead of
 * falling back to the global guidance seed; the security recorder is
 * unaffected because this is advisory-only.
 */
function readActivationGuidanceConfig(
  options: Record<string, unknown>,
  directory: string,
): ActivationGuidanceState {
  const projection = readHostProjection(directory);
  if (projection.status === "error") return { status: "error" };
  if (projection.status === "ready") {
    return {
      status: "enabled",
      config: {
        snapshotPath: projection.projection.activation.snapshotPath,
        projectId: projection.projection.activation.projectId,
        expected: {
          activationDigest: projection.projection.activationDigest,
          epoch: projection.projection.epoch,
          policyVersion: projection.projection.policyVersion,
        },
      },
    };
  }
  const raw = options.activation;
  if (raw === undefined) return { status: "absent" };
  if (!isRecord(raw)) return { status: "error" };
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "snapshotPath" && key !== "projectId")) {
    return { status: "error" };
  }
  const snapshotPath = raw.snapshotPath;
  const projectId = raw.projectId;
  if (
    typeof snapshotPath !== "string" ||
    snapshotPath.trim().length === 0 ||
    typeof projectId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)
  ) {
    return { status: "error" };
  }
  return {
    status: "enabled",
    config: { snapshotPath: resolve(directory, snapshotPath), projectId },
  };
}

interface OpenCodeManagedReviewConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence | null;
  readonly ceilingDigest: string;
  readonly grantTtlMs?: number;
}

interface OpenCodeManagedConfig {
  readonly auditPath: string;
  readonly requirementEgress: "allowed" | "denied";
  readonly review: OpenCodeManagedReviewConfig | null;
}

type OpenCodeManagedState =
  | { readonly status: "absent" }
  | { readonly status: "error" }
  | { readonly status: "enabled"; readonly config: OpenCodeManagedConfig };

/**
 * Optional `managed` option for hosts that do not use `.pi/amos.json`.
 * A generated `.pi/amos.managed.json` projection takes precedence and is
 * handled in setup; this function only validates the explicit option shape.
 */
function readOpenCodeManagedState(
  options: Record<string, unknown>,
  directory: string,
): OpenCodeManagedState {
  const raw = options.managed;
  if (raw === undefined || raw === null) return { status: "absent" };
  if (!isRecord(raw)) return { status: "error" };
  if (raw.enabled !== true) {
    return raw.enabled === false ? { status: "absent" } : { status: "error" };
  }
  const keys = Object.keys(raw);
  if (
    keys.some(
      (key) =>
        key !== "enabled" &&
        key !== "auditPath" &&
        key !== "requirementEgress" &&
        key !== "review",
    )
  ) {
    return { status: "error" };
  }
  if (typeof raw.auditPath !== "string" || raw.auditPath.length === 0) {
    return { status: "error" };
  }
  const requirementEgress = raw.requirementEgress ?? "denied";
  if (requirementEgress !== "allowed" && requirementEgress !== "denied") {
    return { status: "error" };
  }
  const review = readOpenCodeManagedReview(raw.review);
  if (review === undefined) return { status: "error" };
  return {
    status: "enabled",
    config: {
      auditPath: resolve(directory, raw.auditPath),
      requirementEgress,
      review,
    },
  };
}

function readOpenCodeManagedReview(
  value: unknown,
): OpenCodeManagedReviewConfig | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "endpoint" &&
        key !== "model" &&
        key !== "apiKeyEnv" &&
        key !== "policy" &&
        key !== "calibration" &&
        key !== "ceilingDigest" &&
        key !== "grantTtlMs",
    )
  ) {
    return undefined;
  }
  if (
    typeof value.endpoint !== "string" ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    typeof value.apiKeyEnv !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.apiKeyEnv) ||
    typeof value.ceilingDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.ceilingDigest) ||
    !isValidPolicy(value.policy) ||
    value.policy.model !== value.model
  ) {
    return undefined;
  }
  if (
    value.grantTtlMs !== undefined &&
    (typeof value.grantTtlMs !== "number" ||
      !Number.isSafeInteger(value.grantTtlMs) ||
      value.grantTtlMs <= 0 ||
      value.grantTtlMs > 60_000)
  ) {
    return undefined;
  }
  const calibration = value.calibration;
  if (
    calibration !== null &&
    calibration !== undefined &&
    (!isRecord(calibration) ||
      calibration.format !== "amos-review-calibration" ||
      calibration.version !== 1)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value.endpoint);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    endpoint: value.endpoint,
    model: value.model,
    apiKeyEnv: value.apiKeyEnv,
    policy: value.policy,
    calibration: (calibration ?? null) as CalibrationEvidence | null,
    ceilingDigest: value.ceilingDigest,
    ...(value.grantTtlMs === undefined ? {} : { grantTtlMs: value.grantTtlMs }),
  };
}

type ManagedSessionState =
  | {
      readonly status: "ready";
      readonly gate: HarnessGate;
      readonly runtime: ActivationRuntime;
      readonly loadedAt: string;
    };

function managedCallKey(sessionID: string, callId: string): string {
  return `${sessionID.length}:${sessionID}${callId}`;
}

function safeManagedSessionId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) return value;
  return `session_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function fallbackAction(event: unknown): AuditAction {
  let tool = "unknown";
  try {
    if (
      typeof event === "object" &&
      event !== null &&
      !Array.isArray(event) &&
      typeof (event as ToolEvent).tool === "string" &&
      (event as { tool: string }).tool.trim().length > 0
    ) {
      tool = (event as { tool: string }).tool;
    }
  } catch {
    // A throwing getter on event.tool must not escape the hook.
  }
  return {
    tool,
    operation: "unknown",
    target: "unknown",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSessionID(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function readPromptText(prompt: unknown): string | null {
  const raw = typeof prompt === "string"
    ? prompt
    : isRecord(prompt) && typeof prompt.text === "string"
      ? prompt.text
      : null;
  if (raw === null || raw.length === 0 || raw.length > 64 * 1024) {
    return null;
  }
  return raw;
}

function readEffect(value: unknown): "allow" | "ask" | "deny" | null {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : null;
}

function shellVerdictRank(verdict: ShellVerdict): number {
  return verdict === "deny" ? 2 : verdict === "confirm" ? 1 : 0;
}

/**
 * Reduce an engine verdict to the shell vocabulary. `log` is non-blocking and
 * therefore treated as an allow; unknown values fall back to deny.
 */
function toShellVerdict(verdict: Verdict): ShellVerdict {
  if (verdict === "confirm") return "confirm";
  if (verdict === "allow" || verdict === "log") return "allow";
  return "deny";
}

/**
 * Build the only context the assessor may see for a plan-class shell action:
 * the classification kind/reason and one program/effect pair. Raw command text,
 * arguments, redirect targets, env, and credentials never enter this value.
 */
function safeShellAssessmentContext(
  assessment: ShellAssessment,
): Record<string, unknown> {
  let selected = assessment.operations[0];
  for (const operation of assessment.operations) {
    if (
      selected === undefined ||
      shellVerdictRank(operation.verdict) > shellVerdictRank(selected.verdict)
    ) {
      selected = operation;
    }
  }
  return {
    assessment: { kind: assessment.kind, reason: assessment.reason },
    operation:
      selected === undefined
        ? { program: "unknown", effect: "unknown" }
        : { program: selected.program, effect: selected.effect },
  };
}

function boundText(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return `${bytes.subarray(0, limit).toString("utf8")}\n[truncated]`;
}

/** Completion-review feedback is not pre-bounded, so truncate it generically. */
function appendSystem(event: ContextEvent, text: string): boolean {
  const bounded = boundText(text, MAX_SYSTEM_FEEDBACK_BYTES);
  if (bounded.length === 0) return false;
  if (Array.isArray(event.system)) {
    event.system.push({ type: "text", text: bounded });
    return true;
  }
  if (event.system === undefined) {
    event.system = [{ type: "text", text: bounded }];
    return true;
  }
  return false;
}

/**
 * Advisory blocks are already bounded by the injector's character budgets and
 * must reach the host verbatim: byte-oriented generic truncation could split a
 * multibyte rule or drop the closing provenance tag.
 */
function appendAdvisorySystem(event: ContextEvent, text: string): boolean {
  if (text.length === 0) return false;
  if (Array.isArray(event.system)) {
    event.system.push({ type: "text", text });
    return true;
  }
  if (event.system === undefined) {
    event.system = [{ type: "text", text }];
    return true;
  }
  return false;
}

function pruneMap<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

function resourceCommandCandidates(resources: unknown): string[] {
  const candidates: string[] = [];
  const add = (value: unknown): void => {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 64 * 1024 &&
      candidates.length < MAX_RESOURCE_STRINGS &&
      !candidates.includes(value)
    ) {
      candidates.push(value);
    }
  };

  if (typeof resources === "string") {
    add(resources);
  } else if (Array.isArray(resources)) {
    for (const value of resources) {
      add(value);
      if (isRecord(value)) {
        add(value.command);
        add(value.cmd);
        add(value.script);
      }
    }
  } else if (isRecord(resources)) {
    add(resources.command);
    add(resources.cmd);
    add(resources.script);
  }
  return candidates;
}

function checkFailureCode(check: ChangeReviewResult["checks"][number]): string {
  if (check.timedOut) return `${check.id}=timeout`;
  if (check.outputTruncated) return `${check.id}=output_limit`;
  if (check.error !== undefined) return `${check.id}=${check.error}`;
  return `${check.id}=failed`;
}

function buildReviewFeedback(input: {
  readonly checks: readonly string[];
  readonly diffReason: string | null;
  readonly jevReason: string | null;
}): string {
  const lines = [
    "Amos workflow review (advisory only; OpenCode V2 exposes no settle or merge block here): attention required.",
  ];
  if (input.checks.length > 0) {
    lines.push(`- checks: ${input.checks.join(", ")}`);
  }
  if (input.diffReason !== null) {
    lines.push(`- diff: ${input.diffReason}`);
  }
  if (input.jevReason !== null) {
    lines.push(`- jev: ${input.jevReason}`);
  }
  lines.push("Request human review before treating the change as complete.");
  return lines.join("\n");
}

export function createOpenCodeV2Plugin(deps: WorkflowGateDeps = {}) {
  const assessShell = deps.assessShellCommand ?? assessShellCommand;
  const runChangeReview = deps.createChangeReview ?? createChangeReview;
  const runEngineeringReview =
    deps.reviewEngineeringChange ?? reviewEngineeringChange;
  const loadJev = deps.loadJevConfig ?? loadJevConfig;

  return {
    id: "amos-opencode-v2-log-only",
    async setup(ctx: PluginContext) {
      const options = ctx.options ?? {};
      const config = readConfig(options, ctx.location.directory);
      const hostProjection = readHostProjection(config.directory);

      let auditErrorLogged = false;
      const recorder = createLogOnlyRecorder({
        rulesPath: config.rulesPath,
        schemaPath: config.schemaPath,
        logPath: config.logPath,
        sessionWorkspace: config.directory,
        onDiagnostic: () => {
          if (auditErrorLogged) return;
          auditErrorLogged = true;
          console.error(
            "Amos OpenCode adapter: audit write failed; the tool call was not blocked.",
          );
        },
      });

      const rawGate =
        hostProjection.status === "ready"
          ? hostProjection.projection.workflowGate
          : options.workflowGate;
      let configError = false;
      let parsedConfig: WorkflowGateConfig | null = null;
      try {
        parsedConfig = parseWorkflowGateConfig(rawGate, config.directory);
      } catch {
        configError = true;
      }
      if (hostProjection.status === "error") configError = true;

      const requested = configError
        ? rawGate !== undefined && rawGate !== null
        : parsedConfig?.enabled === true;
      const hardGateRequested =
        requested && (configError || parsedConfig?.shellGate === true);
      const gateEnabled = requested && !configError && parsedConfig !== null;

      const gate: GateState = {
        requested,
        config: parsedConfig,
        configError,
        jevError: false,
        actionAssessmentError: false,
        shellHookAvailable: false,
        permissionHookAvailable: false,
        jev: null,
      };

      const diagnostics = new Set<string>();
      const diagnostic = (code: string): void => {
        if (diagnostics.has(code)) return;
        diagnostics.add(code);
        if (deps.onDiagnostic !== undefined) {
          deps.onDiagnostic(code);
          return;
        }
        console.error(`Amos workflow gate: ${code}; gated actions fail closed.`);
      };

      if (configError) diagnostic(WORKFLOW_GATE_CONFIG_ERROR);

      const activationState = readActivationGuidanceConfig(
        options,
        config.directory,
      );
      let activationFactory: (() => InjectorSession) | null = null;
      if (activationState.status === "enabled") {
        const loaded = loadActivationGuidance({
          snapshotPath: activationState.config.snapshotPath,
          projectId: activationState.config.projectId,
          workspace: config.directory,
        });
        if (loaded.status === "error") {
          diagnostic(ACTIVATION_GUIDANCE_ERROR);
        }
        activationFactory = loaded.createSession;
      } else if (activationState.status === "error") {
        diagnostic(ACTIVATION_GUIDANCE_ERROR);
      }

      const managedOptionState =
        hostProjection.status === "ready"
          ? { status: "from_projection" as const }
          : hostProjection.status === "error"
            ? { status: "error" as const }
            : readOpenCodeManagedState(options, config.directory);
      let managedConfig: OpenCodeManagedConfig | null = null;
      let managedActivation: ActivationRuntime | null = null;
      let managedError = hostProjection.status === "error";
      let managedReview:
        | {
            provider: ReturnType<typeof createHttpReviewProvider>;
            policy: ReviewerPolicy;
            calibration: CalibrationEvidence | null;
            ceilingDigest: string;
            grantTtlMs?: number;
          }
        | null = null;

      if (managedOptionState.status === "from_projection") {
        const projection = hostProjection.status === "ready" ? hostProjection.projection : null;
        if (projection !== null && projection.managed.enabled) {
          const review = projection.managed.review;
          managedConfig = {
            auditPath: projection.managed.auditPath,
            requirementEgress: projection.managed.requirementEgress,
            review:
              review === null
                ? null
                : {
                    endpoint: review.endpoint,
                    model: review.model,
                    apiKeyEnv: review.apiKeyEnv,
                    policy: review.policy,
                    calibration: review.calibration,
                    ceilingDigest: review.ceilingDigest,
                    grantTtlMs: review.grantTtlMs,
                  },
          };
        }
      } else if (managedOptionState.status === "enabled") {
        managedConfig = managedOptionState.config;
      } else if (managedOptionState.status === "error") {
        managedError = true;
      }

      if (managedConfig !== null) {
        if (activationState.status !== "enabled") {
          managedError = true;
        } else {
          const loaded = loadActivationRuntime({
            snapshotPath: activationState.config.snapshotPath,
            projectId: activationState.config.projectId,
            workspace: config.directory,
          });
          if (loaded.status === "error") {
            managedError = true;
          } else {
            const expected = activationState.config.expected;
            if (
              expected !== undefined &&
              (loaded.runtime.activationDigest !== expected.activationDigest ||
                loaded.runtime.epoch !== expected.epoch ||
                loaded.runtime.snapshot.project.projectConfigVersion !== expected.policyVersion)
            ) {
              managedError = true;
            } else {
              managedActivation = loaded.runtime;
            }
          }
        }
        if (managedConfig.review !== null) {
          try {
            const review = managedConfig.review;
            managedReview = {
              provider: createHttpReviewProvider({
                endpoint: review.endpoint,
                model: review.model,
                apiKeyEnv: review.apiKeyEnv,
              }),
              policy: review.policy,
              calibration: review.calibration,
              ceilingDigest: review.ceilingDigest,
              ...(review.grantTtlMs === undefined ? {} : { grantTtlMs: review.grantTtlMs }),
            };
          } catch {
            managedError = true;
          }
        }
      } else if (managedError) {
        diagnostic("amos_managed_config_error");
      }

      const managedRequested = managedConfig !== null || managedError;
      const managedGates = new Map<string, ManagedSessionState>();
      const managedPending = new Map<string, { readonly gate: HarnessGate; readonly callId: string }>();
      const managedRuntimeUsed = new Set<string>();
      const MAX_MANAGED_SESSIONS = 64;

      const makeInjectorSession =
        deps.createInjectorSession ??
        activationFactory ??
        (() => createInjectorSession(getProjectSeedSnapshot()));

      type AdvisoryState = {
        readonly session: InjectorSession;
        pendingPrompt: InjectionBlock | null;
        readonly committedRuleIds: Set<string>;
      };

      // One injector session per harness session. Deduplication is owned by the
      // injector instance, so rule IDs never leak across session boundaries.
      const advisoryBySession = new Map<string, AdvisoryState>();
      const reviewedDigests = new Map<string, string>();

      // One bounded, memory-only requirement store per plugin setup. Frames are
      // created exclusively from the harness user-prompt channel; no tool
      // result, file, or model text can enter here.
      const requirements = createRequirementSessionStore();

      const managedCallId = (value: unknown): string | null => {
        if (typeof value !== "string" || value.length === 0 || value.length > 256) {
          return null;
        }
        if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) return value;
        return `call_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40)}`;
      };

      const ensureManagedGate = (
        sessionID: string,
      ): ManagedSessionState | { readonly status: "error" } | { readonly status: "absent" } => {
        if (!managedRequested) return { status: "absent" };
        if (managedError || managedConfig === null || managedActivation === null) {
          return { status: "error" };
        }
        const existing = managedGates.get(sessionID);
        if (existing !== undefined) return existing;
        try {
          const gate = createHarnessGate({
            activation: managedActivation,
            auditPath: managedConfig.auditPath,
            sessionId: safeManagedSessionId(sessionID),
            requirement: () => requirements.current(sessionID),
            review: managedReview,
            now: () => Date.now(),
          });
          const loadedAt = new Date().toISOString();
          const state: ManagedSessionState = {
            status: "ready",
            gate,
            runtime: managedActivation,
            loadedAt,
          };
          managedGates.set(sessionID, state);
          writeHarnessRuntimeReport({
            directory: config.directory,
            projectId: managedActivation.projectId,
            activationDigest: managedActivation.activationDigest,
            epoch: managedActivation.epoch,
            policyVersion: managedActivation.snapshot.project.projectConfigVersion,
            loadedAt,
            harness: "opencode",
            capabilities: OPENCODE_MANAGED_CAPABILITIES,
          });
          while (managedGates.size > MAX_MANAGED_SESSIONS) {
            const oldest = managedGates.keys().next().value;
            if (oldest === undefined || oldest === sessionID) break;
            const evicted = managedGates.get(oldest);
            if (evicted?.status === "ready") evicted.gate.close();
            managedGates.delete(oldest);
          }
          return state;
        } catch {
          return { status: "error" };
        }
      };

      const advisoryState = (sessionID: string): AdvisoryState => {
        const existing = advisoryBySession.get(sessionID);
        if (existing !== undefined) return existing;
        const created: AdvisoryState = {
          session: makeInjectorSession(),
          pendingPrompt: null,
          committedRuleIds: new Set<string>(),
        };
        advisoryBySession.set(sessionID, created);
        pruneMap(advisoryBySession, MAX_GUIDANCE_SESSIONS);
        return created;
      };

      const commitBlock = (state: AdvisoryState, block: InjectionBlock): void => {
        state.session.commit(block);
        for (const id of block.ruleIds) {
          state.committedRuleIds.add(id);
        }
      };

      const normalizeAction = (event: ToolEvent): OpenCodeNormalization | null => {
        try {
          return normalizeOpenCodeAction(event, config.directory);
        } catch {
          return null;
        }
      };

      const recordAudit = (
        event: ToolEvent,
        normalized: OpenCodeNormalization | null,
      ): void => {
        const started = performance.now();
        const now = Date.now();
        if (normalized !== null) {
          try {
            recorder.record(normalized, now, started);
            return;
          } catch {
            // Fall through to the bounded engine_error record.
          }
        }
        try {
          recorder.record(
            { kind: "error", error: "engine_error", action: fallbackAction(event) },
            now,
            started,
          );
        } catch {
          // Log-only must never throw into OpenCode's tool pipeline.
        }
      };

      const queueAdvisory = (
        event: ToolEvent,
        normalized: OpenCodeNormalization | null,
      ): void => {
        try {
          if (!gateEnabled || parsedConfig === null || !parsedConfig.guidance) {
            return;
          }
          if (normalized === null || normalized.kind !== "action") return;
          const action = normalized.action;
          if (
            action.operation !== "file_write" ||
            (action.tool !== "write" && action.tool !== "edit")
          ) {
            return;
          }
          const sessionID = readSessionID(event.sessionID);
          if (sessionID === null) return;
          const state = advisoryState(sessionID);
          state.session.queueAction(
            {
              tool: action.tool,
              operation: action.operation,
              target: action.target,
            },
            config.directory,
          );
        } catch {
          // Advisory queueing never affects audit, gating, or permissions.
        }
      };

      const registrations: Array<() => unknown | Promise<unknown>> = [];
      const register = async (
        registration: Promise<Registration> | undefined,
      ): Promise<boolean> => {
        if (registration === undefined) return false;
        try {
          const registered = await registration;
          registrations.push(() => registered.dispose());
          return true;
        } catch {
          return false;
        }
      };

      if (
        gateEnabled &&
        parsedConfig !== null &&
        (parsedConfig.completionReview || parsedConfig.actionAssessment)
      ) {
        // Completion review and action assessment share one loaded
        // configuration; it is never loaded twice.
        try {
          gate.jev = loadJev(parsedConfig.jevConfigPath as string);
        } catch {
          gate.jev = null;
          if (parsedConfig.completionReview) gate.jevError = true;
          if (parsedConfig.actionAssessment) gate.actionAssessmentError = true;
        }
      }

      const onPrompt = async (event: PromptEvent): Promise<void> => {
        try {
          if (!gateEnabled && !managedRequested) return;
          const sessionID = readSessionID(event.sessionID);
          const text = readPromptText(event.prompt);

          // Requirement capture happens before any advisory handling so a
          // later managed confirm or shell assessment can use the exact human
          // message. Capture failure never blocks prompt admission; it only
          // means a later required decision fails closed.
          if (managedRequested) {
            if (sessionID !== null) {
              if (text === null) {
                requirements.clear(sessionID);
              } else {
                try {
                  requirements.captureUserMessage(
                    sessionID,
                    text,
                    managedConfig?.requirementEgress ?? "denied",
                  );
                } catch {
                  requirements.clear(sessionID);
                }
              }
            }
          } else if (gateEnabled && parsedConfig !== null && parsedConfig.actionAssessment) {
            if (sessionID !== null) {
              if (text === null) {
                requirements.clear(sessionID);
              } else {
                try {
                  requirements.captureUserMessage(
                    sessionID,
                    text,
                    parsedConfig.requirementEgress,
                  );
                } catch {
                  requirements.clear(sessionID);
                }
              }
            }
          } else if (sessionID !== null) {
            requirements.clear(sessionID);
          }

          const guidanceEnabled =
            (gateEnabled && parsedConfig !== null && parsedConfig.guidance) ||
            (managedRequested && activationState.status === "enabled");
          if (!guidanceEnabled) return;
          if (text === null || sessionID === null) return;

          const state = advisoryState(sessionID);
          let block: InjectionBlock;
          try {
            block = state.session.selectPrompt(text);
          } catch {
            return;
          }

          if (block.text.length === 0) {
            // A new block with no rules is retired without emission.
            commitBlock(state, block);
            return;
          }

          const put = ctx.session?.instructions?.entry?.put;
          if (typeof put === "function") {
            try {
              await put({
                sessionID,
                key: GUIDANCE_INSTRUCTION_KEY,
                value: block.text,
              });
              commitBlock(state, block);
              // A successful put must not disable a later fallback; it only
              // retires the pending block for this prompt.
              state.pendingPrompt = null;
              return;
            } catch {
              // The context hook below carries this block instead.
            }
          }
          state.pendingPrompt = block;
        } catch {
          // Guidance is advisory and must never reject prompt admission.
        }
      };

      const onContext = async (event: ContextEvent): Promise<void> => {
        const guidanceEnabled =
          (gateEnabled && parsedConfig !== null && parsedConfig.guidance) ||
          (managedRequested && activationState.status === "enabled");
        const completionReviewEnabled =
          gateEnabled && parsedConfig !== null && parsedConfig.completionReview;
        if (!guidanceEnabled && !completionReviewEnabled) return;
        const sessionID = readSessionID(event.sessionID);
        if (sessionID === null) return;

        // Advisory injection is isolated: an injector or host failure must not
        // suppress completion review below.
        try {
          if (guidanceEnabled) {
            const state = advisoryBySession.get(sessionID);
            if (state !== undefined) {
              const pendingPrompt = state.pendingPrompt;
              if (pendingPrompt !== null) {
                if (pendingPrompt.text.length === 0) {
                  commitBlock(state, pendingPrompt);
                  state.pendingPrompt = null;
                } else if (appendAdvisorySystem(event, pendingPrompt.text)) {
                  commitBlock(state, pendingPrompt);
                  state.pendingPrompt = null;
                }
              }

              // OpenCode has no after-tool hook; pending area blocks are
              // emitted here, one independent system part at a time, and are
              // committed only after each append succeeds.
              for (let flushed = 0; flushed < MAX_AREA_FLUSH; flushed += 1) {
                const block = state.session.selectPendingArea();
                if (block === null) break;
                if (block.text.length === 0) {
                  commitBlock(state, block);
                  continue;
                }
                if (!appendAdvisorySystem(event, block.text)) break;
                commitBlock(state, block);
              }
            }
          }
        } catch {
          // Advisory only; continue to completion review.
        }

        if (!completionReviewEnabled) return;
        if (gate.jevError || gate.jev === null) {
          if (reviewedDigests.get(sessionID) === "jev_config_error") return;
          reviewedDigests.set(sessionID, "jev_config_error");
          pruneMap(reviewedDigests, MAX_REVIEWED_SESSIONS);
          appendSystem(
            event,
            "Amos workflow review is unavailable because the Jev configuration failed (jev_config_error). Request human review; shell governance remains active.",
          );
          return;
        }

        // Digests are cheap to recompute relative to fixed checks and Jev.
        // Probe first so an unchanged tree never reruns `npm test` or a model.
        let review: ChangeReviewResult;
        try {
          review = await runChangeReview({
            cwd: config.directory,
            runChecks: false,
          });
        } catch {
          if (reviewedDigests.get(sessionID) === "review_error") return;
          reviewedDigests.set(sessionID, "review_error");
          pruneMap(reviewedDigests, MAX_REVIEWED_SESSIONS);
          appendSystem(
            event,
            "Amos workflow review is unavailable for this change (review_error). Request human review before treating the change as complete.",
          );
          return;
        }

        const probeDigest =
          typeof review.digest === "string" && review.digest.length > 0
            ? review.digest
            : null;
        if (probeDigest === null) return;
        if (reviewedDigests.get(sessionID) === probeDigest) return;
        reviewedDigests.set(sessionID, probeDigest);
        pruneMap(reviewedDigests, MAX_REVIEWED_SESSIONS);

        if (review.checks.length === 0) {
          try {
            review = await runChangeReview({
              cwd: config.directory,
              runChecks: true,
            });
          } catch {
            appendSystem(
              event,
              "Amos workflow review is unavailable for this change (review_error). Request human review before treating the change as complete.",
            );
            return;
          }
        }

        const digest =
          typeof review.digest === "string" && review.digest.length > 0
            ? review.digest
            : probeDigest;
        if (digest !== probeDigest) {
          reviewedDigests.set(sessionID, digest);
          pruneMap(reviewedDigests, MAX_REVIEWED_SESSIONS);
        }

        const failedChecks = review.checks
          .filter((check) => check.ok !== true)
          .map(checkFailureCode);

        let diffReason: string | null = null;
        if (review.egress.eligible !== true) {
          if (review.egress.reason !== "no_changes") {
            diffReason = review.egress.reason;
          }
        }

        let jevReason: string | null = null;
        if (review.egress.eligible === true && gate.jev !== null) {
          // Convert only committed advisory rule IDs at review time; there is
          // no second selector and no cross-session fallback.
          const committed =
            advisoryBySession.get(sessionID)?.committedRuleIds ?? new Set<string>();
          const guidance = guidancePacksForRuleIds([...committed]);
          try {
            const result = await runEngineeringReview({
              client: gate.jev.systemOneClient,
              diff: review.egress,
              guidance,
              policy:
                (gate.jev.config.policy as EngineeringReviewInput["policy"]) ??
                DEFAULT_REVIEW_POLICY,
            });
            if (
              result.status === "concern" ||
              result.status === "unknown" ||
              result.status === "error"
            ) {
              jevReason = `${result.status}/${result.reason}`;
            }
          } catch {
            jevReason = "error/assessment_failed";
          }
        }

        if (failedChecks.length === 0 && diffReason === null && jevReason === null) {
          return;
        }

        appendSystem(
          event,
          buildReviewFeedback({
            checks: failedChecks,
            diffReason,
            jevReason,
          }),
        );
      };

      const recordActionAssessment = (
        requirement: RequirementFrame | null,
        shellAssessment: ShellAssessment,
        result: CombinedAssessmentResult,
        assessmentRequired: boolean,
      ): void => {
        try {
          recorder.recordAssessment(
            SHELL_ASSESSMENT_ACTION,
            buildJevAssessmentAudit({
              requirement,
              shellAssessment,
              result,
              assessmentRequired,
            }),
          );
        } catch {
          // Assessment provenance is best-effort; it never affects the verdict.
        }
      };

      const finishShellAction = (
        verdict: ShellVerdict,
        assessment: ShellAssessment,
      ): void => {
        if (verdict === "deny") throw new Error(WORKFLOW_GATE_SHELL_DENIED);
        if (verdict !== "confirm") return;
        // Only a deterministic confirm can be delegated to the host's native
        // permission path. A semantic assessment that tightens an allow into a
        // confirm has no matching deterministic permission evaluation, so no
        // native ask is guaranteed; it must fail closed instead of silently
        // executing.
        if (assessment.verdict !== "confirm") {
          throw new Error(WORKFLOW_GATE_SHELL_CONFIRM_UNAVAILABLE);
        }
        // A parsed plan-class confirm can be delegated to the host's native
        // permission path: shell.create.before runs before permission.assert,
        // permission.evaluate, and the user's once/always/reject decision.
        // Opaque/unsupported assessments and reduced hosts without the
        // permission hook still fail closed here.
        if (assessment.kind === "plan" && gate.permissionHookAvailable) return;
        throw new Error(WORKFLOW_GATE_SHELL_CONFIRM_UNAVAILABLE);
      };

      const runActionAssessment = async (
        event: ShellCreateEvent,
        assessment: ShellAssessment,
      ): Promise<void> => {
        const sessionID = readSessionID(event.sessionID);
        const requirement =
          sessionID === null ? null : requirements.current(sessionID);
        const loaded = gate.jev;

        if (gate.actionAssessmentError || loaded === null) {
          // Action assessment was requested but its configuration is
          // unavailable. Gated shell actions fail closed instead of silently
          // skipping the mandatory assessment.
          recordActionAssessment(
            requirement,
            assessment,
            { verdict: "deny", error: "assessment_failed" },
            false,
          );
          throw new Error(WORKFLOW_GATE_CONFIG_ERROR);
        }

        const assessmentRequired = loaded.config.assessmentRequired;

        if (requirement === null) {
          // No harness-captured frame exists for this action. Never invent one
          // and never spend a provider call: a required assessment denies,
          // otherwise the deterministic baseline stands.
          const verdict: ShellVerdict = assessmentRequired
            ? "deny"
            : assessment.verdict;
          recordActionAssessment(
            null,
            assessment,
            { verdict },
            assessmentRequired,
          );
          finishShellAction(verdict, assessment);
          return;
        }

        let result: CombinedAssessmentResult;
        try {
          result = await combineWithAssessment({
            deterministic: assessment.verdict,
            provider: loaded.assessmentProvider,
            action: SHELL_ASSESSMENT_ACTION,
            context: safeShellAssessmentContext(assessment),
            requirement,
            policy: loaded.config.policy,
            assessmentRequired,
          });
        } catch {
          result = {
            verdict: assessmentRequired ? "deny" : assessment.verdict,
            error: "assessment_failed",
          };
        }

        recordActionAssessment(
          requirement,
          assessment,
          result,
          assessmentRequired,
        );
        finishShellAction(toShellVerdict(result.verdict), assessment);
      };

      const onShellCreate = async (event: ShellCreateEvent): Promise<void> => {
        if (!gate.requested) return;
        if (gate.configError) throw new Error(WORKFLOW_GATE_CONFIG_ERROR);
        const gateConfig = parsedConfig;
        if (gateConfig === null || !gateConfig.shellGate || !hardGateRequested) {
          return;
        }

        const command = event.command;
        if (typeof command !== "string" || command.length === 0) {
          // An unanalyzable shell invocation is not silently executed.
          throw new Error(WORKFLOW_GATE_SHELL_DENIED);
        }
        const cwd =
          typeof event.cwd === "string" && isAbsolute(event.cwd)
            ? event.cwd
            : null;
        if (cwd === null) {
          throw new Error(WORKFLOW_GATE_SHELL_CONFIRM_UNAVAILABLE);
        }

        let assessment: ShellAssessment;
        try {
          assessment = assessShell(command, {
            cwd,
            ...(typeof event.shell === "string" ? { shellPath: event.shell } : {}),
          });
        } catch {
          throw new Error(WORKFLOW_GATE_CONFIG_ERROR);
        }

        // Every deterministic deny is unchanged and never reaches the model.
        if (assessment.verdict === "deny") {
          throw new Error(WORKFLOW_GATE_SHELL_DENIED);
        }

        if (gateConfig.actionAssessment && assessment.kind === "plan") {
          await runActionAssessment(event, assessment);
          return;
        }

        if (assessment.verdict === "confirm") {
          finishShellAction("confirm", assessment);
        }
      };

      const onPermissionEvaluate = (event: PermissionEvent): void => {
        if (!gate.requested) return;
        const current = readEffect(event.effect);
        if (current === "deny") return;

        if (gate.configError) {
          if (event.action === "shell" && current !== null) event.effect = "deny";
          return;
        }
        if (parsedConfig === null || !parsedConfig.shellGate) return;
        if (event.action !== "shell") return;
        if (current === null) {
          event.effect = "deny";
          return;
        }

        const assessmentCwd = config.directory;
        const candidates = resourceCommandCandidates(event.resources);
        let verdict: ShellVerdict = "allow";
        for (const candidate of candidates) {
          let assessment: ShellAssessment;
          try {
            assessment = assessShell(candidate, { cwd: assessmentCwd });
          } catch {
            event.effect = "deny";
            return;
          }
          if (assessment.verdict === "deny") {
            event.effect = "deny";
            return;
          }
          if (shellVerdictRank(assessment.verdict) > shellVerdictRank(verdict)) {
            verdict = assessment.verdict;
          }
        }

        if (verdict === "confirm" && current === "allow") {
          event.effect = "ask";
        }
      };

      const onToolExecuteBefore = async (event: ToolEvent): Promise<void> => {
        // Normalize exactly once so audit and advisory queueing see the same
        // structural action.
        const normalized = normalizeAction(event);
        recordAudit(event, normalized);
        queueAdvisory(event, normalized);

        if (managedRequested) {
          const sessionID = readSessionID(event.sessionID);
          if (sessionID === null) {
            throw new Error("amos_managed_missing_session");
          }
          const state = ensureManagedGate(sessionID);
          if (state.status === "absent" || state.status === "error") {
            throw new Error("amos_managed_config_error");
          }
          if (normalized === null || normalized.kind !== "action") {
            throw new Error("amos_managed_coverage_gap");
          }
          const callId = managedCallId(event.id);
          if (callId === null) {
            throw new Error("amos_managed_missing_call_id");
          }
          const result = await state.gate.preCall({
            callId,
            action: normalized.action,
          });
          if (result.action === "block") {
            throw new Error(`amos_managed_${result.code}`);
          }
          managedPending.set(managedCallKey(sessionID, callId), {
            gate: state.gate,
            callId,
          });
          if (!managedRuntimeUsed.has(sessionID)) {
            managedRuntimeUsed.add(sessionID);
            writeHarnessRuntimeReport({
              directory: config.directory,
              projectId: state.runtime.projectId,
              activationDigest: state.runtime.activationDigest,
              epoch: state.runtime.epoch,
              policyVersion: state.runtime.snapshot.project.projectConfigVersion,
              loadedAt: state.loadedAt,
              lastToolAt: new Date().toISOString(),
              harness: "opencode",
              capabilities: OPENCODE_MANAGED_CAPABILITIES,
            });
          }
          return;
        }

        if (!hardGateRequested) return;
        const tool = typeof event.tool === "string" ? event.tool : null;

        if (gate.configError) {
          if (tool !== null && (CODE_EXECUTION_TOOLS.has(tool) || tool === "shell")) {
            throw new Error(WORKFLOW_GATE_CONFIG_ERROR);
          }
          return;
        }
        if (tool === null) return;
        if (CODE_EXECUTION_TOOLS.has(tool)) {
          throw new Error(WORKFLOW_GATE_TOOL_BLOCKED);
        }
        if (tool === "shell" && !gate.shellHookAvailable) {
          // No primary shell seam means an opaque shell command must not slip
          // through the audit-only tool path.
          throw new Error(WORKFLOW_GATE_TOOL_BLOCKED);
        }
      };

      const onToolExecuteAfter = (event: ToolEvent): void => {
        const sessionID = readSessionID(event.sessionID);
        if (sessionID === null) return;
        const callId = managedCallId(event.id);
        if (callId === null) return;
        const key = managedCallKey(sessionID, callId);
        const pending = managedPending.get(key);
        if (pending === undefined) return;
        managedPending.delete(key);
        try {
          pending.gate.recordResult(
            pending.callId,
            event.status === "completed" ? "executed" : "failed",
            event.status === "completed" ? undefined : "tool_error",
          );
        } catch {
          // A result-journal failure must not re-run the effect or escape the
          // host hook; the authorization remains the last durable record.
        }
      };

      // Audit remains the first registration and is always active.
      await register(
        ctx.tool.hook("execute.before", onToolExecuteBefore),
      );
      if (managedRequested) {
        await register(
          ctx.tool.hook("execute.after", onToolExecuteAfter),
        );
      }

      if (
        managedRequested ||
        (gateEnabled && parsedConfig !== null)
      ) {
        if (
          managedRequested ||
          (parsedConfig !== null &&
            (parsedConfig.guidance || parsedConfig.actionAssessment))
        ) {
          await register(
            ctx.session === undefined
              ? undefined
              : ctx.session.hook("prompt", onPrompt),
          );
        }

        if (
          (managedRequested && activationState.status === "enabled") ||
          (parsedConfig !== null &&
            (parsedConfig.guidance || parsedConfig.completionReview))
        ) {
          await register(
            ctx.session === undefined
              ? undefined
              : ctx.session.hook("context", onContext),
          );
        }
      }

      // The hard shell gate is registered even when the gate configuration is
      // malformed so its hook can reject with a fixed config error. This keeps
      // a broken opt-in from degrading into silent execution.
      if (hardGateRequested && ctx.shell !== undefined) {
        const registered = await register(
          ctx.shell.hook("create.before", onShellCreate),
        );
        gate.shellHookAvailable = registered;
        if (!registered) {
          gate.configError = true;
          diagnostic(WORKFLOW_GATE_CONFIG_ERROR);
        }
      } else if (hardGateRequested) {
        gate.configError = true;
        diagnostic(WORKFLOW_GATE_CONFIG_ERROR);
      }

      if (hardGateRequested && ctx.permission !== undefined) {
        gate.permissionHookAvailable = await register(
          ctx.permission.hook("evaluate", onPermissionEvaluate),
        );
      }

      return async () => {
        for (const dispose of registrations) {
          try {
            await dispose();
          } catch {
            // A host-owned registration may already be gone.
          }
        }
      };
    },
  };
}

export default createOpenCodeV2Plugin();
