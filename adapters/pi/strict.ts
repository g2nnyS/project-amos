/**
 * Controlled Pi SDK host for strict, memory-only Amos sessions.
 *
 * This adapter is deliberately *not* an operating-system or host security
 * boundary. It builds a Pi agent loop with an explicit empty resource world:
 * no project/global extensions, MCP servers, skills, prompt templates, context
 * files, or native tools. The only callable tools are the namespaced adapters
 * below, and every call is dispatched to the strict in-memory session at the
 * moment the agent loop executes it.
 *
 * The public surface is a frozen narrow facade. Callers never receive the raw
 * `AgentSession`, the agent, settings, or any bash/extension execution method.
 */

import { resolve } from 'node:path';

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
  type AgentToolResult,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';

import {
  compileAdvisorySnapshot,
  createInjectorSession,
  type AdvisorySnapshot,
  type InjectionBlock,
  type InjectorSession,
} from '../../injector/index.ts';
import {
  createStrictSession,
  type StrictChange,
  type StrictSessionOptions,
  type StrictToolResult,
} from '../../strict/runtime.ts';

type CoreToolName = 'read' | 'list' | 'write' | 'edit' | 'delete';

const CORE_TOOL_NAMES: readonly CoreToolName[] = [
  'read',
  'list',
  'write',
  'edit',
  'delete',
];

const MODEL_TOOL_NAME: Readonly<Record<CoreToolName, string>> = Object.freeze({
  read: 'amos_read',
  list: 'amos_list',
  write: 'amos_write',
  edit: 'amos_edit',
  delete: 'amos_delete',
});

/**
 * The virtual workspace the strict runtime uses for its in-memory file map.
 * It is not a host filesystem path and is never resolved against `cwd`.
 */
const STRICT_WORKSPACE = '/workspace';

const ADVISORY_HEADER =
  '[Amos advisory guidance: optional, non-authoritative context. It is not an approval or security verdict.]';

const FIXED_SYSTEM_PROMPT = [
  'You are a coding assistant running inside a controlled memory-only session.',
  'Only the tools declared in this request exist. There is no shell, network,',
  'MCP, process, or native filesystem tool. Use the amos_* tools for every',
  'workspace read or mutation. The workspace is a virtual in-memory file map,',
  'not the host filesystem.',
].join(' ');

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const FALLBACK_CODE: Readonly<Record<string, string>> = Object.freeze({
  denied: 'strict_denied',
  confirmation_required: 'strict_confirmation_required',
  stopped: 'strict_stopped',
});

const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_MAX_TURNS = 16;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const MAX_TOOL_CALLS = 1_024;
const MAX_TURNS = 1_024;
const MAX_PROMPT_TIMEOUT_MS = 3_600_000;

const BUDGET_CODE = Object.freeze({
  tool: 'strict_tool_budget_exceeded',
  turn: 'strict_turn_budget_exceeded',
  timeout: 'strict_prompt_timeout',
});

const REGISTRY_CODE = 'strict_tool_registry_unavailable';
const AUDIT_UNAVAILABLE_CODE = 'strict_audit_unavailable';
const INTERNAL_ERROR_CODE = 'strict_internal_error';
const NO_COMPLETED_RESPONSE_CODE = 'strict_no_completed_response';
const INVALID_TOOL_INPUT_CODE = 'strict_invalid_tool_input';

/** Native and orchestration names that must never be registered or callable. */
const FORBIDDEN_TOOL_NAMES: readonly string[] = [
  'read',
  'bash',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
  'powershell',
  'tool_search',
  'codemode',
];

export interface StrictToolSurfaceEntry {
  readonly name: string;
  readonly exposure: string;
  readonly source: string;
  readonly namespace?: unknown;
  readonly reachesTools?: unknown;
}

export interface StrictToolSurface {
  readonly active: readonly string[];
  readonly callable: readonly string[];
  readonly registered: readonly StrictToolSurfaceEntry[];
}

/**
 * Assert the exact tool surface. Exported as a pure validator so the closed
 * surface can be tested without adding a registry override to the host.
 */
