import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AutonomyError } from './contracts.ts';
import type { AuthorizationAuditEvidence } from './contracts.ts';
import { digest as digestJson } from '../activation/json.ts';
import { auditId, validateAuditEvidence } from './audit.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
type Kind = 'pin' | 'decision' | 'consume' | 'result' | 'revoke' | 'stop';
type Entry = { v: 2; seq: number; time: number; kind: Kind; id: string; detail: string; evidence: AuthorizationAuditEvidence | null; receipt: string | null };

/** Lock and journal are opened relative to the same no-follow parent directory. */
export class Journal {
  readonly consumed = new Set<string>();
  readonly revoked = new Set<string>();
  private readonly pending = new Map<string, string>();
  stopped = false;
  lastTime = 0;
  private seq = 0;
  private fd = -1;
  private lock = -1;
  private dir = -1;
  private lockPath = '';
  private failed = false;
  private readonly pin: string;
  private readonly policy: string;

  constructor(file: string, workspace: string, policy: string) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace || path.basename(file) === '.') throw new AutonomyError();
    this.pin = hash(`${policy}\0${workspace}`);
    this.policy = policy;
    try {
      // /proc/self/fd anchors every component and prevents following directory symlinks.
      this.dir = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      for (const component of path.dirname(file).split('/').filter(Boolean)) {
        const next = fs.openSync(`/proc/self/fd/${this.dir}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        fs.closeSync(this.dir); this.dir = next;
      }
      const parent = fs.realpathSync(`/proc/self/fd/${this.dir}`);
      const root = fs.realpathSync(workspace);
      if (parent === root || parent.startsWith(root === '/' ? '/' : `${root}/`)) throw new AutonomyError();
      const base = path.basename(file);
      this.lockPath = `/proc/self/fd/${this.dir}/${base}.lock`;
      this.lock = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      this.fd = fs.openSync(`/proc/self/fd/${this.dir}/${base}`, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      const st = fs.fstatSync(this.fd);
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new AutonomyError();
      const text = fs.readFileSync(this.fd, 'utf8');
      if (text && !text.endsWith('\n')) throw new AutonomyError();
      for (const line of text ? text.slice(0, -1).split('\n') : []) this.accept(JSON.parse(line));
      if (!this.seq) this.append('pin', this.pin, '', 0);
      fs.fsyncSync(this.dir);
    } catch {
      if (this.fd !== -1) fs.closeSync(this.fd);
      this.releaseLock();
      if (this.dir !== -1) fs.closeSync(this.dir);
      throw new AutonomyError();
    }
  }
  static id(id: string): string { return auditId('operation', id); }
  static capabilityId(id: string): string { return auditId('capability', id); }
  poison(): void { this.failed = true; }

  private accept(e: Entry): void {
    if (!e || typeof e !== 'object' || Object.keys(e).sort().join(',') !== 'detail,evidence,id,kind,receipt,seq,time,v' || e.v !== 2 || !Number.isSafeInteger(e.seq) || e.seq !== this.seq + 1 || !Number.isSafeInteger(e.time) || e.time < 0 || e.time < this.lastTime || typeof e.id !== 'string' || typeof e.detail !== 'string') throw new AutonomyError();
    if (e.seq === 1 && e.kind === 'pin' && e.id === this.pin && e.detail === '' && e.evidence === null && e.receipt === null) { /* pin */ }
    else if (e.seq > 1 && (e.kind === 'decision' || e.kind === 'consume') && hex.test(e.id) && !this.consumed.has(e.id)) {
      const evidence = validateAuditEvidence(e.evidence);
      if (evidence.operationIdHash !== e.id || evidence.snapshotDigest !== this.policy || e.receipt !== digestJson('amos-authorization-evidence-v1', evidence)) throw new AutonomyError();
      if (e.kind === 'decision' && (e.detail !== evidence.state || evidence.state === 'ALLOW')) throw new AutonomyError();
      if (e.kind === 'consume' && (evidence.state !== 'ALLOW' || e.detail !== evidence.envelopeDigest || !digest.test(e.detail) || evidence.authorityExpiresAt === null || evidence.authorityExpiresAt <= e.time)) throw new AutonomyError();
      this.consumed.add(e.id);
      if (e.kind === 'consume') this.pending.set(e.id, e.receipt);
    }
    else if (e.kind === 'result' && e.evidence === null && this.pending.get(e.id) === e.receipt && this.pending.has(e.id) && ['succeeded', 'failed', 'outcome_unknown', 'not_executed'].includes(e.detail)) this.pending.delete(e.id);
    else if (e.seq > 1 && e.kind === 'revoke' && hex.test(e.id) && e.detail === '' && e.evidence === null && e.receipt === null && !this.revoked.has(e.id)) this.revoked.add(e.id);
    else if (e.seq > 1 && e.kind === 'stop' && e.id === '' && e.detail === '' && e.evidence === null && e.receipt === null && !this.stopped) this.stopped = true;
    else throw new AutonomyError();
    this.seq = e.seq; this.lastTime = e.time;
  }
  append(kind: Kind, id: string, detail: string, time: number, evidence: AuthorizationAuditEvidence | null = null): void {
    if (this.failed) throw new AutonomyError();
    const safeEvidence = evidence === null ? null : validateAuditEvidence(evidence);
    const receipt = safeEvidence ? digestJson('amos-authorization-evidence-v1', safeEvidence) : kind === 'result' ? this.pending.get(id) ?? null : null;
    const record: Entry = { v: 2, seq: this.seq + 1, time, kind, id, detail, evidence: safeEvidence, receipt };
    // Validate before writing; failures after this point permanently poison the journal.
    this.accept(record);
    try { fs.writeFileSync(this.fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(this.fd); }
    catch { this.failed = true; throw new AutonomyError(); }
  }
  private releaseLock(): void {
    if (this.lock === -1) return;
    try {
      const own = fs.fstatSync(this.lock);
      const current = fs.lstatSync(this.lockPath);
      if (!this.failed && own.dev === current.dev && own.ino === current.ino) fs.unlinkSync(this.lockPath);
    } catch { /* Never unlink an unverified lock. */ }
    fs.closeSync(this.lock); this.lock = -1;
  }
  close(): void {
    if (this.fd !== -1) { fs.closeSync(this.fd); this.fd = -1; }
    this.releaseLock();
    if (this.dir !== -1) { fs.closeSync(this.dir); this.dir = -1; }
  }
}
