/**
 * Read-only observation log review for the local governance console.
 *
 * Paths are fixed at server startup and are never supplied by a request. Raw
 * JSONL lines are parsed by storage/audit-review.ts, which drops malformed
 * lines instead of echoing them. Actions are re-sanitized before leaving this
 * module so a hostile log line cannot leak command text or URL secrets.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { sanitizeAuditAction } from '../storage/audit.ts';
import {
  buildReviewQueue,
  type ReviewQueue,
  type ReviewRecord,
  type ReviewSource,
} from '../storage/audit-review.ts';

const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES_PER_FILE = 5000;

export interface ObservationRule {
  readonly id: string;
  readonly level: number;
  readonly on_hit?: string;
}

export interface ObservationOptions {
  /** Absolute, startup-configured log paths. Request data is never used. */
  readonly paths: readonly string[];
  readonly rules?: readonly ObservationRule[];
  readonly maxBytesPerFile?: number;
  readonly maxLinesPerFile?: number;
}

export interface ObservationSourceReport {
  readonly name: string;
  readonly lines: number;
  readonly truncated: boolean;
  /** Stable code, never a raw filesystem error message. */
  readonly error: 'unreadable' | 'not_regular_file' | null;
}

export interface ObservationReport {
  readonly available: boolean;
  readonly sources: readonly ObservationSourceReport[];
  readonly queue: ReviewQueue | null;
}

interface LoadedSource extends ReviewSource {
  readonly report: ObservationSourceReport;
}

function sanitizeRecord(record: ReviewRecord): ReviewRecord {
  if (record.action === null) {
    return record;
  }
  const { tool, operation, target } = record.action;
  // Partial actions are hostile too. Substitute inert placeholders for missing
  // fields instead of returning the original operation/target, so a missing
  // tool can never smuggle shell command text or URL secrets through the
  // review projection. The shared storage sanitizer is intentionally unchanged.
  const safe = sanitizeAuditAction({
    tool: tool ?? 'unknown',
    operation: operation ?? 'unknown',
    target: target ?? 'unknown',
  });
  return { ...record, action: safe };
}

/**
 * Rebuild every queue projection so the sanitized records are the ones the
 * endpoint serializes. Queue projection arrays share record identity, so a
 * single map keeps them consistent.
 */
function sanitizeQueue(queue: ReviewQueue): ReviewQueue {
  const byRecord = new Map<ReviewRecord, ReviewRecord>();
  const mapRecord = (record: ReviewRecord): ReviewRecord => {
    const cached = byRecord.get(record);
    if (cached !== undefined) {
      return cached;
    }
    const safe = sanitizeRecord(record);
    byRecord.set(record, safe);
    return safe;
  };
  const mapAll = (records: readonly ReviewRecord[]): ReviewRecord[] =>
    records.map(mapRecord);

  return {
    records: mapAll(queue.records),
    zeroLevel: mapAll(queue.zeroLevel),
    nonZeroDeny: mapAll(queue.nonZeroDeny),
    confirm: {
      total: queue.confirm.total,
      selected: mapAll(queue.confirm.selected),
    },
    gaps: mapAll(queue.gaps),
    gapReasonCounts: { ...queue.gapReasonCounts },
  };
}

async function readBoundedLines(
  path: string,
  maxBytes: number,
  maxLines: number,
): Promise<{ lines: string[]; truncated: boolean; error: ObservationSourceReport['error'] }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { lines: [], truncated: false, error: 'unreadable' };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { lines: [], truncated: false, error: 'not_regular_file' };
    }

    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    let offset = 0;
    while (offset < bytesToRead) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        bytesToRead - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    let text = buffer.subarray(0, offset).toString('utf8');
    let truncated = stat.size > bytesToRead;

    if (truncated) {
      // Drop a partial final line rather than manufacturing a malformed record.
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline >= 0 ? text.slice(0, lastNewline) : '';
    }

    const lines = text.split('\n');
    if (lines.length > maxLines) {
      truncated = true;
      lines.length = maxLines;
    }
    return { lines, truncated, error: null };
  } catch {
    return { lines: [], truncated: false, error: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class ObservationLogs {
  private readonly paths: readonly string[];
  private readonly rules: readonly ObservationRule[];
  private readonly maxBytesPerFile: number;
  private readonly maxLinesPerFile: number;
  private readonly names: readonly string[];

  constructor(options: ObservationOptions) {
    for (const path of options.paths) {
      if (typeof path !== 'string' || !isAbsolute(path)) {
        throw new Error('observation log paths must be absolute startup paths');
      }
    }
    this.paths = [...options.paths];
    this.rules = [...(options.rules ?? [])];
    this.maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    this.maxLinesPerFile = options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
    this.names = this.paths.map((path, index) => {
      const base = basename(path).replace(/[^A-Za-z0-9._-]/g, '_');
      return base.length > 0 ? base : `log-${index + 1}`;
    });
  }

  get configured(): boolean {
    return this.paths.length > 0;
  }

  async read(): Promise<ObservationReport> {
    if (this.paths.length === 0) {
      return { available: false, sources: [], queue: null };
    }

    const loaded: LoadedSource[] = [];
    for (let index = 0; index < this.paths.length; index += 1) {
      const path = this.paths[index]!;
      const name = this.names[index]!;
      const result = await readBoundedLines(
        path,
        this.maxBytesPerFile,
        this.maxLinesPerFile,
      );
      loaded.push({
        name,
        lines: result.lines,
        report: {
          name,
          lines: result.lines.length,
          truncated: result.truncated,
          error: result.error,
        },
      });
    }

    return {
      available: true,
      sources: loaded.map((source) => source.report),
      queue: sanitizeQueue(buildReviewQueue(loaded, this.rules)),
    };
  }
}