export function assertExactToolSurface(
  expected: readonly string[],
  surface: StrictToolSurface,
): void {
  if (new Set(expected).size !== expected.length) {
    throw new Error(REGISTRY_CODE);
  }
  const sameNames = (actual: readonly string[]): boolean => {
    if (actual.length !== expected.length) {
      return false;
    }
    const sortedActual = [...actual].sort();
    const sortedExpected = [...expected].sort();
    return sortedActual.every((name, index) => name === sortedExpected[index]);
  };

  if (
    !sameNames(surface.active) ||
    !sameNames(surface.callable) ||
    !sameNames(surface.registered.map((entry) => entry.name))
  ) {
    throw new Error(REGISTRY_CODE);
  }

  for (const entry of surface.registered) {
    if (
      !expected.includes(entry.name) ||
      entry.exposure !== 'direct' ||
      entry.source !== 'sdk' ||
      entry.namespace !== undefined ||
      entry.reachesTools !== undefined
    ) {
      throw new Error(REGISTRY_CODE);
    }
  }
}

function readBudget(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error('strict_invalid_budget');
  }
  return value;
}

/** Safe, fixed error text. Raw denied input is never echoed. */
function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

/** Options accepted by the controlled Pi host. */
export interface StrictPiSessionOptions {
  /** Trusted model runtime. The caller owns its credentials and transport. */
  readonly modelRuntime: CreateAgentSessionOptions['modelRuntime'];
  /** Trusted model selection. */
  readonly model: CreateAgentSessionOptions['model'];
  /** Working directory reported to Pi. No project resources are discovered. */
  readonly cwd?: string;
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];

  readonly sessionId: StrictSessionOptions['sessionId'];
  readonly files: StrictSessionOptions['files'];
  readonly tools: StrictSessionOptions['tools'];
  readonly policy: StrictSessionOptions['policy'];
  readonly audit: StrictSessionOptions['audit'];
  readonly now?: StrictSessionOptions['now'];
  readonly semantic?: StrictSessionOptions['semantic'];
  readonly advisoryDigest?: StrictSessionOptions['advisoryDigest'];
  readonly protectedPaths?: StrictSessionOptions['protectedPaths'];

  /** Pinned advisory snapshot. Omission means no advisory content at all. */
  readonly advisorySnapshot?: AdvisorySnapshot;
  /** Requirement egress for direct host prompts. Defaults to `denied`. */
  readonly requirementEgress?: 'allowed' | 'denied';

  /** Maximum tool executions in one prompt run. Default 32, maximum 1024. */
  readonly maxToolCalls?: number;
  /** Maximum assistant turns in one prompt run. Default 16, maximum 1024. */
  readonly maxTurns?: number;
  /** Milliseconds before the host aborts one prompt run. Default 120000, maximum 3600000. */
  readonly promptTimeoutMs?: number;
}

/** Frozen facade returned to the host. There is no raw session escape hatch. */
export interface StrictPiHost {
  readonly prompt: (text: string) => Promise<string>;
  readonly stop: () => Promise<void>;
  readonly changes: () => readonly StrictChange[];
  readonly policyDigest: string;
}

const ALLOWED_OPTION_KEYS: ReadonlySet<string> = new Set([
  'modelRuntime',
  'model',
  'cwd',
  'thinkingLevel',
  'sessionId',
  'files',
  'tools',
  'policy',
  'audit',
  'now',
  'semantic',
  'advisoryDigest',
  'protectedPaths',
  'advisorySnapshot',
  'requirementEgress',
  'maxToolCalls',
  'maxTurns',
  'promptTimeoutMs',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCoreTools(value: unknown): CoreToolName[] {
  if (!Array.isArray(value)) {
    throw new Error('strict_invalid_tool_list');
  }
  const allowed = new Set<string>(CORE_TOOL_NAMES);
  const result: CoreToolName[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry)) {
      throw new Error('strict_invalid_tool_list');
    }
    if (!result.includes(entry as CoreToolName)) {
      result.push(entry as CoreToolName);
    }
  }
  return result;
}

/**
 * Policy rule IDs that are active enforcement rules. Pinned advisory rules may
 * only pair with one of these IDs; advisory-only rules are not enforcement.
 */
function collectEnforcementRuleIds(policy: unknown): readonly string[] {
  if (!Array.isArray(policy)) {
    return Object.freeze([]);
  }
  const ids: string[] = [];
  for (const entry of policy) {
    if (
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      entry.id.length > 0 &&
      entry.enforcement !== 'advisory'
    ) {
      ids.push(entry.id);
    }
  }
  return Object.freeze(ids);
}

function readRequirementEgress(value: unknown): 'allowed' | 'denied' {
  if (value === undefined) {
    return 'denied';
  }
  if (value === 'allowed' || value === 'denied') {
    return value;
  }
  throw new Error('strict_invalid_requirement_egress');
}

