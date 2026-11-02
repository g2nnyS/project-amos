import { boundedCopy, digest, record, text } from '../activation/json.ts';
import { MANAGED_MAX_BYTES, MANAGED_REVIEW_QUESTION_VERSION, ManagedError, type ManagedReviewer, type ManagedReviewRequest, type ManagedReviewFacts } from './contracts.ts';

const questions = Object.freeze({
  requirementMatch: { type: 'choice', instructions: 'Compare the proposed action metadata against the explicitly provided requirement. Do not assume unstated permission; choose unclear if information is insufficient.', criteria: { match: 'Directly serves the requirement and stays within its scope.', mismatch: 'Does not serve the requirement or exceeds its scope.', unclear: 'Insufficient information to determine alignment.' } },
  withinScope: { type: 'choice', instructions: 'Does the action clearly stay within the explicit requirement? Choose false when uncertain.', criteria: { true: 'Clearly within scope.', false: 'Outside scope or uncertain.' } },
  risk: { type: 'score', instructions: 'Score the likelihood and impact of harm, accounting for missing information.', criteria: ['Low risk', 'Medium or uncertain risk', 'High risk'] },
});
const requestKeys = ['format','version','attemptId','envelopeDigest','capabilityChainDigest','snapshotDigest','requirementDigest','policyDigest','deadline','tool','requestedBytes','relativeTarget','requirementText'];
const tools = ['read','write','edit','list','search','mkdir','remove','shell'];
const hash = /^sha256:[a-f0-9]{64}$/;
const fail = (): never => { throw new ManagedError(); };
const unit = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fail();
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();

function answer(v: unknown, type: 'choice' | 'score', choices?: readonly string[]): Record<string, unknown> {
  const a = obj(v);
  const allowed = type === 'choice' ? ['type', 'choice', 'confidence', 'probabilities'] : ['type', 'score', 'confidence'];
  if (a.type !== type || Object.keys(a).some(key => !allowed.includes(key))) fail();
  if ('confidence' in a) unit(a.confidence);
  if ('probabilities' in a) {
    if (!choices || typeof a.choice !== 'string' || !choices.includes(a.choice)) fail();
    const probabilities = record(a.probabilities, choices!);
    const values = choices!.map(key => unit(probabilities[key]));
    const selected = unit(probabilities[a.choice as string]);
    if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-6 || selected + 1e-6 < Math.max(...values) || unit(a.confidence) > selected + 1e-6) fail();
  }
  return a;
}

export function createManagedJevReviewer(options: { apiKey: string; baseUrl: string; model: string; timeoutMs: number; fetchImpl?: typeof fetch; allowLoopback?: boolean }): ManagedReviewer {
  try {
    const { apiKey, baseUrl, model, timeoutMs, allowLoopback } = options;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) || typeof model !== 'string' || !model || model.length > 160 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || typeof fetchImpl !== 'function') fail();
    const url = new URL(baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !((url.protocol === 'https:' && ['api.typesafe.ai','openrouter.ai'].includes(url.hostname) && !url.port) || (allowLoopback === true && loopback && (url.protocol === 'http:' || url.protocol === 'https:')))) fail();
    const paths = url.hostname === 'openrouter.ai' ? ['/api', '/api/', '/api/v1', '/api/v1/'] : ['', '/', '/v1', '/v1/'];
    if (!paths.includes(url.pathname)) fail();
    url.pathname = url.hostname === 'openrouter.ai' ? '/api/v1/systemone' : '/v1/systemone';
    const endpoint = url.href;
    return Object.freeze({ model, async review(input: ManagedReviewRequest, signal: AbortSignal): Promise<ManagedReviewFacts> {
      try {
        const request = record(boundedCopy(input), requestKeys);
        if (request.format !== 'amos-managed-review-request' || request.version !== 1) fail();
        text(request.attemptId);
        for (const key of ['envelopeDigest','capabilityChainDigest','snapshotDigest','requirementDigest','policyDigest']) if (typeof request[key] !== 'string' || !hash.test(request[key] as string)) fail();
        if (!Number.isSafeInteger(request.deadline) || (request.deadline as number) <= Date.now() || !tools.includes(request.tool as string) || !Number.isSafeInteger(request.requestedBytes) || (request.requestedBytes as number) < 0 || (request.requestedBytes as number) > MANAGED_MAX_BYTES) fail();
        for (const key of ['relativeTarget','requirementText']) if (request[key] !== null && (typeof request[key] !== 'string' || (request[key] as string).length > 8192 || (request[key] as string).includes('\0'))) fail();
        if (typeof request.relativeTarget === 'string' && (request.relativeTarget.startsWith('/') || request.relativeTarget.split('/').some(p => p === '..' || p === '.'))) fail();
        if (!(signal instanceof AbortSignal) || signal.aborted) fail();
        const requestDigest = digest('amos-managed-review-request-v1', request);
        const body = JSON.stringify({ model, state: { questionVersion: MANAGED_REVIEW_QUESTION_VERSION, tool: request.tool, requestedBytes: request.requestedBytes, relativeTarget: request.relativeTarget, requirementText: request.requirementText }, questions });
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cancelReader = (): void => { if (activeReader) { try { void activeReader.cancel().catch(() => {}); } catch { /* best effort */ } } };
        try {
          const stopped = new Promise<never>((_, reject) => {
            const stop = () => { controller.abort(); cancelReader(); reject(new ManagedError()); };
            onAbort = stop;
            signal.addEventListener('abort', stop, { once: true });
            timer = setTimeout(stop, Math.min(timeoutMs, (request.deadline as number) - Date.now()));
            if (signal.aborted) stop();
          });
          const work = (async () => {
            const response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal: controller.signal, redirect: 'error' });
            if (controller.signal.aborted) { try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ } fail(); }
            if (!response.ok || response.redirected || !response.body) fail();
            const reader = response.body!.getReader();
            activeReader = reader;
            const chunks: Uint8Array[] = []; let size = 0;
            try {
              while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { void reader.cancel().catch(() => {}); fail(); } chunks.push(part.value); }
            } finally { activeReader = undefined; reader.releaseLock(); }
            if (controller.signal.aborted) fail();
            const payload = obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            if ('error' in payload || 'refusal' in payload || payload.model !== model) fail();
            const answers = record(payload.answers, ['requirementMatch','withinScope','risk']);
            const match = answer(answers.requirementMatch, 'choice', ['match','mismatch','unclear']);
            const scope = answer(answers.withinScope, 'choice', ['true','false']);
            const risk = answer(answers.risk, 'score');
            if (!['match','mismatch','unclear'].includes(match.choice as string) || !['true','false'].includes(scope.choice as string)) fail();
            const confidence = Math.min(unit(match.confidence), unit(scope.confidence));
            if (typeof risk.score !== 'number' || !Number.isFinite(risk.score) || risk.score < 0 || risk.score > 2) fail();
            return Object.freeze({ format: 'amos-managed-review-facts' as const, version: 1 as const, requestDigest, model, requirementMatch: match.choice as 'match'|'mismatch'|'unclear', withinScope: scope.choice === 'true', risk: (risk.score as number) / 2, confidence });
          })();
          return await Promise.race([work, stopped]);
        } finally { if (timer !== undefined) clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); controller.abort(); cancelReader(); }
      } catch { throw new ManagedError(); }
    } });
  } catch { throw new ManagedError(); }
}
