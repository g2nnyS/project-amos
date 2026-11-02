import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { digest } from '../activation/json.ts';
import { ManagedError, MANAGED_REVIEW_QUESTION_VERSION, type ManagedReviewRequest } from './contracts.ts';
import { createManagedJevReviewer } from './reviewer.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const request = (): ManagedReviewRequest => ({ format:'amos-managed-review-request', version:1, attemptId:'attempt', envelopeDigest:hash, capabilityChainDigest:hash, snapshotDigest:hash, requirementDigest:hash, policyDigest:hash, deadline:Date.now()+5000, tool:'read', requestedBytes:10, relativeTarget:'src/a', requirementText:'inspect a' });
const response = () => ({ model:'fixed', answers: { requirementMatch:{type:'choice',choice:'match',confidence:0.9}, withinScope:{type:'choice',choice:'true',confidence:0.8}, risk:{type:'score',score:0.4} } });
const config = { apiKey:'secret', baseUrl:'http://127.0.0.1:1', model:'fixed', timeoutMs:100, allowLoopback:true };
const fake = (payload: unknown): typeof fetch => async () => new Response(JSON.stringify(payload));

test('loopback System One protocol and request binding', async () => {
  let captured: any;
  const server = createServer((req,res) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => { captured = { body: JSON.parse(Buffer.concat(chunks).toString()), url:req.url, auth:req.headers.authorization }; res.setHeader('content-type','application/json'); res.end(JSON.stringify(response())); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as {port:number}).port;
    const reviewer = createManagedJevReviewer({ ...config, baseUrl:`http://127.0.0.1:${port}`, timeoutMs:1000 });
    const input = request(); const facts = await reviewer.review(input, new AbortController().signal);
    assert.equal(facts.requestDigest, digest('amos-managed-review-request-v1', input));
    assert.equal(facts.risk, 0.2); assert.equal(facts.confidence, 0.8);
    assert.equal(captured.url, '/v1/systemone'); assert.equal(captured.auth, 'Bearer secret');
    assert.equal(captured.body.state.questionVersion, MANAGED_REVIEW_QUESTION_VERSION);
    assert.deepEqual(Object.keys(captured.body.questions), ['requirementMatch','withinScope','risk']);
    assert.equal(captured.body.state.requirementText, input.requirementText);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('invalid provider data and request are stopped', async () => {
  const variants: unknown[] = [ { ...response(), model:'other' }, { ...response(), refusal:'no' }, { ...response(), answers:{...response().answers, extra:{}} }, { ...response(), answers:{...response().answers, risk:{type:'score',score:3}} }, { ...response(), answers:{...response().answers, withinScope:{type:'choice',choice:'true',confidence:0.9,probabilities:{x:2}}} } ];
  for (const payload of variants) await assert.rejects(createManagedJevReviewer({...config, fetchImpl:fake(payload)}).review(request(), new AbortController().signal), ManagedError);
  const input = request(); Object.defineProperty(input, 'tool', { enumerable:true, get() { throw Error('leak'); } });
  await assert.rejects(createManagedJevReviewer({...config, fetchImpl:fake(response())}).review(input, new AbortController().signal), ManagedError);
});

test('choice probabilities are closed, normalized and consistent; score probabilities unsupported', async () => {
  const base = response();
  const choice = (extra: object) => ({...base, answers:{...base.answers, requirementMatch:{type:'choice',choice:'match',confidence:0.9,...extra}}});
  const variants = [
    choice({probabilities:{match:0.01,mismatch:0.99,unclear:0}}),
    choice({probabilities:{match:0.8,mismatch:0.1,unclear:0.1}}),
    choice({probabilities:{match:0.9,mismatch:0.2,unclear:0.1}}),
    choice({probabilities:{match:0.9,mismatch:0.1,unclear:0,other:0}}),
    choice({extra:'unexpected'}),
    {...base, answers:{...base.answers, risk:{type:'score',score:0.4,probabilities:{'0':1,'1':0,'2':0}}}},
  ];
  for (const payload of variants) await assert.rejects(createManagedJevReviewer({...config, fetchImpl:fake(payload)}).review(request(), new AbortController().signal), ManagedError);
  const valid = choice({probabilities:{match:0.9,mismatch:0.05,unclear:0.05}});
  assert.equal((await createManagedJevReviewer({...config, fetchImpl:fake(valid)}).review(request(), new AbortController().signal)).requirementMatch, 'match');
});

test('endpoint, redirects and response size', async () => {
  assert.throws(() => createManagedJevReviewer({...config, baseUrl:'https://user:password@api.typesafe.ai'}), ManagedError);
  assert.throws(() => createManagedJevReviewer({...config, baseUrl:'https://evil.example'}), ManagedError);
  await assert.rejects(createManagedJevReviewer({...config, fetchImpl: async (_u, init) => { assert.equal(init?.redirect, 'error'); return new Response('', {status:302, headers:{location:'https://evil.example'}}); }}).review(request(), new AbortController().signal), ManagedError);
  await assert.rejects(createManagedJevReviewer({...config, fetchImpl: async () => new Response('x'.repeat(65537))}).review(request(), new AbortController().signal), ManagedError);
});

test('absolute timeout and external abort ignore uncooperative fetch and body', async () => {
  let resolveFetch!: (r: Response) => void;
  const pending: typeof fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  const reviewer = createManagedJevReviewer({...config, timeoutMs:20, fetchImpl:pending});
  await assert.rejects(reviewer.review(request(), new AbortController().signal), ManagedError);
  resolveFetch(new Response(JSON.stringify(response())));
  const controller = new AbortController(); const result = reviewer.review(request(), controller.signal); controller.abort(); await assert.rejects(result, ManagedError);
  const stuck: typeof fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  await assert.rejects(createManagedJevReviewer({...config, timeoutMs:20, fetchImpl:stuck}).review(request(), new AbortController().signal), ManagedError);
});

test('timeout cancels active reader and discards and cancels late response body', async () => {
  let cancelled = 0;
  const stuck: typeof fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } }));
  await assert.rejects(createManagedJevReviewer({...config, timeoutMs:20, fetchImpl:stuck}).review(request(), new AbortController().signal), ManagedError);
  assert.ok(cancelled > 0);
  let resolveFetch!: (r: Response) => void;
  let lateCancel!: () => void;
  const cancellation = new Promise<void>(resolve => { lateCancel = resolve; });
  const pending: typeof fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  await assert.rejects(createManagedJevReviewer({...config, timeoutMs:20, fetchImpl:pending}).review(request(), new AbortController().signal), ManagedError);
  resolveFetch(new Response(new ReadableStream({ cancel() { lateCancel(); } })));
  await cancellation;
});
