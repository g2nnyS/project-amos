import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { boundedCopy, deepFreeze, digest, record } from '../activation/json.ts';
import { auditId, validateAuditEvidence } from '../autonomy/audit.ts';
import { ManagedError } from './contracts.ts';
import type { ManagedIdentity, ManagedState } from './contracts.ts';

const hex = /^[a-f0-9]{64}$/;
const sha = /^sha256:[a-f0-9]{64}$/;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const int = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const hashList = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 1024 && x.every(v => typeof v === 'string' && hex.test(v)) && new Set(x).size === x.length;

/** Hash IDs with the legacy v2 domains, allowing explicit historical import. */
export const managedJournalId = (domain: 'operation' | 'actor' | 'project' | 'session' | 'task' | 'capability' | 'rule' | 'model', id: string): string => auditId(domain, id);

export interface ManagedJournalEvidence {
  readonly operationHash: string;
  /** Redacted attribution only; never authority to execute an effect. */
  readonly parentOperationHash: string | null;
  readonly effectIndex: number | null;
  readonly actorHash: string;
  readonly projectHash: string;
  readonly sessionHash: string;
  readonly taskHash: string;
  readonly capabilityChainHashes: readonly string[];
  readonly ruleHashes: readonly string[];
  /** Digest of the entire closed envelope, including any before precondition. */
  readonly envelopeDigest: string;
  readonly capabilityChainDigest: string | null;
  readonly snapshotDigest: string;
  readonly requirementDigest: string;
  readonly policyDigest: string | null;
  readonly state: ManagedState;
  readonly reason: string;
  readonly notAfter: number | null;
}
export interface ManagedJournalReviewFacts {
  readonly requestDigest: string;
  readonly factsDigest: string;
  readonly modelHash: string;
  readonly requirementMatch: 'match' | 'mismatch' | 'unclear';
  readonly withinScope: boolean;
  readonly risk: number;
  readonly confidence: number;
}
export interface ManagedJournalOptions {
  readonly journalPath: string;
  readonly workspace: string;
  readonly snapshotDigest: string;
  readonly identity: ManagedIdentity;
  readonly legacyJournalPaths?: readonly string[];
}
export type ManagedJournalToken = Readonly<object>;
export type ManagedJournalLimits = Readonly<Record<string, number>>;

