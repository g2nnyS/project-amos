import { createHash } from 'node:crypto';
import { digest } from '../activation/json.ts';
import { MANAGED_ENVELOPE_DIGEST_DOMAIN, type ManagedEnvelope, type ManagedReviewRequest } from './contracts.ts';

export function managedEnvelopeDigest(envelope: ManagedEnvelope): string {
  return digest(MANAGED_ENVELOPE_DIGEST_DOMAIN, envelope);
}

export function managedContentDigest(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function managedReviewRequestDigest(request: ManagedReviewRequest): string {
  return digest('amos-managed-review-request-v1', request);
}
