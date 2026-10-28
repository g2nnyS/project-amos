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
import { selectGuidance } from "../../guidance/select.ts";
import { renderGuidance } from "../../guidance/render.ts";
import type { GuidancePack } from "../../guidance/types.ts";
import { createLogOnlyRecorder } from "../shared/log-only.ts";
import { normalizeOpenCodeAction } from "./normalize.ts";

type ToolEvent = { tool?: unknown; input?: unknown };
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
  tool: HookDomain<{ "execute.before": ToolEvent }>;
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

const WORKFLOW_GATE_SHELL_DENIED = "atmos_workflow_gate_shell_denied";
const WORKFLOW_GATE_SHELL_CONFIRM = "atmos_workflow_gate_shell_confirmation_required";
const WORKFLOW_GATE_TOOL_BLOCKED = "atmos_workflow_gate_tool_blocked";
const WORKFLOW_GATE_CONFIG_ERROR = "atmos_workflow_gate_config_error";

const GUIDANCE_INSTRUCTION_KEY = "atmos.workflow.guidance";
const MAX_GUIDANCE_SESSIONS = 64;
const MAX_REVIEWED_SESSIONS = 64;
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
  shellHookAvailable: boolean;
  jev: { readonly client: LoadedJevConfig["systemOneClient"]; readonly policy: unknown } | null;
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
  if (!isAbsolute(directory)) throw new Error("OpenCode location must be absolute");
  if (options.mode !== "log-only") throw new Error("Only log-only mode is enabled in stage A");
  return {
    directory,
    rulesPath: requiredPath(options, "rulesPath", directory),
    schemaPath: requiredPath(options, "schemaPath", directory),
    logPath: requiredPath(options, "logPath", directory),
  };
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

function boundText(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return `${bytes.subarray(0, limit).toString("utf8")}\n[truncated]`;
}

function appendSystem(event: ContextEvent, text: string): void {
  const bounded = boundText(text, MAX_SYSTEM_FEEDBACK_BYTES);
  if (bounded.length === 0) return;
  if (Array.isArray(event.system)) {
    event.system.push({ type: "text", text: bounded });
    return;
  }
  if (event.system === undefined) {
    event.system = [{ type: "text", text: bounded }];
  }
}

function pruneMap<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

