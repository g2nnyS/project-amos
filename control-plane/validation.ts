import type { Actor } from './contracts.ts';
import { DomainError } from './errors.ts';
import { parseStoredJson, type ProposalRow } from './rows.ts';

export const MAX_ACTOR_ID_LENGTH = 200;

export function assertActor(actor: Actor): void {
  if (
    actor === null ||
    typeof actor !== 'object' ||
    !isNonBlankString(actor.id) ||
    actor.id.length > MAX_ACTOR_ID_LENGTH ||
    (actor.role !== 'human' && actor.role !== 'agent')
  ) {
    throw new DomainError('invalid_request');
  }
}

export function assertHuman(actor: Actor): void {
  assertActor(actor);
  if (actor.role !== 'human') {
    throw new DomainError('forbidden');
  }
}

export function assertCanWithdraw(proposal: ProposalRow, actor: Actor): void {
  if (actor.role === 'human') {
    return;
  }
  const author = parseStoredJson(proposal.author_json) as Actor;
  // A colliding ID must not let an agent withdraw a human-authored proposal.
  if (author.role !== 'agent' || author.id !== actor.id) {
    throw new DomainError('forbidden');
  }
}

export function assertVersionNumber(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError('invalid_request');
  }
}

export function requireText(
  value: unknown,
  field: string,
  maxLength: number,
  nonBlank: boolean,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (nonBlank && value.trim().length === 0)
  ) {
    throw new DomainError('invalid_request');
  }
  void field;
  return value;
}

export function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 64) {
    throw new DomainError('invalid_request');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DomainError('invalid_request');
  }
  return parsed;
}

export function invalidRequest(): never {
  throw new DomainError('invalid_request');
}

export function safeClockValue(clock: () => number): number {
  let value: number;
  try {
    value = clock();
  } catch {
    throw new DomainError('internal_error');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DomainError('internal_error');
  }
  return value;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
