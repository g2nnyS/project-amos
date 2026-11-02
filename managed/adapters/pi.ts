import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model, Api } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import type { ManagedInput, ManagedResult } from '../contracts.ts';

/** SDK bridge only. Isolation and provider credential protection are the caller's responsibility. */
export interface PiAdapterOptions {
  readonly dispatch: (input: ManagedInput) => Promise<ManagedResult>;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  /** Trusted per-request HTTP transport; no process-global fetch mutation. */
  readonly fetch?: typeof globalThis.fetch;
  /** Empty, caller-owned scratch directory, not a real project checkout. */
  readonly scratchDirectory: string;
}
export interface PiAdapter {
  readonly registeredToolNames: readonly string[];
  prompt(userText: string): Promise<void>;
  close(): Promise<void>;
}

const names = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'mkdir', 'remove'] as const;
type Name = typeof names[number];
const fields: Record<Name, readonly string[]> = {
  read: ['path'], write: ['path', 'content'], edit: ['path', 'oldText', 'newText'],
  ls: ['path'], find: ['path', 'query'], grep: ['path', 'query'], bash: ['command'],
  mkdir: ['path'], remove: ['path'],
};

function convert(name: Name, args: Record<string, unknown>): ManagedInput {
  if (Object.keys(args).length !== fields[name].length || fields[name].some(k => typeof args[k] !== 'string')) throw new Error('invalid_tool_input');
  const s = (key: string) => args[key] as string;
  switch (name) {
    case 'read': return { tool: 'read', path: s('path') };
    case 'write': return { tool: 'write', path: s('path'), content: s('content') };
    case 'edit': return { tool: 'edit', path: s('path'), oldText: s('oldText'), newText: s('newText') };
    case 'ls': return { tool: 'list', path: s('path') };
    case 'find': case 'grep': return { tool: 'search', path: s('path'), query: s('query') };
    case 'bash': return { tool: 'shell', command: s('command') };
    case 'mkdir': return { tool: 'mkdir', path: s('path') };
    case 'remove': return { tool: 'remove', path: s('path') };
  }
}

function loader(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('resource_discovery_disabled'); },
    reload: async () => {},
  };
}

export async function createPiAdapter(options: PiAdapterOptions): Promise<PiAdapter> {
  const scratch = await realpath(options.scratchDirectory);
  const temp = await realpath(tmpdir());
  const relativeScratch = relative(temp, scratch);
  if (!relativeScratch || relativeScratch === '..' || relativeScratch.startsWith(`..${sep}`) || isAbsolute(relativeScratch) || !(await stat(scratch)).isDirectory()) throw new Error('invalid_scratch_directory');
  const tools: ToolDefinition[] = names.map(name => ({
    name, label: name, description: `Managed ${name} operation.`,
    parameters: Type.Object(Object.fromEntries(fields[name].map(field => [field, Type.String()])), { additionalProperties: false }),
    execute: async (_id, args) => {
      try {
        const result = await options.dispatch(convert(name, args as Record<string, unknown>));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      } catch {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_executed', code: 'managed_dispatch_failed' }) }], details: undefined };
      }
    },
  }));
  const runtime = options.fetch ? new Proxy(options.modelRuntime, {
    get(target, key) {
      if (key === 'streamSimple') return (...args: Parameters<ModelRuntime['streamSimple']>) => target.streamSimple(args[0], args[1], { ...args[2], fetch: options.fetch });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : options.modelRuntime;
  const { session } = await createAgentSession({
    cwd: scratch, agentDir: scratch,
    model: options.model, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(scratch),
    resourceLoader: loader(), tools: [...names], customTools: tools,
  });
  const actual = session.getActiveToolNames();
  if (actual.length !== names.length || names.some(name => !actual.includes(name))) { session.dispose(); throw new Error('unexpected_tools'); }
  let closed = false;
  return {
    registeredToolNames: Object.freeze([...actual]),
    async prompt(text) { if (closed) throw new Error('adapter_closed'); await session.prompt(text, { expandPromptTemplates: false }); },
    async close() { if (!closed) { closed = true; await session.abort(); session.dispose(); } },
  };
}
