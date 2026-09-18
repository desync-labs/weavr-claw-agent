/**
 * The journal: an append-only JSONL file on the PVC. It is the forensic
 * record (who asked for what, what was refused, what was signed) and the
 * source the ledger is rebuilt from at boot, so a restart cannot reset a
 * daily cap or the proposal quota. Never a secret, an RPC URL or a
 * transaction body — the file is expected to be read by people.
 *
 * Why every record is scrubbed here rather than trusted from the caller:
 * the verbs strip `tx` before journaling, but the journal is the last line
 * of defence and the one place a leak would be durable (the PVC outlives
 * the pod, Loki keeps stdout for weeks). A planted `tx`, `walletPayload`,
 * 64-byte array or RPC URL is replaced by a marker and the record says
 * which paths were redacted, so a forensic reader sees that something was
 * dropped instead of a silently incomplete line.
 *
 * Why the same line goes to stdout: Loki scrapes the pod; the PVC is only
 * reachable with kubectl. A `curator: 'journal'` field marks the line so a
 * LogQL filter finds them among the loop's other output.
 *
 * Why rotation is a rename at 50 MB and the reader spans both files: the
 * ledger window is 30 days of proposals plus today's totals; a rotation
 * must not make the quota forget last week. `<file>.1` is read first, so
 * `tail` and `rebuildLedger` see one continuous stream.
 */
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** README §1: the 1Gi PVC is mounted at /app/.cache. */
export const DEFAULT_JOURNAL_FILE = '/app/.cache/curator/journal.jsonl';

/** Rename to `<file>.1` once the current file reaches this many bytes. */
export const ROTATE_BYTES = 50 * 1024 * 1024;

/** Verbs whose attempts (ok or refused) count against the hourly write rate. */
export const LEDGER_WRITE_VERBS = Object.freeze([
  'propose', 'apply', 'cancel', 'deposit', 'withdraw', 'refreshNav',
  'rotateCurator', 'setDelay', 'setMetadata',
]);

const DAY_SECS = 86400;
const HOUR_SECS = 3600;
const THIRTY_DAYS_SECS = 30 * DAY_SECS;
const TAIL_CHUNK = 64 * 1024;
const MAX_DEPTH = 8;

/** Keys whose value is never written, whatever it holds. Exact, case-sensitive matches. */
const FORBIDDEN_KEYS = new Set([
  'tx', 'signed', 'walletPayload', 'secretKey', 'privateKey', 'mnemonic',
  'keypair', 'seed', 'rpcUrl', 'authorization', 'token',
]);

const BLOB = /^[A-Za-z0-9+/=_-]{200,}$/; // a serialised transaction, base64 or base58
const EVM_KEY = /^0x[0-9a-fA-F]{64}$/; // a 32-byte hex secret
const URL_WITH_SECRET = /:\/\/[^/\s]*(?:@|\?)|:\/\/[^/\s]+\/(?:[^/\s]+\/)*[A-Za-z0-9_-]{20,}(?:\/|$)/; // credentials, a query string or a key-shaped path segment

const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

/**
 * Replace anything that must not reach the file. Returns the copy and the
 * paths that were touched; the caller records the paths on the line.
 * @param {unknown} value
 * @returns {{ value: unknown, redacted: string[] }}
 */
export function scrub(value) {
  const redacted = [];
  const walk = (node, path, depth) => {
    if (depth > MAX_DEPTH) { redacted.push(path); return '[redacted:depth]'; }
    if (typeof node === 'string') {
      if (BLOB.test(node)) { redacted.push(path); return '[redacted:blob]'; }
      if (EVM_KEY.test(node)) { redacted.push(path); return '[redacted:hex-secret]'; }
      if (URL_WITH_SECRET.test(node)) { redacted.push(path); return '[redacted:url]'; }
      return node;
    }
    if (typeof node === 'bigint') return node.toString();
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      if ((node.length === 32 || node.length === 64) && node.every(isByte)) { redacted.push(path); return '[redacted:key-bytes]'; }
      return node.map((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    }
    if (node instanceof Uint8Array) {
      if (node.length === 32 || node.length === 64) { redacted.push(path); return '[redacted:key-bytes]'; }
      return `[bytes:${node.length}]`;
    }
    if (typeof node.toBase58 === 'function') return node.toBase58(); // PublicKey
    if (typeof node.toJSON === 'function' && !(node instanceof Date)) return walk(node.toJSON(), path, depth + 1);
    const out = {};
    for (const [key, entry] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) { redacted.push(here); out[key] = '[redacted]'; continue; }
      if (entry === undefined) continue;
      out[key] = walk(entry, here, depth + 1);
    }
    return out;
  };
  return { value: walk(value, '', 0), redacted };
}

