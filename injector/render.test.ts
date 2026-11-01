import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAdvisoryBlock } from './render.ts';
import { selectAdvisoryRules } from './select.ts';
import { compileAdvisorySnapshot } from './snapshot.ts';
import { rule, snapshotInput } from './test-support.ts';

function fixture() {
  return compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({
          id: 'b-rule',
          narrative: 'Second narrative.',
          source: 'AGENTS.md',
          specificity: 1,
        }),
        rule({
          id: 'a-rule',
          narrative: 'First narrative.',
          source: 'docs/decisions.md',
          specificity: 2,
        }),
      ],
    }),
  );
}

test('renders one independent amos-guidance block with provenance attributes', () => {
  const snapshot = fixture();
  const rendered = renderAdvisoryBlock({
    snapshot,
    rules: snapshot.rules,
    maxCharacters: 2_000,
  });

  assert.ok(
    rendered.text.startsWith(
      `<amos-guidance policy="1.0.0" digest="${snapshot.advisoryDigest}" mode="advisory">`,
    ),
  );
  assert.ok(rendered.text.endsWith('</amos-guidance>'));
  assert.ok(rendered.text.includes('not permissions'));
  assert.ok(rendered.text.includes('gate decides every action'));
  assert.ok(rendered.text.includes('- [a-rule] First narrative. (docs/decisions.md)'));
  assert.ok(rendered.text.includes('- [b-rule] Second narrative. (AGENTS.md)'));
  // Caller order is preserved, not re-sorted by id.
  assert.deepEqual(rendered.ruleIds, ['b-rule', 'a-rule']);
  assert.deepEqual(rendered.droppedRuleIds, []);
});

test('renders in selection score order even when lexical id order differs', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({ id: 'a-low', narrative: 'Lower score.', specificity: 1, keywords: ['engine'] }),
        rule({ id: 'z-high', narrative: 'Higher score.', specificity: 10, keywords: ['engine'] }),
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, { prompt: 'engine' });
  assert.deepEqual(
    selection.selected.map((entry) => entry.id),
    ['z-high', 'a-low'],
  );

  const rendered = renderAdvisoryBlock({
    snapshot,
    rules: selection.selected,
    maxCharacters: 2_000,
  });
  assert.deepEqual(rendered.ruleIds, ['z-high', 'a-low']);
  assert.ok(rendered.text.indexOf('- [z-high]') < rendered.text.indexOf('- [a-low]'));
});

test('escapes dynamic text and attributes', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({
          id: 'id&<>',
          narrative: 'Use <tag> & "quotes" and \'apostrophes\'.',
          source: 'a&b<c>',
        }),
      ],
    }),
  );
  const rendered = renderAdvisoryBlock({
    snapshot,
    rules: snapshot.rules,
    maxCharacters: 2_000,
  });

  assert.ok(rendered.text.includes('id&amp;&lt;&gt;'));
  assert.ok(rendered.text.includes('&lt;tag&gt; &amp; &quot;quotes&quot;'));
  assert.ok(rendered.text.includes('&apos;apostrophes&apos;'));
  assert.ok(rendered.text.includes('a&amp;b&lt;c&gt;'));
  assert.ok(!rendered.text.includes('<tag>'));
});

test('drops whole rules that exceed the character budget and reports ids', () => {
  const snapshot = fixture();
  const first = renderAdvisoryBlock({
    snapshot,
    rules: snapshot.rules,
    maxCharacters: 300,
    maxRulesPerBlock: 6,
  });

  assert.deepEqual(first.ruleIds, ['b-rule']);
  assert.deepEqual(first.droppedRuleIds, ['a-rule']);
  assert.ok(first.text.includes('Second narrative.'));
  assert.ok(!first.text.includes('First narrative.'));
});

test('enforces maxRulesPerBlock and drops unknown or duplicate ids', () => {
  const snapshot = fixture();
  const rendered = renderAdvisoryBlock({
    snapshot,
    rules: [snapshot.rules[0]!, snapshot.rules[0]!, snapshot.rules[1]!],
    maxRulesPerBlock: 1,
    maxCharacters: 2_000,
  });

  assert.deepEqual(rendered.ruleIds, ['b-rule']);
  assert.deepEqual(rendered.droppedRuleIds, ['b-rule', 'a-rule']);

  const unknown = renderAdvisoryBlock({
    snapshot,
    rules: [{ id: 'missing' } as never],
    maxCharacters: 2_000,
  });
  assert.deepEqual(unknown.ruleIds, []);
  assert.deepEqual(unknown.droppedRuleIds, ['missing']);
});

test('a budget below the wrapper renders nothing and drops every rule', () => {
  const snapshot = fixture();
  const rendered = renderAdvisoryBlock({
    snapshot,
    rules: snapshot.rules,
    maxCharacters: 10,
  });

  assert.equal(rendered.text, '');
  assert.deepEqual(rendered.ruleIds, []);
  assert.deepEqual(rendered.droppedRuleIds, ['b-rule', 'a-rule']);
});