function pruneSet(set: Set<string>, limit: number): void {
  while (set.size > limit) {
    const oldest = set.values().next();
    if (oldest.done === true) return;
    set.delete(oldest.value);
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
    "Atmos workflow review (advisory only; OpenCode V2 exposes no settle or merge block here): attention required.",
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
    id: "atmos-opencode-v2-log-only",
    async setup(ctx: PluginContext) {
      const options = ctx.options ?? {};
      const config = readConfig(options, ctx.location.directory);

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
            "Atmos OpenCode adapter: audit write failed; the tool call was not blocked.",
          );
        },
      });

      const rawGate = options.workflowGate;
      let configError = false;
      let parsedConfig: WorkflowGateConfig | null = null;
      try {
        parsedConfig = parseWorkflowGateConfig(rawGate, config.directory);
      } catch {
        configError = true;
      }

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
        shellHookAvailable: false,
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
        console.error(`Atmos workflow gate: ${code}; gated actions fail closed.`);
      };

      if (configError) diagnostic(WORKFLOW_GATE_CONFIG_ERROR);

      const guidanceBySession = new Map<string, string>();
      const guidanceSelectionBySession = new Map<string, readonly GuidancePack[]>();
      const instructionSessions = new Set<string>();
      const reviewedDigests = new Map<string, string>();

      const remember = (sessionID: string, guidance: string): void => {
        guidanceBySession.set(sessionID, guidance);
        pruneMap(guidanceBySession, MAX_GUIDANCE_SESSIONS);
      };

      const recordAudit = (event: ToolEvent): void => {
        const started = performance.now();
        const now = Date.now();
        try {
          recorder.record(normalizeOpenCodeAction(event, config.directory), now, started);
        } catch {
          try {
            recorder.record(
              { kind: "error", error: "engine_error", action: fallbackAction(event) },
              now,
              started,
            );
          } catch {
            // Log-only must never throw into OpenCode's tool pipeline.
          }
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

      if (gateEnabled && parsedConfig !== null && parsedConfig.completionReview) {
        try {
          const loaded = loadJev(parsedConfig.jevConfigPath as string);
          gate.jev = { client: loaded.systemOneClient, policy: loaded.config.policy };
        } catch {
          gate.jevError = true;
        }
      }

      const onPrompt = async (event: PromptEvent): Promise<void> => {
        try {
          if (!gateEnabled || parsedConfig === null || !parsedConfig.guidance) {
            return;
          }
          const sessionID = readSessionID(event.sessionID);
          const text = readPromptText(event.prompt);
          if (text === null || sessionID === null) return;

          const selection = selectGuidance({ prompt: text });
          const rendered = renderGuidance(selection.packs);
          guidanceSelectionBySession.set(sessionID, selection.packs);
          pruneMap(guidanceSelectionBySession, MAX_GUIDANCE_SESSIONS);

          const put = ctx.session?.instructions?.entry?.put;
          if (typeof put === "function") {
            try {
              await put({
                sessionID,
                key: GUIDANCE_INSTRUCTION_KEY,
                value: rendered,
              });
              instructionSessions.add(sessionID);
              pruneSet(instructionSessions, MAX_GUIDANCE_SESSIONS);
              guidanceBySession.delete(sessionID);
              return;
            } catch {
              // The context hook below carries the same rendered text instead.
            }
          }
          remember(sessionID, rendered);
        } catch {
          // Guidance is advisory and must never reject prompt admission.
        }
      };

      const onContext = async (event: ContextEvent): Promise<void> => {
        if (!gateEnabled || parsedConfig === null) return;
        const sessionID = readSessionID(event.sessionID);
        if (sessionID === null) return;

        if (parsedConfig.guidance && !instructionSessions.has(sessionID)) {
          const fallback = guidanceBySession.get(sessionID);
          if (fallback !== undefined) {
            appendSystem(event, fallback);
          }
        }

        if (!parsedConfig.completionReview) return;
        if (gate.jevError || gate.jev === null) {
          if (reviewedDigests.get(sessionID) === "jev_config_error") return;
          reviewedDigests.set(sessionID, "jev_config_error");
          pruneMap(reviewedDigests, MAX_REVIEWED_SESSIONS);
          appendSystem(
            event,
            "Atmos workflow review is unavailable because the Jev configuration failed (jev_config_error). Request human review; shell governance remains active.",
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
            "Atmos workflow review is unavailable for this change (review_error). Request human review before treating the change as complete.",
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
              "Atmos workflow review is unavailable for this change (review_error). Request human review before treating the change as complete.",
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
          const guidance =
            guidanceSelectionBySession.get(sessionID) ?? selectGuidance().packs;
          try {
            const result = await runEngineeringReview({
              client: gate.jev.client,
              diff: review.egress,
              guidance,
              policy: (gate.jev.policy as EngineeringReviewInput["policy"]) ??
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

      const onShellCreate = (event: ShellCreateEvent): void => {
        if (!gate.requested) return;
        if (gate.configError) throw new Error(WORKFLOW_GATE_CONFIG_ERROR);
        if (parsedConfig === null || !parsedConfig.shellGate || !hardGateRequested) {
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
          throw new Error(WORKFLOW_GATE_SHELL_CONFIRM);
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

        if (assessment.verdict === "deny") {
          throw new Error(WORKFLOW_GATE_SHELL_DENIED);
        }
        if (assessment.verdict === "confirm") {
          // This hook has no synchronous, attributable approval API. A parsed
          // confirm still fails closed here rather than depending on whether a
          // later permission event happens to run.
          throw new Error(WORKFLOW_GATE_SHELL_CONFIRM);
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

      const onToolExecuteBefore = (event: ToolEvent): void => {
        recordAudit(event);

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

      // Audit remains the first registration and is always active.
      await register(
        ctx.tool.hook("execute.before", onToolExecuteBefore),
      );

      if (gateEnabled && parsedConfig !== null) {
        if (parsedConfig.guidance) {
          await register(
            ctx.session === undefined
              ? undefined
              : ctx.session.hook("prompt", onPrompt),
          );
        }

        if (parsedConfig.guidance || parsedConfig.completionReview) {
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
        await register(ctx.permission.hook("evaluate", onPermissionEvaluate));
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
