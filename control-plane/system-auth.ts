import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_256 = /^[0-9a-f]{64}$/;
const MAX_PROOF_AGE_MS = 60_000;

/** Verify a native prompt proof; the HTTP caller must consume/rotate its CSRF session. */
export function verifySystemProof(
  secret: string,
  challenge: string,
  proof: unknown,
  now = Date.now(),
): boolean {
  if (
    typeof secret !== 'string' || secret.length !== 64 || !HEX_256.test(secret) ||
    typeof challenge !== 'string' || challenge.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    typeof proof !== 'string' || proof.length > 81 ||
    !Number.isSafeInteger(now) || now < 0
  ) {
    return false;
  }

  const match = /^(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})$/.exec(proof);
  if (!match || match[0] !== proof) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) || timestamp > now ||
    now - timestamp > MAX_PROOF_AGE_MS
  ) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${match[1]}:${challenge}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'));
}