/** Literal JSON schemas avoid a TypeBox dependency in this adapter. */
function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
): ToolDefinition['parameters'] {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  } as unknown as ToolDefinition['parameters'];
}

const SCHEMAS: Readonly<Record<CoreToolName, ToolDefinition['parameters']>> =
  Object.freeze({
    read: schema({ path: { type: 'string' } }, ['path']),
    list: schema({ path: { type: 'string' } }, []),
    write: schema(
      { path: { type: 'string' }, content: { type: 'string' } },
      ['path', 'content'],
    ),
    edit: schema(
      {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      ['path', 'oldText', 'newText'],
    ),
    delete: schema({ path: { type: 'string' } }, ['path']),
  });

const DESCRIPTIONS: Readonly<Record<CoreToolName, string>> = Object.freeze({
  read: 'Read one file from the in-memory workspace.',
  list: 'List in-memory workspace entries, optionally under a directory.',
  write: 'Create or replace one in-memory workspace file.',
  edit: 'Replace exactly one occurrence of oldText in an in-memory file.',
  delete: 'Delete one in-memory workspace file.',
});

/**
 * Closed input shape. Extra own keys (for example `sessionId`, `approval`, or
 * `area`) are rejected before dispatch rather than silently stripped, so model
 * input can never smuggle host authority fields past the adapter.
 */
const TOOL_INPUT_KEYS: Readonly<Record<CoreToolName, readonly string[]>> =
  Object.freeze({
    read: ['path'],
    list: ['path'],
    write: ['path', 'content'],
    edit: ['path', 'oldText', 'newText'],
    delete: ['path'],
  });

type PickedToolInput =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly code: string };

function pickToolInput(
  coreName: CoreToolName,
  params: unknown,
): PickedToolInput {
  try {
    if (!isRecord(params)) {
      return { ok: false, code: INVALID_TOOL_INPUT_CODE };
    }
    if (Object.getOwnPropertySymbols(params).length > 0) {
      return { ok: false, code: INVALID_TOOL_INPUT_CODE };
    }
    const keys = Object.getOwnPropertyNames(params);
    const allowed = TOOL_INPUT_KEYS[coreName];
    if (keys.some((key) => !allowed.includes(key))) {
      return { ok: false, code: INVALID_TOOL_INPUT_CODE };
    }

    // Copy only own data properties into a plain null-prototype object. The
    // strict core repeats this validation and rejects accessors or symbol keys.
    const input: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(params, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        return { ok: false, code: INVALID_TOOL_INPUT_CODE };
      }
      input[key] = descriptor.value;
    }
    return { ok: true, input };
  } catch {
    return { ok: false, code: INVALID_TOOL_INPUT_CODE };
  }
}

function strictTarget(pathValue: unknown): string | null {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return null;
  }
  if (pathValue.startsWith(`${STRICT_WORKSPACE}/`)) {
    return pathValue;
  }
  if (pathValue.startsWith('/')) {
    return `${STRICT_WORKSPACE}${pathValue}`;
  }
  return `${STRICT_WORKSPACE}/${pathValue}`;
}

function dataText(value: StrictToolResult['data']): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .join('\n');
  }
  return '';
}

function failureResult(
  status: StrictToolResult['status'],
  code: unknown,
  terminate = false,
): AgentToolResult<unknown> {
  const safe = safeCode(code, FALLBACK_CODE[status] ?? 'strict_denied');
  return {
    content: [{ type: 'text', text: safe }],
    details: { status, code: safe },
    isError: true,
    ...(terminate ? { terminate: true } : {}),
  };
}

/** A poisoned core result is terminal for the whole host run. */
function terminalCoreCode(code: string): string | null {
  if (code === 'audit_unavailable') {
    return AUDIT_UNAVAILABLE_CODE;
  }
  if (code === 'internal_error') {
    return INTERNAL_ERROR_CODE;
  }
  return null;
}

/**
 * Return the final assistant text of one completed run, or null when the run
 * did not end with a completed assistant stop. Only messages appended during
 * the current prompt are passed here.
 */
function completedAssistantText(
  messages: readonly unknown[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'assistant') {
      continue;
    }
    if (message.stopReason !== 'stop') {
      return null;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      return null;
    }
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');
  }
  return null;
}

/**
 * Build a controlled Pi SDK host. Only the model/modelRuntime pair is trusted
 * caller input; all other host resources are constructed here.
 */
