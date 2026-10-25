import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parse as parseYaml } from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const root = process.cwd();
const schema = JSON.parse(
  readFileSync(join(root, 'constraints', 'schema.json'), 'utf8'),
) as Record<string, unknown>;
const rules = parseYaml(
  readFileSync(join(root, 'constraints', 'rules.yaml'), 'utf8'),
) as unknown;

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

function firstRule(): Record<string, unknown> {
  assert.ok(Array.isArray(rules));
  const rule = rules[0];
  assert.ok(isRecord(rule));
  return rule;
}

test('constraints/schema.json is a draft-07 top-level rule array', () => {
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.type, 'array');
  assert.ok(isRecord(schema.definitions));
  assert.ok(isRecord(schema.definitions.rule));
  assert.equal(schema.definitions.rule.type, 'object');
});

test('constraints/schema.json has no regex pattern keyword or remote $ref', () => {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(key, 'pattern', 'regex pattern keyword is forbidden');
      if (key === '$ref') {
        assert.equal(typeof child, 'string');
        if (typeof child !== 'string') {
          throw new Error('$ref must be a string');
        }
        assert.ok(child.startsWith('#/'), `remote $ref is forbidden: ${child}`);
      }
      visit(child);
    }
  };
  visit(schema);
});

test('the current constraints/rules.yaml passes the schema', () => {
  if (!validate(rules)) {
    assert.fail(ajv.errorsText(validate.errors, { separator: '\n' }));
  }
});

test('the schema accepts an empty rule table and unknown rule fields', () => {
  assert.equal(validate([]), true, ajv.errorsText(validate.errors));

  const extended = { ...firstRule(), unexpected_rule_field: { anything: true } };
  assert.equal(validate([extended]), true, ajv.errorsText(validate.errors));
});

test('the schema rejects unknown ops, missing args, bad ttl types and expressivity mismatches', () => {
  const base = firstRule();
  const withPredicate = (predicate: unknown) => ({ ...base, predicate });

  assert.equal(
    validate([
      withPredicate([{ op: 'rate_exceeds', args: { limit: ['1'] } }]),
    ]),
    false,
  );
  assert.equal(validate([withPredicate([{ op: 'op_in', args: {} }])]), false);
  assert.equal(
    validate([withPredicate([{ op: 'op_in', args: { operations: [] } }])]),
    false,
  );
  assert.equal(validate([{ ...base, ttl: 123 }]), false);
  assert.equal(validate([{ ...base, ttl: '' }]), false);
  assert.equal(validate([{ ...base, predicate: null }]), false);
  assert.equal(
    validate([{ ...base, expressivity: 'advisory_only' }]),
    false,
  );
});
