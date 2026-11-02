import { boundedCopy } from '../activation/json.ts';
import { ManagedError } from './contracts.ts';

const fail = (): never => { throw new ManagedError(); };
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
function fields(v: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const r = obj(v);
  if (Object.keys(r).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(r, k))) fail();
  return r;
}
function str(v: unknown): string { return typeof v === 'string' ? v : fail(); }
function functionCall(v: unknown): void { const f = fields(v, ['name','arguments'], ['name','arguments']); str(f.name); str(f.arguments); }
function toolCall(v: unknown): void {
  const t = fields(v, ['id','type','function'], ['id','type','function']);
  str(t.id); if (t.type !== 'function') fail(); functionCall(t.function);
}
function message(v: unknown): void {
  const m = fields(v, ['role','content','name','tool_calls','tool_call_id','refusal'], ['role']);
  if (!['system','developer','user','assistant','tool'].includes(m.role as string)) fail();
  if ('name' in m) str(m.name);
  if ('refusal' in m && m.refusal !== null) str(m.refusal);
  if ('content' in m && m.content !== null) {
    if (typeof m.content !== 'string') {
      if (!Array.isArray(m.content)) fail();
      for (const part of m.content as unknown[]) { const p = fields(part, ['type','text'], ['type','text']); if (p.type !== 'text') fail(); str(p.text); }
    }
  }
  if ('tool_calls' in m) { if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) fail(); for (const t of m.tool_calls as unknown[]) toolCall(t); }
  if (m.role === 'tool') str(m.tool_call_id); else if ('tool_call_id' in m) fail();
}
function body(input: unknown, model: string, max: number, maxTokens: number, tokenLimitField: 'max_tokens' | 'max_completion_tokens'): string {
  const r = fields(boundedCopy(input), ['body'], ['body']);
  const raw = str(r.body);
  if (Buffer.byteLength(raw, 'utf8') > max) fail();
  const b = fields(boundedCopy(JSON.parse(raw)), ['model','messages','tools','tool_choice','parallel_tool_calls','stream','stream_options','temperature','top_p','max_tokens','max_completion_tokens','stop','presence_penalty','frequency_penalty','seed','n','response_format','user','service_tier'], ['model','messages']);
  if (b.model !== model || !Array.isArray(b.messages) || b.messages.length === 0) fail();
  if ('n' in b && b.n !== 1) fail();
  if ('service_tier' in b && b.service_tier !== 'default') fail();
  if ('max_tokens' in b && 'max_completion_tokens' in b) fail();
  for (const key of ['max_tokens','max_completion_tokens']) if (key in b && (!Number.isSafeInteger(b[key]) || (b[key] as number) < 1 || (b[key] as number) > maxTokens)) fail();
  if (!('max_tokens' in b) && !('max_completion_tokens' in b)) b[tokenLimitField] = maxTokens;
  for (const m of b.messages as unknown[]) message(m);
  if ('tools' in b) {
    if (!Array.isArray(b.tools)) fail();
    for (const tool of b.tools as unknown[]) {
      const t = fields(tool, ['type','function'], ['type','function']); if (t.type !== 'function') fail();
      const f = fields(t.function, ['name','description','parameters','strict'], ['name']); str(f.name);
      if ('description' in f) str(f.description); if ('strict' in f && typeof f.strict !== 'boolean' && f.strict !== null) fail();
      if ('parameters' in f) obj(f.parameters);
    }
  }
  if ('tool_choice' in b && typeof b.tool_choice !== 'string') { const t = fields(b.tool_choice, ['type','function'], ['type','function']); if (t.type !== 'function') fail(); const f = fields(t.function, ['name'], ['name']); str(f.name); }
  else if ('tool_choice' in b && !['none','auto','required'].includes(b.tool_choice as string)) fail();
  if ('response_format' in b) { const f = fields(b.response_format, ['type','json_schema'], ['type']); if (!['text','json_object','json_schema'].includes(f.type as string)) fail(); if ('json_schema' in f) { const s = fields(f.json_schema, ['name','description','schema','strict'], ['name','schema']); str(s.name); obj(s.schema); if ('description' in s) str(s.description); if ('strict' in s && typeof s.strict !== 'boolean' && s.strict !== null) fail(); } }
  if ('stream_options' in b) { const s = fields(b.stream_options, ['include_usage'], []); if ('include_usage' in s && typeof s.include_usage !== 'boolean') fail(); }
  for (const k of ['stream','parallel_tool_calls']) if (k in b && typeof b[k] !== 'boolean') fail();
  for (const k of ['temperature','top_p','max_tokens','max_completion_tokens','presence_penalty','frequency_penalty','seed','n']) if (k in b && (typeof b[k] !== 'number' || !Number.isFinite(b[k]))) fail();
  for (const k of ['user','service_tier']) if (k in b) str(b[k]);
  if ('stop' in b && b.stop !== null && typeof b.stop !== 'string' && (!Array.isArray(b.stop) || !b.stop.every(x => typeof x === 'string'))) fail();
  return JSON.stringify(b);
}