/** JSON with keys sorted at every level, so the same args hash the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * sha256 hex of the canonical JSON of any value: keys sorted at every level,
 * so two documents that differ only in key order digest the same. The policy
 * digest (`verbs.policyDigestOf`, GET /policy, status.policy.sha256) and the
 * per-record `argsSha256` are both this function, so they cannot disagree on
 * what canonical means.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSha256(value) {
  return createHash('sha256').update(canonical(value ?? null), 'utf8').digest('hex');
}

/** sha256 hex of the canonical JSON of `args`; what the Hermes approval rule_key is derived from too. */
export function argsSha256(args) {
  return canonicalSha256(args);
}

/** A plain object out of a journaled field, or `{}`: an array, a string or a null is not a map of poolId → value. */
const plainMap = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function parseLines(lines) {
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // A torn last line after a crash mid-write; the fsync'd lines before it are intact.
    }
  }
  return records;
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** The last `n` lines of a file, read backwards in chunks so a 50 MB file is not loaded for `tail(20)`. */
function lastLines(path, n) {
  if (n <= 0) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return [];
    let pos = size;
    let newlines = 0;
    const parts = [];
    while (pos > 0 && newlines <= n) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const part = Buffer.alloc(len);
      readSync(fd, part, 0, len, pos);
      for (const byte of part) if (byte === 0x0a) newlines += 1;
      parts.unshift(part);
    }
    const lines = Buffer.concat(parts).toString('utf8').split('\n');
    if (pos > 0) lines.shift(); // the first line is a fragment of an earlier record
    return lines.filter((line) => line.trim() !== '').slice(-n);
  } finally {
    closeSync(fd);
  }
}