export async function createStrictPiSession(
  options: StrictPiSessionOptions,
): Promise<StrictPiHost> {
  if (!isRecord(options)) {
    throw new Error('strict_invalid_options');
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error('strict_unsafe_host_option');
    }
  }
  if (options.model === undefined || options.modelRuntime === undefined) {
    throw new Error('strict_missing_model');
  }

  const maxToolCalls = readBudget(
    options.maxToolCalls,
    DEFAULT_MAX_TOOL_CALLS,
    MAX_TOOL_CALLS,
  );
  const maxTurns = readBudget(options.maxTurns, DEFAULT_MAX_TURNS, MAX_TURNS);
  const promptTimeoutMs = readBudget(
    options.promptTimeoutMs,
    DEFAULT_PROMPT_TIMEOUT_MS,
    MAX_PROMPT_TIMEOUT_MS,
  );

  const coreTools = normalizeCoreTools(options.tools);
  const requestedModelTools = coreTools.map((name) => MODEL_TOOL_NAME[name]);

  const requestedSnapshot = options.advisorySnapshot;
  let snapshot: AdvisorySnapshot | undefined;
  if (requestedSnapshot !== undefined) {
    try {
      // Validate and pin a private deep-frozen copy. Later caller mutation of
      // the supplied object cannot make emitted text diverge from the digest.
      snapshot = compileAdvisorySnapshot(requestedSnapshot, {
        activeEnforcementRuleIds: collectEnforcementRuleIds(options.policy),
      });
    } catch {
      throw new Error('strict_invalid_advisory_snapshot');
    }
  }

  const egress = readRequirementEgress(options.requirementEgress);
  // A pinned snapshot is authoritative for provenance; a caller-supplied
  // digest is only used when no snapshot is present.
  const provenanceDigest =
    snapshot === undefined ? options.advisoryDigest : snapshot.advisoryDigest;

  const strictOptions: StrictSessionOptions = {
    sessionId: options.sessionId,
    files: options.files,
    tools: coreTools,
    policy: options.policy,
    audit: options.audit,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.semantic === undefined ? {} : { semantic: options.semantic }),
    ...(options.protectedPaths === undefined
      ? {}
      : { protectedPaths: options.protectedPaths }),
    ...(provenanceDigest === undefined
      ? {}
      : { advisoryDigest: provenanceDigest }),
  };
  const strict = createStrictSession(strictOptions);

  let injector: InjectorSession | null = null;
  if (snapshot !== undefined) {
    try {
      injector = createInjectorSession(snapshot);
    } catch {
      // An unusable advisory snapshot must not disable the controlled host.
      injector = null;
    }
  }

  // The resource loader is the only discovery gate in Pi. Returning empty
  // collections here means no extension, skill, prompt, theme, or context file
  // from cwd/agentDir can ever be loaded. `runtime` is an empty extension
  // runtime, so command and tool-search surfaces are absent too.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => FIXED_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const cwd = resolve(options.cwd ?? process.cwd());
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  // Per-host and per-run state. Budgets are reset at the start of each prompt
  // and are enforced from session events, including calls to names that are
  // not registered as tools.
  let running = false;
  let stopped = false;
  let activeRun = false;
  let runFailure: string | null = null;
  let toolCallsInRun = 0;
  let turnsInRun = 0;
  let unsubscribe: (() => void) | null = null;
  let appendSystemPrompt: string[] = [];

  const toolDefinitions: ToolDefinition[] = [];
  for (const coreName of coreTools) {
    const modelName = MODEL_TOOL_NAME[coreName];
    const definition: ToolDefinition = {
      name: modelName,
      label: modelName,
      description: DESCRIPTIONS[coreName],
      promptSnippet: DESCRIPTIONS[coreName],
      parameters: SCHEMAS[coreName],
      executionMode: 'sequential',
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        if (stopped || runFailure !== null) {
          return failureResult(
            'stopped',
            runFailure ?? 'strict_host_stopped',
            true,
          );
        }
        const picked = pickToolInput(coreName, params);
        if (!picked.ok) {
          return failureResult('denied', picked.code);
        }
        const input = picked.input;
        const request = { tool: coreName, input };

        let result: StrictToolResult;
        try {
          result = await strict.dispatch(request);
        } catch {
          // A thrown core dispatch is terminal; never surface its error or
          // model input to the model.
          haltRun(INTERNAL_ERROR_CODE);
          return failureResult('denied', INTERNAL_ERROR_CODE, true);
        }

        if (result.status !== 'executed') {
          const terminal = terminalCoreCode(result.code);
          if (terminal !== null) {
            haltRun(terminal);
            return failureResult(result.status, terminal, true);
          }
          return failureResult(result.status, result.code);
        }

        const content: Array<{ type: 'text'; text: string }> = [
          {
            type: 'text',
            text:
              result.data === undefined
                ? safeCode(result.code, 'executed')
                : dataText(result.data),
          },
        ];

        // Area guidance is appended as an independent block after a successful
        // in-memory write/edit. Every injector failure is contained here and
        // cannot change the core result or its audit record.
        if (
          injector !== null &&
          (coreName === 'write' || coreName === 'edit')
        ) {
          try {
            const target = strictTarget(input.path);
            if (
              target !== null &&
              injector.queueAction(
                {
                  tool: coreName,
                  operation: 'file_write',
                  target,
                },
                STRICT_WORKSPACE,
              )
            ) {
              const block = injector.selectPendingArea();
              if (block !== null) {
                if (block.text.length > 0) {
                  content.push({ type: 'text', text: block.text });
                }
                // Commit only after the appended result is fully formed.
                injector.commit(block);
              }
            }
          } catch {
            // Advisory only.
          }
        }

        return {
          content,
          details: {
            status: result.status,
            code: safeCode(result.code, 'executed'),
          },
        };
      },
    };
    toolDefinitions.push(definition);
  }

  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    model: options.model,
    modelRuntime: options.modelRuntime,
    ...(options.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: options.thinkingLevel }),
    resourceLoader,
    sessionManager,
    settingsManager,
    customTools: toolDefinitions,
    // Exact allowlist: built-ins are filtered out of the registry, and only the
    // declared custom tools remain active. `noTools` is belt-and-braces, and
    // the explicit MCP denial keeps MCP tools out even if a future loader or
    // default changes the allowlist behavior.
    tools: requestedModelTools,
    excludeTools: ['mcp__*'],
    noTools: 'all',
  });

  function captureToolSurface(): StrictToolSurface {
    return {
      active: session.getActiveToolNames(),
      callable: session.getCallableToolNames(),
      registered: session.getAllTools().map((tool) => ({
        name: tool.name,
        exposure: tool.exposure,
        source: tool.sourceInfo.source,
        ...(tool.namespace === undefined
          ? {}
          : { namespace: tool.namespace }),
        ...(tool.reachesTools === undefined
          ? {}
          : { reachesTools: tool.reachesTools }),
      })),
    };
  }

  /**
   * Validate the actual SDK registry, not the requested declaration. Any
   * native, MCP, deferred, codemode, hidden, or duplicate tool fails closed.
   */
  function assertRegistry(): void {
    try {
      assertExactToolSurface(requestedModelTools, captureToolSurface());
      for (const name of FORBIDDEN_TOOL_NAMES) {
        if (session.getToolDefinition(name) !== undefined) {
          throw new Error(REGISTRY_CODE);
        }
      }
      for (const name of requestedModelTools) {
        const definition = session.getToolDefinition(name);
        if (definition === undefined || definition.name !== name) {
          throw new Error(REGISTRY_CODE);
        }
      }
    } catch {
      throw new Error(REGISTRY_CODE);
    }
  }

  try {
    assertRegistry();
  } catch {
    try {
      session.dispose();
    } catch {
      // The session may not have finished initializing.
    }
    try {
      strict.stop();
    } catch {
      // The core may already be stopped.
    }
    throw new Error(REGISTRY_CODE);
  }

  const activeToolNames = [...requestedModelTools];

  function detach(): void {
    const listener = unsubscribe;
    unsubscribe = null;
    if (listener !== null) {
      try {
        listener();
      } catch {
        // Detaching is best-effort.
      }
    }
  }

  /**
   * Hard-stop the host. This is a workflow guardrail, not a security boundary:
   * it aborts the agent loop and the strict core so a failed run cannot keep
   * dispatching in-memory mutations, then makes the fixed code observable to
   * the host prompt and all future prompts.
   */
  function haltHost(code: string): void {
    stopped = true;
    runFailure = code;
    activeRun = false;
    appendSystemPrompt = [];
    try {
      strict.stop();
    } catch {
      // The core may already be stopped.
    }
    try {
      void session.abort().catch(() => {
        // The agent loop may already be idle or aborted.
      });
    } catch {
      // Aborting is best-effort; the facade is revoked below.
    }
  }

  function haltRun(code: string): void {
    if (!activeRun || stopped) {
      return;
    }
    haltHost(code);
  }

  function requireRegistry(): void {
    try {
      assertRegistry();
    } catch {
      haltHost(REGISTRY_CODE);
      throw new Error(REGISTRY_CODE);
    }
  }

  unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    try {
      if (!activeRun || stopped) {
        return;
      }
      if (event.type === 'tool_execution_start') {
        toolCallsInRun += 1;
        if (toolCallsInRun > maxToolCalls) {
          haltRun(BUDGET_CODE.tool);
        }
        return;
      }
      if (event.type === 'turn_end') {
        turnsInRun += 1;
        if (turnsInRun > maxTurns) {
          haltRun(BUDGET_CODE.turn);
        }
      }
    } catch {
      // A listener must never break the agent loop. The prompt timeout and
      // per-tool guard remain in force if event accounting fails.
    }
  });

  async function prompt(text: string): Promise<string> {
    if (stopped) {
      throw new Error('strict_host_stopped');
    }
    if (running) {
      throw new Error('strict_host_busy');
    }

    // A non-string or blank direct input is not a requirement statement. Do
    // not run the model. The core has no public clear, so this best-effort
    // capture is followed by a rejection; because no run follows, no prior
    // frame can be consumed through this facade.
    if (typeof text !== 'string' || text.trim().length === 0) {
      try {
        strict.captureRequirement('', egress);
      } catch {
        // No model run follows, so a stale frame remains unreachable.
      }
      throw new Error('strict_invalid_prompt');
    }

    // Validate the live SDK surface before every prompt. Failure is terminal
    // and fixed-code; it is never treated as an advisory injection problem.
    requireRegistry();

    running = true;
    activeRun = true;
    runFailure = null;
    toolCallsInRun = 0;
    turnsInRun = 0;
    appendSystemPrompt = [];
    let block: InjectionBlock | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let messageStart = session.messages.length;
    try {
      try {
        strict.captureRequirement(text, egress);
      } catch {
        try {
          strict.captureRequirement('', egress);
        } catch {
          // Fail closed below.
        }
        throw new Error('strict_requirement_unavailable');
      }

      if (injector !== null) {
        try {
          block = injector.selectPrompt(text);
          appendSystemPrompt =
            block.text.length === 0
              ? []
              : [`${ADVISORY_HEADER}\n\n${block.text}`];
        } catch {
          appendSystemPrompt = [];
          block = null;
        }
      }

      // Rebuild the base system prompt from the mutable append section before
      // the run starts. A failure here is a registry failure, not advisory.
      try {
        session.setActiveToolsByName(activeToolNames);
      } catch {
        haltHost(REGISTRY_CODE);
        throw new Error(REGISTRY_CODE);
      }
      requireRegistry();

      // Capture the transcript boundary for this run. Text from earlier runs
      // is never eligible to be returned by this prompt.
      messageStart = session.messages.length;

      // One bounded run. The timer is cleared in `finally` on every exit.
      timeout = setTimeout(() => {
        haltRun(BUDGET_CODE.timeout);
      }, promptTimeoutMs);

      // The model receives no template, skill, or extension command expansion.
      await session.prompt(text, { expandPromptTemplates: false });

      if (runFailure !== null) {
        throw new Error(runFailure);
      }
      if (stopped) {
        throw new Error('strict_host_stopped');
      }

      const completed = completedAssistantText(
        session.messages.slice(messageStart),
      );
      if (completed === null) {
        throw new Error(NO_COMPLETED_RESPONSE_CODE);
      }

      if (block !== null && injector !== null) {
        try {
          injector.commit(block);
        } catch {
          // Advisory only.
        }
      }
      block = null;
      appendSystemPrompt = [];

      return completed;
    } catch (error) {
      if (runFailure !== null) {
        throw new Error(runFailure);
      }
      if (stopped) {
        throw new Error('strict_host_stopped');
      }
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      activeRun = false;
      if (block !== null && injector !== null) {
        // The run never completed; leave the block uncommitted so it cannot
        // be mistaken for emitted guidance.
        appendSystemPrompt = [];
      }
      running = false;
      if (stopped) {
        detach();
      }
    }
  }

  async function stop(): Promise<void> {
    const wasStopped = stopped;
    stopped = true;
    activeRun = false;
    appendSystemPrompt = [];
    detach();
    if (wasStopped) {
      return;
    }
    try {
      strict.stop();
    } catch {
      // Stopping is best-effort; the host still revokes the facade below.
    }
    try {
      await session.abort();
    } catch {
      // The agent loop may already be idle.
    }
  }

  return Object.freeze({
    prompt,
    stop,
    changes: () => strict.changes(),
    policyDigest: strict.policyDigest,
  });
}
