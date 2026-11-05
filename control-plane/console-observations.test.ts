import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface ObservationViewModel {
  available: boolean;
  sources: unknown[];
  queue: unknown[];
}

test('console observations map ReviewQueue.records and preserve honest metadata', async () => {
  const modulePath = pathToFileURL(join(process.cwd(), 'console', 'app.js')).href;
  const module = (await import(modulePath)) as {
    normalizeObservationsResult?: (value: unknown) => ObservationViewModel;
  };
  assert.equal(typeof module.normalizeObservationsResult, 'function');
  const normalize = module.normalizeObservationsResult!;
  const source = {
    name: 'real-opencode.jsonl',
    lines: 12,
    truncated: true,
    error: null,
  };
  const record = { source: 'real-opencode.jsonl', line: 1 };

  assert.deepEqual(
    normalize({
      available: true,
      sources: [source],
      queue: {
        records: [record],
        zeroLevel: [],
        nonZeroDeny: [],
        confirm: { total: 0, selected: [] },
        gaps: [],
        gapReasonCounts: {},
      },
    }),
    { available: true, sources: [source], queue: [record] },
  );

  assert.deepEqual(normalize({ available: false, sources: [], queue: null }), {
    available: false,
    sources: [],
    queue: [],
  });
  assert.deepEqual(normalize({ available: true, sources: [], queue: {} }), {
    available: true,
    sources: [],
    queue: [],
  });
});