export function createManagedProviderProxy(options: { endpoint: string; apiKey: string; model: string; timeoutMs: number; maxRequestBytes?: number; maxResponseBytes?: number; maxCalls?: number; maxTokens?: number; tokenLimitField?: 'max_tokens' | 'max_completion_tokens'; fetchImpl?: typeof fetch; allowLoopback?: boolean }): { request(input: unknown, signal: AbortSignal): Promise<{status: number; headers: Readonly<Record<string,string>>; bodyBase64: string}> } {
  try {
    const { endpoint, apiKey, model, timeoutMs, allowLoopback } = options;
    const maxRequest = options.maxRequestBytes ?? 1_048_576, maxResponse = options.maxResponseBytes ?? 2_000_000;
    const maxCalls = options.maxCalls ?? 64, maxTokens = options.maxTokens ?? 4096, tokenLimitField = options.tokenLimitField ?? 'max_tokens';
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || typeof model !== 'string' || !model || model.length > 160 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxRequest) || maxRequest <= 0 || maxRequest > 2_000_000 || !Number.isSafeInteger(maxResponse) || maxResponse <= 0 || maxResponse > 10_000_000 || !Number.isSafeInteger(maxCalls) || maxCalls <= 0 || maxCalls > 1_000_000 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000 || !['max_tokens','max_completion_tokens'].includes(tokenLimitField) || typeof fetchImpl !== 'function') fail();
    const url = new URL(endpoint);
    const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    const official = url.protocol === 'https:' && !url.port && ((url.hostname === 'api.openai.com' && url.pathname === '/v1/chat/completions') || (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions'));
    const local = allowLoopback === true && loopback && ['http:','https:'].includes(url.protocol) && ['/v1/chat/completions','/api/v1/chat/completions'].includes(url.pathname);
    if (url.username || url.password || url.search || url.hash || (!official && !local)) fail();
    const target = url.href;
    let calls = 0;
    return Object.freeze({ async request(input: unknown, signal: AbortSignal) {
      try {
        const raw = body(input, model, maxRequest, maxTokens, tokenLimitField);
        if (!(signal instanceof AbortSignal) || signal.aborted) fail();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cancel = () => { if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } } };
        try {
          const stopped = new Promise<never>((_, reject) => { const stop = () => { controller.abort(); cancel(); reject(new ManagedError()); }; onAbort = stop; signal.addEventListener('abort', stop, {once:true}); timer = setTimeout(stop, timeoutMs); if (signal.aborted) stop(); });
          const work = (async () => {
            if (controller.signal.aborted || calls >= maxCalls) fail();
            calls++;
            const response = await fetchImpl(target, { method:'POST', headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', Accept:'application/json, text/event-stream' }, body:raw, redirect:'error', signal:controller.signal });
            if (controller.signal.aborted || !response.ok || response.redirected || !response.body) { try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ } fail(); }
            const contentType = response.headers.get('content-type');
            // Do not reflect arbitrary provider-controlled header values.
            if (!contentType || !/^(application\/json|text\/event-stream)(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) { try { void response.body!.cancel().catch(() => {}); } catch { /* best effort */ } fail(); }
            const active = response.body!.getReader(); reader = active;
            const chunks: Uint8Array[] = []; let size = 0;
            try { while (true) { const part = await active.read(); if (part.done) break; size += part.value.byteLength; if (size > maxResponse) { cancel(); fail(); } chunks.push(part.value); } }
            finally { reader = undefined; active.releaseLock(); }
            if (controller.signal.aborted) fail();
            return Object.freeze({ status:response.status, headers:Object.freeze({'content-type':contentType!}), bodyBase64:Buffer.concat(chunks).toString('base64') });
          })();
          return await Promise.race([work, stopped]);
        } finally { if (timer !== undefined) clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); controller.abort(); cancel(); }
      } catch { throw new ManagedError(); }
    } });
  } catch { throw new ManagedError(); }
}
