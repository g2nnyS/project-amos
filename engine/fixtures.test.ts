import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateWithMatches } from './engine.ts';

interface FixtureExpectation {
  verdict: string;
  matched_rule_ids: string[];
  error?: string;
}

interface Fixture {
  name: string;
  table: unknown;
  action: unknown;
  now: string;
  expect: FixtureExpectation;
}

interface LocatedFixture extends Fixture {
  file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadFixture(value: unknown, file: string, index: number): Fixture {
  const label = `${file}[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (typeof value.now !== 'string' || !Number.isFinite(Date.parse(value.now))) {
    throw new Error(`${label}.now must be a parseable ISO string`);
  }
  if (!('table' in value) || !('action' in value)) {
    throw new Error(`${label} must include table and action`);
  }
  if (!isRecord(value.expect)) {
    throw new Error(`${label}.expect must be an object`);
  }
  const expectation = value.expect;
  if (typeof expectation.verdict !== 'string') {
    throw new Error(`${label}.expect.verdict must be a string`);
  }
  if (
    !Array.isArray(expectation.matched_rule_ids) ||
    !expectation.matched_rule_ids.every((id) => typeof id === 'string')
  ) {
    throw new Error(`${label}.expect.matched_rule_ids must be a string array`);
  }
  if (expectation.error !== undefined && typeof expectation.error !== 'string') {
    throw new Error(`${label}.expect.error must be a string when present`);
  }

  return {
    name: value.name,
    table: value.table,
    action: value.action,
    now: value.now,
    expect: {
      verdict: expectation.verdict,
      matched_rule_ids: expectation.matched_rule_ids,
      ...(expectation.error === undefined ? {} : { error: expectation.error }),
    },
  };
}

function loadFixtures(): LocatedFixture[] {
  const fixturesDirectory = join(process.cwd(), 'fixtures');
  const files = readdirSync(fixturesDirectory)
    .filter((file) => file.endsWith('.json'))
    .sort();

  assert.ok(files.length > 0, 'fixtures directory must contain JSON files');

  const fixtures: LocatedFixture[] = [];
  for (const file of files) {
    const parsed = JSON.parse(
      readFileSync(join(fixturesDirectory, file), 'utf8'),
    ) as unknown;
    assert.ok(Array.isArray(parsed), `${file} must contain a fixture array`);
    assert.ok(parsed.length > 0, `${file} must contain at least one fixture`);
    parsed.forEach((entry, index) => {
      fixtures.push({ ...loadFixture(entry, file, index), file });
    });
  }
  return fixtures;
}

const FIXTURES = loadFixtures();
const NAMES = new Set(FIXTURES.map((fixture) => fixture.name));

test('fixture names are unique across all fixture files', () => {
  assert.equal(NAMES.size, FIXTURES.length);
});

test('all seven frozen predicate ops have fixture coverage', () => {
  const ops = new Set<string>();
  for (const fixture of FIXTURES) {
    if (fixture.expect.error !== undefined || !Array.isArray(fixture.table)) {
      continue;
    }
    for (const rule of fixture.table) {
      if (!isRecord(rule) || !Array.isArray(rule.predicate)) {
        continue;
      }
      for (const predicate of rule.predicate) {
        if (isRecord(predicate) && typeof predicate.op === 'string') {
          ops.add(predicate.op);
        }
      }
    }
  }

  assert.deepEqual([...ops].sort(), [
    'op_in',
    'target_glob',
    'target_host_in',
    'target_host_not_in',
    'target_outside_glob',
    'target_scheme_in',
    'url_query_key_in',
  ]);
});

for (const fixture of FIXTURES) {
  test(`${fixture.file}: ${fixture.name}`, () => {
    assert.deepEqual(
      evaluateWithMatches(fixture.action, fixture.table, Date.parse(fixture.now)),
      fixture.expect,
    );
  });
}
