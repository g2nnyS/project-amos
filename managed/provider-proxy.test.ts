import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createManagedProviderProxy } from './provider-proxy.ts';
import { ManagedError } from './contracts.ts';

const config = { endpoint:'http://127.0.0.1:1/v1/chat/completions', apiKey:'secret', model:'fixed', timeoutMs:30, allowLoopback:true };
const request = (body: unknown) => ({body:JSON.stringify(body)});
const base = () => ({ model:'fixed', messages:[{role:'user', content:'Visit https://example.org in documentation'}] });
const signal = () => new AbortController().signal;
const ok: typeof fetch = async () => new Response('{}', {headers:{'content-type':'application/json'}});

test('real loopback JSON and SSE text, function tools, streaming and tool messages', async () => {
  const seen: Array<{url:string|undefined; auth:string|undefined; body:any}> = [];
  const server = createServer((req,res) => { const chunks:Buffer[]=[]; req.on('data', c=>chunks.push(c)); req.on('end',()=> { const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push({url:req.url, auth:req.headers.authorization, body}); res.setHeader('content-type',body.stream ? 'text/event-stream' : 'application/json'); res.setHeader('set-cookie','secret-cookie'); res.setHeader('location','https://example.org'); res.end(body.stream ? 'data: {"choices":[]}\n\ndata: [DONE]\n\n' : '{"choices":[]}'); }); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat/completions`;
    const proxy = createManagedProviderProxy({...config, endpoint, timeoutMs:1000});
    const data = {...base(), messages:[{role:'user',content:[{type:'text',text:'hello'}]},{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'call',content:'done'}], tools:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{x:{type:'string'}}}}}]};
    for (const stream of [false,true]) { const result = await proxy.request(request({...data,stream,stream_options:{include_usage:true}}),signal()); assert.equal(result.status,200); assert.deepEqual(Object.keys(result.headers),['content-type']); assert.match(Buffer.from(result.bodyBase64,'base64').toString(),stream ? /\[DONE\]/ : /choices/); }
    assert.equal(seen[0].url,'/v1/chat/completions'); assert.equal(seen[0].auth,'Bearer secret'); assert.equal(seen[1].body.stream,true); assert.equal(seen[0].body.max_tokens,4096);
    const alternate = createManagedProviderProxy({...config, endpoint, timeoutMs:1000, maxTokens:123, tokenLimitField:'max_completion_tokens'});
    await alternate.request(request(base()),signal()); assert.equal(seen[2].body.max_completion_tokens,123); assert.equal(seen[2].body.max_tokens,undefined);
    for (const extra of [{n:1000},{n:0},{max_tokens:124},{max_tokens:0},{max_completion_tokens:1.5},{max_tokens:1,max_completion_tokens:1},{service_tier:'priority'}]) await assert.rejects(alternate.request(request({...base(),...extra}),signal()),ManagedError);
    assert.equal(seen.length,3);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('concurrent call quota and failed attempts consume quota', async () => {
  let count = 0; const pending: typeof fetch = () => { count++; return new Promise(() => {}); };
  const proxy = createManagedProviderProxy({...config, timeoutMs:30, maxCalls:2, fetchImpl:pending});
  const results = await Promise.allSettled([proxy.request(request(base()),signal()),proxy.request(request(base()),signal()),proxy.request(request(base()),signal())]);
  assert.equal(count,2); assert.ok(results.every(r=>r.status === 'rejected'));
  let failures = 0;
  const failure:typeof fetch = async () => { failures++; return new Response('error',{status:500}); };
  const failing = createManagedProviderProxy({...config,maxCalls:1,fetchImpl:failure});
  await assert.rejects(failing.request(request(base()),signal()),ManagedError);
  await assert.rejects(failing.request(request(base()),signal()),ManagedError);
  assert.equal(failures,1);
});

test('strict request rejects hostile routes, models, payloads, hosted tools and attachments', async () => {
  for (const endpoint of ['https://api.openai.com/v1/files','https://api.openai.com/v1/chat/completions?key=secret','https://user:secret@api.openai.com/v1/chat/completions','https://evil.example/v1/chat/completions','https://openrouter.ai/v1/chat/completions']) assert.throws(()=>createManagedProviderProxy({...config,endpoint}),ManagedError);
  const proxy = createManagedProviderProxy({...config,fetchImpl:ok});
  const inputs: unknown[] = [{body:'{}',headers:{}},{body:'not json'},request({...base(),model:'other'}),request({...base(),extra:true}),request({...base(),tools:[{type:'web_search'}]}),request({...base(),tools:[{type:'code_interpreter'}]}),request({...base(),messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://evil'}}]}]}),request({...base(),messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'x'}}]}]}),request({...base(),messages:[{role:'user',content:[{type:'file',file:{file_id:'x'}}]}]})];
  for (const input of inputs) await assert.rejects(proxy.request(input,signal()),ManagedError);
  const getter = Object.defineProperty({},'body',{enumerable:true,get(){throw Error('secret');}}); await assert.rejects(proxy.request(getter,signal()),ManagedError);
});

test('redirect, provider errors and request/response byte bounds stop without disclosure', async () => {
  const run = (fetchImpl:typeof fetch, opts:object = {}) => createManagedProviderProxy({...config,...opts,fetchImpl}).request(request(base()),signal());
  await assert.rejects(run(async (_u,init)=>{assert.equal(init?.redirect,'error');return new Response('secret',{status:302,headers:{location:'https://evil'}});}),ManagedError);
  await assert.rejects(run(async ()=>new Response('secret',{status:401})), e=>e instanceof ManagedError && !e.message.includes('secret'));
  await assert.rejects(run(ok,{maxRequestBytes:4}),ManagedError);
  await assert.rejects(run(async()=>new Response('x'.repeat(20),{headers:{'content-type':'application/json'}}),{maxResponseBytes:5}),ManagedError);
});

test('timeouts, external abort, active and late body cancellation', async () => {
  let cancelled = 0;
  const stuck:typeof fetch = async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++; return new Promise(()=>{});}}),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(createManagedProviderProxy({...config,fetchImpl:stuck}).request(request(base()),signal()),ManagedError); assert.ok(cancelled>0);
  let resolveFetch!: (r:Response)=>void; let cancelledLate!:()=>void;
  const cancellation = new Promise<void>(resolve=>{cancelledLate=resolve;});
  const pending:typeof fetch = ()=>new Promise(resolve=>{resolveFetch=resolve;});
  const proxy = createManagedProviderProxy({...config,fetchImpl:pending});
  await assert.rejects(proxy.request(request(base()),signal()),ManagedError);
  resolveFetch(new Response(new ReadableStream({cancel(){cancelledLate();}}),{headers:{'content-type':'application/json'}})); await cancellation;
  const ac = new AbortController(); const result = proxy.request(request(base()),ac.signal); ac.abort(); await assert.rejects(result,ManagedError);
  await assert.rejects(createManagedProviderProxy({...config,fetchImpl:async()=>{throw Error('secret');}}).request(request(base()),signal()), e=>e instanceof ManagedError && !e.message.includes('secret'));
});
