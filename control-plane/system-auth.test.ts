import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifySystemProof } from './system-auth.ts';

const SECRET = 'ab'.repeat(32);
const CHALLENGE = Buffer.alloc(32, 0xcd).toString('base64url');
const NOW = Date.UTC(2026, 0, 1);

function sign(timestamp: number | string, challenge = CHALLENGE, secret = SECRET): string {
  return `${timestamp}.${createHmac('sha256', secret).update(`${timestamp}:${challenge}`).digest('hex')}`;
}

test('native proof binds the service secret, challenge and timestamp', () => {
  const proof = sign(NOW);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, proof, NOW), true);
  assert.equal(verifySystemProof('ef'.repeat(32), CHALLENGE, proof, NOW), false);
  assert.equal(verifySystemProof(SECRET, Buffer.alloc(32, 0xef).toString('base64url'), proof, NOW), false);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, proof.replace(String(NOW), String(NOW - 1)), NOW), false);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, `${NOW}.${'00'.repeat(32)}`, NOW), false);
});

test('proof expires after sixty seconds and future timestamps are rejected', () => {
  assert.equal(verifySystemProof(SECRET, CHALLENGE, sign(NOW - 60_000), NOW), true);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, sign(NOW - 60_001), NOW), false);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, sign(NOW + 1), NOW), false);
  assert.equal(verifySystemProof(SECRET, CHALLENGE, sign(0), 0), true);
});

test('proof parser rejects noncanonical timestamps, malformed MACs and non-string input', () => {
  const valid = sign(NOW);
  const malformed: unknown[] = [
    undefined, null, 1, {}, [], Buffer.from(valid),
    '', `${valid}\n`, ` ${valid}`, `${valid} `, `${valid}.extra`,
    sign(`0${NOW}`), sign(`+${NOW}`), sign('-1'), sign('1.5'),
    sign('1e12'), sign('NaN'), sign('Infinity'), sign('9007199254740992'),
    `${NOW}.${'ab'.repeat(31)}`, `${NOW}.${'ab'.repeat(33)}`,
    `${NOW}.${'AB'.repeat(32)}`, `${NOW}.${'gg'.repeat(32)}`,
  ];
  for (const proof of malformed) {
    assert.equal(verifySystemProof(SECRET, CHALLENGE, proof, NOW), false);
  }
});

test('secret, challenge and injected clock must have the configured format', () => {
  const proof = sign(NOW);
  for (const value of ['', 'ab', 'a'.repeat(42), 'a'.repeat(44), '+'.repeat(43), '/'.repeat(43), `${CHALLENGE}\n`]) {
    assert.equal(verifySystemProof(SECRET, value, proof, NOW), false);
  }
  for (const value of ['', 'ab', 'AB'.repeat(32), 'gg'.repeat(32), `${SECRET}\n`]) {
    assert.equal(verifySystemProof(value, CHALLENGE, proof, NOW), false);
  }
  for (const now of [NaN, Infinity, -1, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(verifySystemProof(SECRET, CHALLENGE, proof, now), false);
  }
});
