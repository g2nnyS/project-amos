import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Plugin as PluginTypes } from '@opencode/plugin';
import type { ManagedInput, ManagedResult } from '../contracts.ts';

/** A bridge, not an isolation or provider security boundary. */
export interface OpenCodeAdapterOptions {
  readonly dispatch: (input: ManagedInput) => Promise<ManagedResult>;
  readonly scratchDirectory: string;
  readonly modelId: string;
  readonly baseUrl: string;
  /** In a dedicated child only: installed as global fetch before SDK import. */
  readonly fetch?: typeof globalThis.fetch;
}
export interface OpenCodeAdapter {
  readonly registeredToolNames: readonly string[];
  prompt(userText: string): Promise<void>;
  close(): Promise<void>;
}
const names = ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'mkdir', 'remove'] as const;
type Name = typeof names[number];
const fields: Record<Name, readonly string[]> = {
  read: ['path'], write: ['path', 'content'], edit: ['path', 'oldText', 'newText'],
  ls: ['path'], find: ['path', 'query'], grep: ['path', 'query'], bash: ['command'], mkdir: ['path'], remove: ['path'],
};
function convert(name: Name, input: unknown): ManagedInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_tool_input');
  const a = input as Record<string, unknown>;
  if (Object.keys(a).length !== fields[name].length || fields[name].some(k => typeof a[k] !== 'string')) throw new Error('invalid_tool_input');
  const s = (k: string) => a[k] as string;
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

/** Startup-only SDK plugin; callers must not register subsequent plugins. */
export async function createOpenCodeManagedPlugin(options: Pick<OpenCodeAdapterOptions, 'dispatch' | 'modelId' | 'baseUrl'>, onReady?: (names: readonly string[]) => void): Promise<PluginTypes.Plugin> {
  const { Plugin, Provider, Model } = await import('@opencode/plugin');
  const providerID = Provider.ID.make('amos-managed');
  const modelID = Model.ID.make(options.modelId);
  return Plugin.define({ id: 'amos-managed-bridge', async setup(ctx) {
    await ctx.provider.transform(editor => {
      for (const record of editor.list()) editor.remove(record.provider.id);
      editor.add({ info: { ...Provider.Info.empty(providerID), name: 'Managed', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: options.baseUrl } }, models: [{ ...Model.Info.default(providerID, modelID), name: options.modelId }] });
    });
    await ctx.model.transform(editor => { for (const model of editor.list()) if (model.providerID !== providerID || model.id !== modelID) editor.remove(model.providerID, model.id); editor.default.set(providerID, modelID); });
    await ctx.mcp.transform(editor => { for (const [name] of editor.list()) editor.remove(name); });
    // Late SDK registrations (e.g. browser tools) can appear after startup.
    // Restrict the model-request tool snapshot as well as the initial registry.
    await ctx.session.hook('context', event => {
      for (const name of Object.keys(event.tools)) if (!(names as readonly string[]).includes(name)) delete event.tools[name];
    });
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      for (const name of names) editor.add({
        name, description: `Managed ${name} operation.`,
        input: { type: 'object', properties: Object.fromEntries(fields[name].map(k => [k, { type: 'string' }])), required: [...fields[name]], additionalProperties: false },
        options: { codemode: false },
        execute: async input => {
          try { return { content: JSON.stringify(await options.dispatch(convert(name, input))) }; }
          catch { return { content: JSON.stringify({ status: 'not_executed', code: 'managed_dispatch_failed' }) }; }
        },
      });
    });
    const actual = (await ctx.tool.list()).map(tool => tool.id);
    if (actual.length !== names.length || names.some(name => !actual.includes(name))) throw new Error('unexpected_tools');
    onReady?.(Object.freeze(actual));
  } });
}

export async function createOpenCodeAdapter(options: OpenCodeAdapterOptions): Promise<OpenCodeAdapter> {
  const scratch = await realpath(options.scratchDirectory);
  const temp = await realpath(tmpdir());
  const rel = relative(temp, scratch);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(scratch)).isDirectory()) throw new Error('invalid_scratch_directory');
  if (options.fetch && globalThis.fetch !== options.fetch) throw new Error('opencode_transport_not_installed');
  // These paths are read by SDK modules at import time. The host must start a
  // dedicated process with these values, before importing any OpenCode module.
  for (const [key, value] of Object.entries({ XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'), OPENCODE_TEST_HOME: scratch })) {
    if (process.env[key] !== value) throw new Error('opencode_requires_dedicated_scratch_environment');
  }
  let registered: readonly string[] | undefined;
  const plugin = await createOpenCodeManagedPlugin(options, actual => { registered = actual; });
  const { OpenCode } = await import('@opencode/sdk');
  const sdk = await OpenCode.create({ config: { directory: join(scratch, 'config'), project: false, claude: false, content: '{}' }, database: { path: ':memory:' }, models: { fetch: false, snapshot: false }, plugins: [plugin] });
  try {
    const session = await sdk.sessions.create({ title: 'Managed session', location: { directory: scratch }, model: { providerID: 'amos-managed', id: options.modelId }, permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'execute', resource: '*', effect: 'deny' }] });
    await sdk.model.list({ location: { directory: scratch } });
    if (!registered) throw new Error('plugin_not_started');
    let closed = false;
    return {
      registeredToolNames: registered,
      async prompt(text) { if (closed) throw new Error('adapter_closed'); await sdk.sessions.prompt({ sessionID: session.id, text }); await sdk.sessions.wait({ sessionID: session.id }); },
      async close() { if (!closed) { closed = true; await sdk.close(); } },
    };
  } catch (error) { await sdk.close(); throw error; }
}