const reasons = new Set(['allowed','malformed_input','identity_mismatch','snapshot_mismatch','capability_missing','capability_invalid','capability_revoked','capability_expired','capability_not_yet_valid','scope_denied','budget_exceeded','unsupported_precondition','checkpoint_unavailable','policy_denied','policy_error','review_required','review_not_preauthorized','unsupported_action','stale_envelope','audit_unavailable','executor_unavailable','duplicate_operation','stopped','protected_path','unsupported_shell','review_stopped','review_unavailable','review_expired','precondition_failed']);
const evidenceKeys = ['operationHash','parentOperationHash','effectIndex','actorHash','projectHash','sessionHash','taskHash','capabilityChainHashes','ruleHashes','envelopeDigest','capabilityChainDigest','snapshotDigest','requirementDigest','policyDigest','state','reason','notAfter'];
function evidence(input: unknown): ManagedJournalEvidence {
  const e = record(boundedCopy(input), evidenceKeys);
  for (const k of ['operationHash','actorHash','projectHash','sessionHash','taskHash']) if (typeof e[k] !== 'string' || !hex.test(e[k] as string)) throw 0;
  if (e.parentOperationHash === null ? e.effectIndex !== null : (typeof e.parentOperationHash !== 'string' || !hex.test(e.parentOperationHash) || !int(e.effectIndex) || e.parentOperationHash === e.operationHash)) throw 0;
  if (!hashList(e.capabilityChainHashes) || !hashList(e.ruleHashes)) throw 0;
  for (const k of ['envelopeDigest','snapshotDigest','requirementDigest']) if (typeof e[k] !== 'string' || !sha.test(e[k] as string)) throw 0;
  if (e.capabilityChainDigest !== null && (typeof e.capabilityChainDigest !== 'string' || !sha.test(e.capabilityChainDigest))) throw 0;
  if (e.policyDigest !== null && (typeof e.policyDigest !== 'string' || !sha.test(e.policyDigest))) throw 0;
  if (!['ALLOW','DENY','AUTO_REVIEW','DEFER'].includes(e.state as string) || typeof e.reason !== 'string' || !reasons.has(e.reason)) throw 0;
  if (e.state === 'ALLOW' ? e.reason !== 'allowed' : e.state === 'AUTO_REVIEW' ? e.reason !== 'review_required' : ['allowed','review_required'].includes(e.reason)) throw 0;
  if (e.state === 'ALLOW' || e.state === 'AUTO_REVIEW') {
    if (!e.capabilityChainHashes.length || !e.capabilityChainDigest || !int(e.notAfter) || (e.state === 'AUTO_REVIEW' && !e.policyDigest)) throw 0;
  } else if (e.notAfter !== null || (e.capabilityChainHashes.length === 0) !== (e.capabilityChainDigest === null)) throw 0;
  return deepFreeze(e) as unknown as ManagedJournalEvidence;
}
function facts(input: unknown): ManagedJournalReviewFacts {
  const f = record(boundedCopy(input), ['requestDigest','factsDigest','modelHash','requirementMatch','withinScope','risk','confidence']);
  if (typeof f.requestDigest !== 'string' || !sha.test(f.requestDigest) || typeof f.factsDigest !== 'string' || !sha.test(f.factsDigest) || typeof f.modelHash !== 'string' || !hex.test(f.modelHash) || !['match','mismatch','unclear'].includes(f.requirementMatch as string) || typeof f.withinScope !== 'boolean' || typeof f.risk !== 'number' || f.risk < 0 || f.risk > 1 || typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) throw 0;
  if (f.factsDigest !== managedReviewFactsDigest(f as unknown as ManagedJournalReviewFacts)) throw 0;
  return deepFreeze(f) as unknown as ManagedJournalReviewFacts;
}
export function managedReviewFactsDigest(f: Omit<ManagedJournalReviewFacts, 'factsDigest'>): string {
  return digest('amos-managed-journal-review-facts-v3', { requestDigest: f.requestDigest, modelHash: f.modelHash, requirementMatch: f.requirementMatch, withinScope: f.withinScope, risk: f.risk, confidence: f.confidence });
}
type Kind = 'pin' | 'decision' | 'review_reserve' | 'review_result' | 'consume' | 'result' | 'revoke' | 'stop';
type Entry = { v: 3; seq: number; time: number; kind: Kind; id: string; data: unknown; receipt: string | null };
type Item = { evidence: ManagedJournalEvidence; phase: 'decision' | 'reserved' | 'approved' | 'stopped' | 'consumed' | 'result'; receipt: string; requestDigest: string | null; deadline: number | null };
type Legacy = { digest: string; ids: Set<string>; revoked: Set<string>; counts: Map<string, number>; stopped: boolean; lastTime: number };

function openParent(file: string): { dir: number; base: string } {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file === '/') throw 0;
  let dir = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const part of path.dirname(file).split('/').filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${dir}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(dir); dir = next;
    }
    return { dir, base: path.basename(file) };
  } catch (e) { fs.closeSync(dir); throw e; }
}
function safeFile(fd: number): void {
  const s = fs.fstatSync(fd);
  if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw 0;
}