const sameUtcDay = (a, b) => Math.floor(a / DAY_SECS) === Math.floor(b / DAY_SECS);
const isOk = (record) => record.ok !== false && record.kind !== 'refusal';
const usd = (record) => {
  const value = Number(record.args?.amountUsd ?? record.amountUsd ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export class Journal {
  /**
   * @param {{ file?: string, now?: () => number, stdout?: { write: (line: string) => unknown } | null, rotateBytes?: number }} opts
   *   `now` in ms, injectable for tests; `stdout` null silences the mirror line; `rotateBytes` default 50 MB
   */
  constructor(opts = {}) {
    const { file = DEFAULT_JOURNAL_FILE, now = Date.now, stdout = process.stdout, rotateBytes = ROTATE_BYTES } = opts;
    if (typeof file !== 'string' || file.trim() === '') throw new Error('Journal: file is required');
    this.file = file;
    this.rotatedFile = `${file}.1`;
    this.now = now;
    this.stdout = stdout;
    this.rotateBytes = rotateBytes;
    this.dropped = 0; // lines that failed to parse on the last read
  }

  /**
   * Append one record (README §4.4 shapes). Assigns `id` (uuid) and `at`
   * (unix secs), fills `kind` from `decision`/`verb` when the caller gave
   * none, hashes `args` into `argsSha256`, scrubs, writes one line, fsyncs,
   * mirrors the line to stdout. Throws only when the file cannot be
   * written — after the stdout mirror, so Loki still has the line.
   * @param {object} record
   * @returns {object} the record as written
   */
  append(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Journal.append expects an object');
    const { id: _id, at: _at, ...rest } = record;
    const { value: clean, redacted } = scrub(rest);
    const at = Math.floor(this.now() / 1000);
    const kind = typeof clean.kind === 'string' && clean.kind
      ? clean.kind
      : clean.verb ? (isOkDecision(clean) ? 'verb' : 'refusal') : 'event';
    const line = { id: randomUUID(), at, kind, ...clean };
    if (clean.args !== undefined && clean.argsSha256 === undefined) line.argsSha256 = argsSha256(clean.args);
    if (redacted.length) line.redacted = [...new Set([...(Array.isArray(clean.redacted) ? clean.redacted : []), ...redacted])];
    const text = `${JSON.stringify(line)}\n`;

    let writeError = null;
    try {
      this.#write(text);
    } catch (error) {
      writeError = error;
    }
    if (this.stdout) {
      const mirror = writeError ? { curator: 'journal', ...line, journalError: writeError.code ?? 'EWRITE' } : { curator: 'journal', ...line };
      try { this.stdout.write(`${JSON.stringify(mirror)}\n`); } catch { /* a closed pipe must not stop a verb */ }
    }
    if (writeError) throw writeError;
    return line;
  }

  #write(text) {
    mkdirSync(dirname(this.file), { recursive: true });
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (size >= this.rotateBytes) renameSync(this.file, this.rotatedFile);
    const fd = openSync(this.file, 'a', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The last `n` records, oldest first, spanning the rotated file when the
   * current one is shorter than `n`.
   * @param {number} n
   * @returns {object[]}
   */
  tail(n) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    if (count === 0) return [];
    let lines = lastLines(this.file, count);
    if (lines.length < count) lines = [...lastLines(this.rotatedFile, count - lines.length), ...lines];
    return parseLines(lines);
  }

  /**
   * Every record on disk, oldest first (rotated file, then current).
   * @returns {object[]}
   */
  records() {
    const lines = [...readLines(this.rotatedFile), ...readLines(this.file)];
    const parsed = parseLines(lines);
    this.dropped = lines.filter((line) => line.trim() !== '').length - parsed.length;
    return parsed;
  }

  /**
   * Rebuild the README §4.3 ledger from the file alone. The loop merges the
   * chain's `lastRebalanceAt` in afterwards (a proposal made by a previous
   * key or a stranger still counts for cadence).
   * @param {{ now?: number } | number} [opts] unix secs; defaults to the injected clock
   * @returns {object} ledger
   */
  rebuildLedger(opts = {}) {
    const given = typeof opts === 'number' ? opts : opts?.now;
    const now = Number.isFinite(given) ? given : Math.floor(this.now() / 1000);
    const ledger = {
      lastProposalAt: null,
      proposalsLast30d: 0,
      proposals: [],
      depositsTodayUsd: 0,
      withdrawalsTodayUsd: 0,
      writeAttempts: [],
      writeAttemptsLastHour: 0,
      paused: false,
      selfLocked: null,
      operatorRequest: null,
      applied: [],
      // The last plain review's carry-over (metrics.deriveReview's notepad):
      // the drift streak per asset and the risk tiers it saw. Signer-side
      // only; nothing the agent sends ever lands here.
      reviewState: null,
      // The newest ok deposit, whatever its age: the LEG_NEEDS_INFLOW trigger
      // asks how long since the last inflow, not only what landed today.
      lastDepositAt: null,
    };
    for (const record of this.records()) {
      const at = Number(record.at);
      if (!Number.isFinite(at)) continue;
      const { kind, verb } = record;
      const ok = isOk(record);

      if ((kind === 'verb' || kind === 'refusal') && LEDGER_WRITE_VERBS.includes(verb) && at > now - HOUR_SECS && at <= now) {
        ledger.writeAttempts.push(at);
      }
      if (kind === 'verb' && ok) {
        if (verb === 'propose') {
          ledger.proposals.push({
            at,
            effectiveAt: record.effectiveAt ?? null,
            targets: record.args?.targets ?? record.targets ?? null,
            signatures: Array.isArray(record.signatures) ? record.signatures : [],
            why: record.args?.why ?? record.why ?? null,
          });
        } else if (verb === 'deposit') {
          if (sameUtcDay(at, now)) ledger.depositsTodayUsd += usd(record);
          if (ledger.lastDepositAt == null || at > ledger.lastDepositAt) ledger.lastDepositAt = at;
        } else if (verb === 'withdraw' && sameUtcDay(at, now)) {
          ledger.withdrawalsTodayUsd += usd(record);
        } else if (verb === 'apply') {
          ledger.applied.push({ at, deploymentId: record.deploymentId ?? null, signatures: Array.isArray(record.signatures) ? record.signatures : [] });
        }
      }
      if (kind === 'apply' && (record.to === 'DONE' || record.state === 'DONE')) {
        ledger.applied.push({ at, deploymentId: record.deploymentId ?? null, signatures: Array.isArray(record.signatures) ? record.signatures : [] });
      }
      if (kind === 'pause' || (kind === 'verb' && verb === 'pause' && ok)) ledger.paused = true;
      if (kind === 'resume' || (kind === 'verb' && verb === 'resume' && ok)) ledger.paused = false;
      if (kind === 'lock') {
        ledger.selfLocked = { at, reason: record.reason ?? record.message ?? null, ...(record.drift !== undefined ? { drift: record.drift } : {}) };
      }
      if (kind === 'unlock' || (kind === 'verb' && verb === 'unlock' && ok)) ledger.selfLocked = null;
      // A request outlives a restart: an operator who asked for a review before
      // a node upgrade should not have to notice the pod moved and ask again.
      if (kind === 'operator-request') {
        ledger.operatorRequest = { at, text: typeof record.text === 'string' ? record.text : null };
      }
      if (kind === 'operator-request-consumed') ledger.operatorRequest = null;
      // The last review record wins, whatever its age. A gap between reviews
      // (a pod down for a week, a paused cron) does not reset the streak: the
      // asset was under target before the gap and nothing during it healed
      // that. verbs.review seeds the next plain review from this.
      if (kind === 'review') {
        ledger.reviewState = { at, driftStreak: plainMap(record.driftStreak), riskTiers: plainMap(record.riskTiers) };
      }
    }
    if (ledger.proposals.length) ledger.lastProposalAt = Math.max(...ledger.proposals.map((entry) => entry.at));
    ledger.proposalsLast30d = ledger.proposals.filter((entry) => entry.at > now - THIRTY_DAYS_SECS).length;
    ledger.writeAttemptsLastHour = ledger.writeAttempts.length;
    return ledger;
  }
}

/** A record without `kind` is a verb outcome when `ok`/`decision` say so. */
function isOkDecision(record) {
  if (record.ok === false) return false;
  if (typeof record.decision === 'string') return !/^(refus|den|reject|block)/i.test(record.decision);
  return true;
}