/** Strict read-only import: never opens old journals for writing or clears stale locks. */
function readLegacy(file: string, workspace: string, policy: string): Legacy {
  const { dir, base } = openParent(file);
  let fd = -1;
  try {
    const root = `/proc/self/fd/${dir}/${base}`;
    try { fs.lstatSync(`${root}.lock`); throw new Error('locked'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); safeFile(fd);
    const bytes = fs.readFileSync(fd); const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || !text.endsWith('\n')) throw 0;
    const pin = hash(`${policy}\0${workspace}`);
    const ids = new Set<string>(), revoked = new Set<string>(), pending = new Map<string, string>(), counts = new Map<string, number>();
    let seq = 0, lastTime = 0, stopped = false;
    for (const line of text.slice(0, -1).split('\n')) {
      const e = record(JSON.parse(line), ['v','seq','time','kind','id','detail','evidence','receipt']);
      if (e.v !== 2 || !int(e.seq) || e.seq !== seq + 1 || !int(e.time) || e.time < lastTime || typeof e.id !== 'string' || typeof e.detail !== 'string') throw 0;
      if (e.seq === 1 && e.kind === 'pin' && e.id === pin && e.detail === '' && e.evidence === null && e.receipt === null) { /* pin */ }
      else if (e.seq === 1) throw 0;
      else if (e.kind === 'decision' || e.kind === 'consume') {
        const ev = validateAuditEvidence(e.evidence);
        if (ids.has(e.id) || ev.operationIdHash !== e.id || ev.snapshotDigest !== policy || e.receipt !== digest('amos-authorization-evidence-v1', ev)) throw 0;
        if (e.kind === 'decision' && (ev.state === 'ALLOW' || e.detail !== ev.state)) throw 0;
        if (e.kind === 'consume' && (ev.state !== 'ALLOW' || ev.envelopeDigest !== e.detail || ev.authorityExpiresAt === null || ev.authorityExpiresAt <= e.time)) throw 0;
        ids.add(e.id);
        if (e.kind === 'consume') {
          pending.set(e.id, e.receipt as string);
          for (const cap of ev.capabilityChainIdHashes) counts.set(cap, (counts.get(cap) ?? 0) + 1);
        }
      } else if (e.kind === 'result' && e.evidence === null && pending.has(e.id) && e.receipt === pending.get(e.id) && ['succeeded','failed','outcome_unknown','not_executed'].includes(e.detail)) pending.delete(e.id);
      else if (e.kind === 'revoke' && hex.test(e.id) && e.detail === '' && e.evidence === null && e.receipt === null && !revoked.has(e.id)) revoked.add(e.id);
      else if (e.kind === 'stop' && e.id === '' && e.detail === '' && e.evidence === null && e.receipt === null && !stopped) stopped = true;
      else throw 0;
      seq = e.seq; lastTime = e.time;
    }
    if (!seq) throw 0;
    // Check for a lock appearing while the source was read.
    try { fs.lstatSync(`${root}.lock`); throw new Error('locked'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, ids, revoked, counts, stopped, lastTime };
  } finally { if (fd !== -1) fs.closeSync(fd); fs.closeSync(dir); }
}

/** Serialized trusted-parent ledger; receipts and in-process tokens are not IPC grants. */
export class ManagedJournal {
  private readonly items = new Map<string, Item>();
  private readonly historical = new Set<string>();
  private readonly revokedIds = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly effects = new Set<string>();
  private readonly tokens = new WeakMap<object, { id: string; kind: 'review' | 'execution' }>();
  private readonly identityHashes: string[];
  private readonly snapshot: string;
  private readonly pin: string;
  private fd = -1;
  private dir = -1;
  private lock = -1;
  private lockPath = '';
  private seq = 0;
  private failed = false;
  private stoppedValue = false;
  private time = 0;

  constructor(options: ManagedJournalOptions) {
    try {
      const identity = record(boundedCopy(options.identity), ['actorId','projectId','sessionId','taskId','snapshotDigest']);
      for (const k of ['actorId','projectId','sessionId','taskId']) if (typeof identity[k] !== 'string' || !(identity[k] as string).length) throw 0;
      if (typeof options.snapshotDigest !== 'string' || !sha.test(options.snapshotDigest) || identity.snapshotDigest !== options.snapshotDigest || !path.isAbsolute(options.workspace) || path.resolve(options.workspace) !== options.workspace || fs.realpathSync(options.workspace) !== options.workspace) throw 0;
      this.snapshot = options.snapshotDigest;
      this.identityHashes = (['actor','project','session','task'] as const).map((d, i) => managedJournalId(d, identity[['actorId','projectId','sessionId','taskId'][i]] as string));
      const paths = options.legacyJournalPaths ?? [];
      if (!Array.isArray(paths) || new Set(paths).size !== paths.length || paths.includes(options.journalPath)) throw 0;
      const imports = paths.map(p => ({ pathHash: hash(p), ...readLegacy(p, options.workspace, this.snapshot) })).sort((a,b) => a.pathHash.localeCompare(b.pathHash));
      for (const old of imports) {
        for (const id of old.ids) { if (this.historical.has(id)) throw 0; this.historical.add(id); }
        for (const id of old.revoked) this.revokedIds.add(id);
        for (const [id, n] of old.counts) this.counts.set(id, (this.counts.get(id) ?? 0) + n);
        this.stoppedValue ||= old.stopped; this.time = Math.max(this.time, old.lastTime);
      }
      this.pin = digest('amos-managed-ledger-pin-v3', { workspaceHash: hash(options.workspace), snapshot: this.snapshot, identityHashes: this.identityHashes, sources: imports.map(x => ({ pathHash: x.pathHash, digest: x.digest })) });
      const opened = openParent(options.journalPath); this.dir = opened.dir;
      const parent = fs.realpathSync(`/proc/self/fd/${this.dir}`);
      if (parent === options.workspace || parent.startsWith(options.workspace === '/' ? '/' : `${options.workspace}/`)) throw 0;
      this.lockPath = `/proc/self/fd/${this.dir}/${opened.base}.lock`;
      this.lock = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      const journalFile = `/proc/self/fd/${this.dir}/${opened.base}`;
      let created = false;
      try { this.fd = fs.openSync(journalFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; this.fd = fs.openSync(journalFile, fs.constants.O_APPEND | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW); }
      safeFile(this.fd);
      const bytes = fs.readFileSync(this.fd); const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes) || (!text && !created) || (text && !text.endsWith('\n'))) throw 0;
      const initialTime = this.time; this.time = 0;
      for (const line of text ? text.slice(0, -1).split('\n') : []) this.accept(JSON.parse(line));
      if (!this.seq) this.append('pin', '', this.pin, null, initialTime);
      else if (this.time < initialTime) throw 0;
      try { fs.fsyncSync(this.dir); } catch { this.failed = true; throw 0; }
    } catch {
      this.cleanup(); throw new ManagedError();
    }
  }
  get stopped(): boolean { return this.stoppedValue; }
  get lastTime(): number { return this.time; }
  hasOperation(idHash: string): boolean { return this.historical.has(idHash) || this.items.has(idHash); }
  isRevoked(capabilityHash: string): boolean { return this.revokedIds.has(capabilityHash); }
  operationCount(capabilityHash: string): number { return this.counts.get(capabilityHash) ?? 0; }
  operationCountExcludingReview(token: ManagedJournalToken, capabilityHash: string): number {
    const { item } = this.lookup(token, 'review');
    if (item.phase !== 'reserved' && item.phase !== 'approved') throw new ManagedError();
    return this.operationCount(capabilityHash) - (item.evidence.capabilityChainHashes.includes(capabilityHash) ? 1 : 0);
  }
  private checkEvidence(raw: unknown): ManagedJournalEvidence {
    const e = evidence(raw);
    if (e.snapshotDigest !== this.snapshot || [e.actorHash,e.projectHash,e.sessionHash,e.taskHash].some((v,i) => v !== this.identityHashes[i])) throw 0;
    return e;
  }
  private checkLimits(e: ManagedJournalEvidence, input: ManagedJournalLimits): void {
    const limits = record(boundedCopy(input), e.capabilityChainHashes);
    for (const id of e.capabilityChainHashes) if (!int(limits[id]) || (limits[id] as number) < 1 || this.operationCount(id) >= (limits[id] as number) || this.revokedIds.has(id)) throw 0;
  }
  private accept(raw: unknown): void {
    const e = record(boundedCopy(raw), ['v','seq','time','kind','id','data','receipt']) as unknown as Entry;
    if (e.v !== 3 || !int(e.seq) || e.seq !== this.seq + 1 || !int(e.time) || e.time < this.time || typeof e.id !== 'string' || (e.receipt !== null && (typeof e.receipt !== 'string' || !sha.test(e.receipt)))) throw 0;
    if (e.kind === 'pin' && e.seq === 1 && e.id === '' && e.data === this.pin && e.receipt === null) { /* pin */ }
    else if (e.seq === 1) throw 0;
    else if (e.kind === 'decision' || e.kind === 'review_reserve' || e.kind === 'consume') {
      const data = record(e.data, ['evidence','requestDigest','deadline']);
      const ev = this.checkEvidence(data.evidence);
      const existing = this.items.get(e.id);
      if (e.id !== ev.operationHash || this.historical.has(e.id) || e.receipt !== digest('amos-managed-journal-evidence-v3', ev)) throw 0;
      let effectKey: string | null = null;
      if (ev.parentOperationHash !== null) {
        const parent = this.items.get(ev.parentOperationHash);
        if (!parent || (parent.phase !== 'consumed' && parent.phase !== 'result')) throw 0;
        effectKey = `${ev.parentOperationHash}:${ev.effectIndex}`;
        if (!existing && this.effects.has(effectKey)) throw 0;
      }
      if (e.kind === 'decision') {
        if (existing || (ev.state !== 'DENY' && ev.state !== 'DEFER') || data.requestDigest !== null || data.deadline !== null) throw 0;
        this.items.set(e.id, { evidence: ev, phase: 'decision', receipt: e.receipt, requestDigest: null, deadline: null });
      } else if (e.kind === 'review_reserve') {
        if (existing || this.stoppedValue || ev.state !== 'AUTO_REVIEW' || ev.notAfter === null || ev.notAfter <= e.time || typeof data.requestDigest !== 'string' || !sha.test(data.requestDigest) || !int(data.deadline) || data.deadline <= e.time || data.deadline > ev.notAfter || ev.capabilityChainHashes.some(id => this.revokedIds.has(id))) throw 0;
        this.items.set(e.id, { evidence: ev, phase: 'reserved', receipt: e.receipt, requestDigest: data.requestDigest, deadline: data.deadline });
        for (const id of ev.capabilityChainHashes) this.counts.set(id, this.operationCount(id) + 1);
      } else {
        if (this.stoppedValue || ev.notAfter === null || ev.notAfter <= e.time || ev.capabilityChainHashes.some(id => this.revokedIds.has(id))) throw 0;
        if (existing) {
          if (existing.phase !== 'approved' || ev.state !== 'AUTO_REVIEW' || existing.receipt !== e.receipt || data.requestDigest !== existing.requestDigest || data.deadline !== existing.deadline || existing.deadline === null || e.time >= existing.deadline) throw 0;
          existing.phase = 'consumed';
        } else {
          if (ev.state !== 'ALLOW' || data.requestDigest !== null || data.deadline !== null) throw 0;
          this.items.set(e.id, { evidence: ev, phase: 'consumed', receipt: e.receipt, requestDigest: null, deadline: null });
          for (const id of ev.capabilityChainHashes) this.counts.set(id, this.operationCount(id) + 1);
        }
      }
      if (!existing && effectKey !== null) this.effects.add(effectKey);
    } else if (e.kind === 'review_result') {
      const item = this.items.get(e.id), data = record(e.data, ['outcome','facts']);
      if (!item || item.phase !== 'reserved' || e.receipt !== item.receipt || (data.outcome !== 'approved' && data.outcome !== 'stopped')) throw 0;
      const f = data.facts === null ? null : facts(data.facts);
      if ((f && f.requestDigest !== item.requestDigest) || (data.outcome === 'approved' && (!f || f.requirementMatch !== 'match' || !f.withinScope || this.stoppedValue || item.evidence.capabilityChainHashes.some(id => this.revokedIds.has(id)) || item.evidence.notAfter === null || e.time >= item.evidence.notAfter || item.deadline === null || e.time >= item.deadline))) throw 0;
      item.phase = data.outcome;
    } else if (e.kind === 'result') {
      const item = this.items.get(e.id);
      if (!item || item.phase !== 'consumed' || e.receipt !== item.receipt || !['succeeded','failed','outcome_unknown','not_executed'].includes(e.data as string)) throw 0;
      item.phase = 'result';
    } else if (e.kind === 'revoke') {
      if (!hex.test(e.id) || e.data !== null || e.receipt !== null || this.revokedIds.has(e.id)) throw 0;
      this.revokedIds.add(e.id);
    } else if (e.kind === 'stop') {
      if (e.id !== '' || e.data !== null || e.receipt !== null || this.stoppedValue) throw 0;
      this.stoppedValue = true;
    } else throw 0;
    this.seq = e.seq; this.time = e.time;
  }
  private append(kind: Kind, id: string, data: unknown, receipt: string | null, time: number): void {
    if (this.fd < 0 || this.failed) throw new ManagedError();
    if (!int(time) || time < this.time) { this.failed = true; throw new ManagedError(); }
    try {
      const entry: Entry = { v: 3, seq: this.seq + 1, time, kind, id, data, receipt };
      this.accept(entry);
      try { fs.writeFileSync(this.fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(this.fd); }
      catch { this.failed = true; throw 0; }
    } catch { throw new ManagedError(); }
  }
  private token(id: string, kind: 'review' | 'execution'): ManagedJournalToken {
    const t = Object.freeze({}); this.tokens.set(t, { id, kind }); return t;
  }
  private lookup(token: ManagedJournalToken, kind: 'review' | 'execution'): { id: string; item: Item } {
    const value = token && typeof token === 'object' ? this.tokens.get(token) : undefined;
    const item = value && this.items.get(value.id);
    if (!value || value.kind !== kind || !item) throw new ManagedError();
    return { id: value.id, item };
  }
  recordDecision(input: ManagedJournalEvidence, time: number): void {
    try { const e = this.checkEvidence(input); this.append('decision', e.operationHash, { evidence: e, requestDigest: null, deadline: null }, digest('amos-managed-journal-evidence-v3', e), time); } catch { throw new ManagedError(); }
  }
  reserveReview(input: ManagedJournalEvidence, requestDigest: string, deadline: number, limits: ManagedJournalLimits, time: number): ManagedJournalToken {
    try { const e = this.checkEvidence(input); this.checkLimits(e, limits); this.append('review_reserve', e.operationHash, { evidence: e, requestDigest, deadline }, digest('amos-managed-journal-evidence-v3', e), time); return this.token(e.operationHash, 'review'); } catch { throw new ManagedError(); }
  }
  recordReview(token: ManagedJournalToken, outcome: 'approved' | 'stopped', reviewFacts: ManagedJournalReviewFacts | null, time: number): void {
    try { const { id, item } = this.lookup(token, 'review'); this.append('review_result', id, { outcome, facts: reviewFacts === null ? null : facts(reviewFacts) }, item.receipt, time); } catch { throw new ManagedError(); }
  }
  consumeReviewed(token: ManagedJournalToken, time: number): ManagedJournalToken {
    try { const { id, item } = this.lookup(token, 'review'); this.append('consume', id, { evidence: item.evidence, requestDigest: item.requestDigest, deadline: item.deadline }, item.receipt, time); return this.token(id, 'execution'); } catch { throw new ManagedError(); }
  }
  consume(input: ManagedJournalEvidence, limits: ManagedJournalLimits, time: number): ManagedJournalToken {
    try { const e = this.checkEvidence(input); this.checkLimits(e, limits); this.append('consume', e.operationHash, { evidence: e, requestDigest: null, deadline: null }, digest('amos-managed-journal-evidence-v3', e), time); return this.token(e.operationHash, 'execution'); } catch { throw new ManagedError(); }
  }
  recordResult(token: ManagedJournalToken, status: 'succeeded' | 'failed' | 'outcome_unknown' | 'not_executed', time: number): void {
    try { const { id, item } = this.lookup(token, 'execution'); this.append('result', id, status, item.receipt, time); } catch { throw new ManagedError(); }
  }
  revoke(capabilityHash: string, time: number): void { this.append('revoke', capabilityHash, null, null, time); }
  stop(time: number): void { this.append('stop', '', null, null, time); }
  private cleanup(): void {
    if (this.fd !== -1) { fs.closeSync(this.fd); this.fd = -1; }
    if (this.lock !== -1) {
      try { const a = fs.fstatSync(this.lock), b = fs.lstatSync(this.lockPath); if (!this.failed && a.dev === b.dev && a.ino === b.ino) fs.unlinkSync(this.lockPath); } catch { /* never remove another lock */ }
      fs.closeSync(this.lock); this.lock = -1;
    }
    if (this.dir !== -1) { fs.closeSync(this.dir); this.dir = -1; }
  }
  close(): void { this.cleanup(); }
}
