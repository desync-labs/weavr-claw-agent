/**
 * The journal is the durable record and the source of every cap. A planted
 * transaction body, key or RPC URL must never reach the file; a restart
 * must rebuild the same ledger; rotation must not lose the quota window.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, DEFAULT_JOURNAL_FILE, LEDGER_WRITE_VERBS, ROTATE_BYTES, argsSha256, canonicalSha256, scrub } from '../src/journal.js';

const DAY = 86400;
const NOW_SECS = 1_800_000_000; // a fixed instant, mid-UTC-day
const TX_B64 = Buffer.alloc(300, 0x41).toString('base64'); // 400 base64 chars: the shape of a serialised transaction
const KEY_BYTES = Array.from({ length: 64 }, (_, i) => i);
const RPC_URL = 'https://mainnet.example-rpc.com/?api-key=0123456789abcdef';
const RPC_PATH_URL = 'https://xyz.example-rpc.pro/0123456789abcdef01234567/';
const EVM_KEY = `0x${'ab'.repeat(32)}`;
const SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const METADATA_URI = 'https://www.weavr.sh/metadata/WEAVR.json';

let dir;
let clock;
let lines;
let journal;

const openJournal = (opts = {}) => new Journal({
  file: join(dir, 'journal.jsonl'),
  now: () => clock * 1000,
  stdout: { write: (line) => lines.push(line) },
  ...opts,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'curator-journal-'));
  clock = NOW_SECS;
  lines = [];
  journal = openJournal();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fileText = () => readFileSync(join(dir, 'journal.jsonl'), 'utf8');

describe('append', () => {
  it('assigns id and at, writes one JSONL line, mirrors it to stdout with a curator marker', () => {
    const written = journal.append({ kind: 'note', caller: 'ops', text: 'hello' });
    assert.match(written.id, /^[0-9a-f-]{36}$/);
    assert.equal(written.at, NOW_SECS);
    assert.equal(written.kind, 'note');
    const fileLines = fileText().split('\n').filter(Boolean);
    assert.equal(fileLines.length, 1);
    assert.deepEqual(JSON.parse(fileLines[0]), written);
    assert.equal(lines.length, 1);
    const mirrored = JSON.parse(lines[0]);
    assert.equal(mirrored.curator, 'journal');
    assert.equal(mirrored.id, written.id);
    assert.equal(mirrored.text, 'hello');
    assert.ok(lines[0].endsWith('\n'));
  });

  it('the file is created 0600 with its directory', () => {
    const nested = new Journal({ file: join(dir, 'deep', 'er', 'j.jsonl'), now: () => clock * 1000, stdout: null });
    nested.append({ kind: 'boot' });
    assert.equal(statSync(join(dir, 'deep', 'er', 'j.jsonl')).mode & 0o777, 0o600);
  });

  it('ignores a caller-supplied id/at (the journal is the clock)', () => {
    const written = journal.append({ id: 'mine', at: 1, kind: 'note' });
    assert.notEqual(written.id, 'mine');
    assert.equal(written.at, NOW_SECS);
  });

  it('planted secrets never reach the file or stdout, and the record says what was dropped', () => {
    const written = journal.append({
      kind: 'verb',
      verb: 'propose',
      tx: TX_B64,
      walletPayload: { transactions: [TX_B64] },
      signed: [TX_B64],
      args: { targets: [{ poolId: 'pSOL', weightBps: 5000 }], transactions: [{ step: 'propose', tx: TX_B64 }], keypair: KEY_BYTES },
      nested: { deeper: { bytes: KEY_BYTES, rpcUrl: RPC_URL, rpc2: RPC_PATH_URL, evm: EVM_KEY, blob: TX_B64 } },
      seed: 'twelve words here',
      token: 'bearer-thing',
    });
    const everything = `${fileText()}\n${lines.join('')}\n${JSON.stringify(written)}`;
    for (const banned of [TX_B64, JSON.stringify(KEY_BYTES), 'api-key', '0123456789abcdef01234567', EVM_KEY, 'twelve words', 'bearer-thing']) {
      assert.ok(!everything.includes(banned), `must not contain ${banned.slice(0, 24)}`);
    }
    assert.deepEqual(written.args.targets, [{ poolId: 'pSOL', weightBps: 5000 }], 'the allowed args survive');
    assert.equal(written.args.transactions[0].step, 'propose', 'the step label survives, only tx goes');
    for (const path of ['tx', 'walletPayload', 'signed', 'args.transactions[0].tx', 'args.keypair', 'nested.deeper.bytes', 'nested.deeper.rpcUrl', 'nested.deeper.rpc2', 'nested.deeper.evm', 'nested.deeper.blob', 'seed', 'token']) {
      assert.ok(written.redacted.includes(path), `redacted lists ${path}: ${written.redacted}`);
    }
  });

  it('legitimate values survive the scrub', () => {
    const written = journal.append({
      kind: 'verb',
      verb: 'setMetadata',
      tokenKind: 'ops',
      signatures: [SIGNATURE],
      args: { uri: METADATA_URI, why: 'new logo' },
      apiPath: '/v1/portfolios/So11111111111111111111111111111111111111112/metadata',
      argsSha256: 'a'.repeat(64),
      pubkey: 'So11111111111111111111111111111111111111112',
      why: 'x'.repeat(199),
    });
    assert.equal(written.redacted, undefined);
    assert.deepEqual(written.signatures, [SIGNATURE]);
    assert.equal(written.args.uri, METADATA_URI);
    assert.equal(written.tokenKind, 'ops');
    assert.equal(written.argsSha256, 'a'.repeat(64));
  });

  it('hashes args canonically when the caller gave no argsSha256', () => {
    const a = journal.append({ kind: 'verb', verb: 'deposit', args: { amountUsd: 5, why: 'top-up' } });
    const b = journal.append({ kind: 'verb', verb: 'deposit', args: { why: 'top-up', amountUsd: 5 } });
    const c = journal.append({ kind: 'verb', verb: 'deposit', args: { amountUsd: 6, why: 'top-up' } });
    assert.match(a.argsSha256, /^[0-9a-f]{64}$/);
    assert.equal(a.argsSha256, b.argsSha256, 'key order does not matter');
    assert.notEqual(a.argsSha256, c.argsSha256);
    assert.equal(a.argsSha256, argsSha256({ why: 'top-up', amountUsd: 5 }));
    assert.equal(journal.append({ kind: 'note' }).argsSha256, undefined);
  });

  it('fills kind from decision/verb when the caller gave none', () => {
    assert.equal(journal.append({ verb: 'deposit', decision: 'refused', code: 'DEPOSIT_DAILY_CAP' }).kind, 'refusal');
    assert.equal(journal.append({ verb: 'deposit', ok: false }).kind, 'refusal');
    assert.equal(journal.append({ verb: 'deposit', decision: 'signed' }).kind, 'verb');
    assert.equal(journal.append({ verb: 'deposit' }).kind, 'verb');
    assert.equal(journal.append({ text: 'x' }).kind, 'event');
  });

  it('renders bigint and PublicKey-like values as strings', () => {
    const written = journal.append({ kind: 'tick', lamports: 12345n, key: { toBase58: () => 'So11111111111111111111111111111111111111112' } });
    assert.equal(written.lamports, '12345');
    assert.equal(written.key, 'So11111111111111111111111111111111111111112');
  });

  it('rejects a non-object', () => {
    assert.throws(() => journal.append('note'), TypeError);
    assert.throws(() => journal.append(['x']), TypeError);
  });

  it('when the file cannot be written, stdout still gets the line and the error propagates', () => {
    writeFileSync(join(dir, 'notadir'), 'x');
    const broken = openJournal({ file: join(dir, 'notadir', 'journal.jsonl') });
    assert.throws(() => broken.append({ kind: 'boot' }), (error) => error.code === 'ENOTDIR' || error.code === 'EEXIST');
    assert.equal(lines.length, 1);
    const mirrored = JSON.parse(lines[0]);
    assert.equal(mirrored.curator, 'journal');
    assert.ok(mirrored.journalError);
  });
});

describe('tail', () => {
  it('returns the last n records oldest first, and [] for 0', () => {
    for (let i = 0; i < 5; i += 1) journal.append({ kind: 'note', i });
    assert.deepEqual(journal.tail(2).map((r) => r.i), [3, 4]);
    assert.deepEqual(journal.tail(10).map((r) => r.i), [0, 1, 2, 3, 4]);
    assert.deepEqual(journal.tail(0), []);
    assert.deepEqual(journal.tail(-1), []);
    assert.deepEqual(journal.tail('2').map((r) => r.i), [3, 4]);
  });

  it('returns [] before the file exists', () => {
    assert.deepEqual(journal.tail(5), []);
  });

  it('skips a torn last line (crash mid-write) and keeps the fsynced ones', () => {
    journal.append({ kind: 'note', i: 0 });
    journal.append({ kind: 'note', i: 1 });
    writeFileSync(join(dir, 'journal.jsonl'), `${fileText()}{"id":"torn","at":1,"kind":"no`);
    assert.deepEqual(journal.tail(5).map((r) => r.i), [0, 1]);
    assert.deepEqual(journal.records().map((r) => r.i), [0, 1]);
    assert.equal(journal.dropped, 1);
  });

  it('reads back through a file larger than one chunk without loading it all', () => {
    const big = openJournal({ file: join(dir, 'big.jsonl') });
    const pad = 'pad word '.repeat(120); // spaces: not blob-shaped, so it is kept
    for (let i = 0; i < 200; i += 1) big.append({ kind: 'note', i, pad });
    assert.ok(statSync(join(dir, 'big.jsonl')).size > 64 * 1024, 'spans more than one 64 KB chunk');
    assert.deepEqual(big.tail(3).map((r) => r.i), [197, 198, 199]);
    assert.deepEqual(big.tail(70).map((r) => r.i).slice(0, 2), [130, 131]);
  });
});

describe('rotation', () => {
  it('renames at rotateBytes and the readers span both files', () => {
    const small = openJournal({ rotateBytes: 250 });
    for (let i = 0; i < 6; i += 1) small.append({ kind: 'note', i });
    assert.ok(existsSync(join(dir, 'journal.jsonl.1')), 'rotated file exists');
    const current = fileText().split('\n').filter(Boolean).length;
    assert.ok(current < 6, `current file holds ${current} of 6`);
    assert.deepEqual(small.records().map((r) => r.i), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(small.tail(6).map((r) => r.i), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(small.tail(2).map((r) => r.i), [4, 5]);
  });

  it('defaults are 50 MB and the PVC path', () => {
    assert.equal(ROTATE_BYTES, 50 * 1024 * 1024);
    assert.equal(DEFAULT_JOURNAL_FILE, '/app/.cache/curator/journal.jsonl');
    assert.equal(new Journal({ now: Date.now, stdout: null }).file, DEFAULT_JOURNAL_FILE);
  });
});

describe('rebuildLedger', () => {
  const at = (secsAgo, fn) => { clock = NOW_SECS - secsAgo; fn(); clock = NOW_SECS; };

  it('is empty before anything happened', () => {
    assert.deepEqual(journal.rebuildLedger({ now: NOW_SECS }), {
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
      reviewState: null,
      lastDepositAt: null,
    });
  });

  it('replays the last review record into reviewState (the later wins, whatever its age); a malformed one is empty maps', () => {
    at(12 * DAY, () => journal.append({ kind: 'review', driftStreak: { pSOL: 1 }, riskTiers: { pSOL: 2 }, triggers: [] }));
    at(10 * DAY, () => journal.append({ kind: 'review', driftStreak: { pSOL: 2, pCBBTC: 0 }, riskTiers: { pSOL: 3, pCBBTC: 2 }, triggers: ['RISK_TIER_RAISED'] }));
    const ledger = journal.rebuildLedger({ now: NOW_SECS });
    assert.deepEqual(ledger.reviewState, { at: NOW_SECS - 10 * DAY, driftStreak: { pSOL: 2, pCBBTC: 0 }, riskTiers: { pSOL: 3, pCBBTC: 2 } });
    assert.deepEqual(openJournal().rebuildLedger({ now: NOW_SECS }).reviewState, ledger.reviewState, 'a restart sees the same state');
    // A record that is not a map of poolId → value seeds nothing rather than crashing the boot.
    at(60, () => journal.append({ kind: 'review', driftStreak: 'garbage', riskTiers: [1, 2], triggers: [] }));
    assert.deepEqual(journal.rebuildLedger({ now: NOW_SECS }).reviewState, { at: NOW_SECS - 60, driftStreak: {}, riskTiers: {} });
  });

  it('lastDepositAt is the newest ok deposit whatever its day; a refused deposit and a withdraw never move it', () => {
    at(5 * DAY, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 40 } }));
    at(3 * DAY, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 10 } }));
    at(DAY, () => journal.append({ kind: 'refusal', verb: 'deposit', ok: false, code: 'DEPOSIT_DAILY_CAP', args: { amountUsd: 999 } }));
    at(600, () => journal.append({ kind: 'verb', verb: 'withdraw', ok: true, args: { amountUsd: 5 } }));
    const ledger = journal.rebuildLedger({ now: NOW_SECS });
    assert.equal(ledger.lastDepositAt, NOW_SECS - 3 * DAY);
    assert.equal(ledger.depositsTodayUsd, 0, 'the day total is still the UTC day; the date is not');
    assert.equal(openJournal().rebuildLedger({ now: NOW_SECS }).lastDepositAt, NOW_SECS - 3 * DAY, 'a restart sees the same date');
    at(30, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 1 } }));
    assert.equal(journal.rebuildLedger({ now: NOW_SECS }).lastDepositAt, NOW_SECS - 30, 'a newer deposit moves it');
  });

  it('a review record survives the scrub: its keys are not on the forbidden list and its values are not secret-shaped', () => {
    const written = journal.append({
      kind: 'review', caller: 'curator-review-gate.sh', session: 'cron', tokenKind: 'agent',
      driftStreak: { pSOL: 3, pCBBTC: 0 }, riskTiers: { pSOL: 2, pCBBTC: 2 }, triggers: ['LEG_NEEDS_INFLOW'],
    });
    assert.equal(written.redacted, undefined);
    assert.deepEqual(written.driftStreak, { pSOL: 3, pCBBTC: 0 });
    assert.deepEqual(written.riskTiers, { pSOL: 2, pCBBTC: 2 });
    assert.deepEqual(written.triggers, ['LEG_NEEDS_INFLOW']);
    assert.equal(written.argsSha256, undefined, 'no args, no hash');
    assert.deepEqual(JSON.parse(fileText().trim()), written);
  });

  it('counts proposals, daily totals, hourly attempts, pause and lock state, applies', () => {
    const targets = [{ poolId: 'pSOL', weightBps: 10000 }];
    at(40 * DAY, () => journal.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets, why: 'old' }, signatures: ['s1'], effectiveAt: NOW_SECS - 39 * DAY }));
    at(3 * DAY, () => journal.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets, why: 'recent' }, signatures: ['s2'], effectiveAt: NOW_SECS - 2 * DAY }));
    at(2 * DAY, () => journal.append({ kind: 'refusal', verb: 'propose', ok: false, code: 'PROPOSAL_TOO_SOON', args: { targets } }));
    at(2 * DAY, () => journal.append({ kind: 'apply', from: 'CONFIRM', to: 'DONE', deploymentId: 'dep-1', signatures: ['a1', 'a2'] }));
    at(2 * DAY, () => journal.append({ kind: 'apply', from: 'PREFLIGHT', to: 'BLOCKED', blockers: [{ code: 'LEG_STALE' }] }));
    at(DAY + 60, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 100 } })); // yesterday
    at(3600, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 25 } }));
    at(1800, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 5.5 } }));
    at(1700, () => journal.append({ kind: 'refusal', verb: 'deposit', ok: false, code: 'DEPOSIT_DAILY_CAP', args: { amountUsd: 999 } }));
    at(1600, () => journal.append({ kind: 'verb', verb: 'withdraw', ok: true, args: { amountUsd: 10 } }));
    at(1500, () => journal.append({ kind: 'refusal', verb: 'withdraw', ok: false, code: 'WITHDRAW_CRON_BLOCKED', args: { amountUsd: 1 } }));
    at(1400, () => journal.append({ kind: 'verb', verb: 'status', ok: true }));
    at(1300, () => journal.append({ kind: 'verb', verb: 'apply', ok: true, deploymentId: 'dep-2', signatures: ['a3'] }));
    at(1200, () => journal.append({ kind: 'pause', caller: 'agent' }));
    at(1100, () => journal.append({ kind: 'lock', reason: 'INVARIANT_DRIFT', drift: [{ invariant: 'curator' }] }));
    at(1000, () => journal.append({ kind: 'resume', caller: 'ops' }));

    const ledger = journal.rebuildLedger({ now: NOW_SECS });
    assert.equal(ledger.lastProposalAt, NOW_SECS - 3 * DAY);
    assert.equal(ledger.proposalsLast30d, 1, 'the 40-day-old one is outside the window, the refusal never counts');
    assert.equal(ledger.proposals.length, 2);
    assert.deepEqual(ledger.proposals[1], { at: NOW_SECS - 3 * DAY, effectiveAt: NOW_SECS - 2 * DAY, targets, signatures: ['s2'], why: 'recent' });
    assert.equal(ledger.depositsTodayUsd, 30.5, 'yesterday and the refusal are excluded');
    assert.equal(ledger.withdrawalsTodayUsd, 10);
    assert.deepEqual(ledger.writeAttempts, [NOW_SECS - 1800, NOW_SECS - 1700, NOW_SECS - 1600, NOW_SECS - 1500, NOW_SECS - 1300], 'the 3600 s old deposit and the read verb are out; refusals are in');
    assert.equal(ledger.writeAttemptsLastHour, 5);
    assert.equal(ledger.paused, false, 'resume after pause');
    assert.deepEqual(ledger.selfLocked, { at: NOW_SECS - 1100, reason: 'INVARIANT_DRIFT', drift: [{ invariant: 'curator' }] });
    assert.deepEqual(ledger.applied, [
      { at: NOW_SECS - 2 * DAY, deploymentId: 'dep-1', signatures: ['a1', 'a2'] },
      { at: NOW_SECS - 1300, deploymentId: 'dep-2', signatures: ['a3'] },
    ]);
  });

  it('last pause/resume and lock/unlock records win', () => {
    at(300, () => journal.append({ kind: 'resume' }));
    at(200, () => journal.append({ kind: 'pause' }));
    at(100, () => journal.append({ kind: 'lock', reason: 'x' }));
    at(50, () => journal.append({ kind: 'unlock', caller: 'ops' }));
    const ledger = journal.rebuildLedger({ now: NOW_SECS });
    assert.equal(ledger.paused, true);
    assert.equal(ledger.selfLocked, null);
    at(10, () => journal.append({ kind: 'verb', verb: 'resume', ok: true }));
    assert.equal(journal.rebuildLedger({ now: NOW_SECS }).paused, false, 'a verb-shaped resume counts too');
  });

  it('a restart rebuilds the same ledger from the file (the cap survives)', () => {
    at(600, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 40 } }));
    at(500, () => journal.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets: [], why: 'w' } }));
    const before = journal.rebuildLedger({ now: NOW_SECS });
    const restarted = openJournal();
    const after = restarted.rebuildLedger({ now: NOW_SECS });
    assert.deepEqual(after, before);
    assert.equal(after.depositsTodayUsd, 40);
    assert.equal(after.proposalsLast30d, 1);
  });

  it('accepts a bare number and defaults to the clock', () => {
    at(100, () => journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 7 } }));
    assert.equal(journal.rebuildLedger(NOW_SECS).depositsTodayUsd, 7);
    assert.equal(journal.rebuildLedger().depositsTodayUsd, 7);
    clock = NOW_SECS + 2 * DAY;
    assert.equal(journal.rebuildLedger().depositsTodayUsd, 0, 'two days later it is not today');
  });

  it('the UTC day boundary, not a rolling 24 h, defines today', () => {
    const midnight = Math.floor(NOW_SECS / DAY) * DAY;
    clock = midnight - 1;
    journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 3 } });
    clock = midnight + 1;
    journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 4 } });
    assert.equal(journal.rebuildLedger({ now: midnight + 100 }).depositsTodayUsd, 4);
  });

  it('records from the rotated file still count', () => {
    const small = openJournal({ rotateBytes: 200 });
    at(500, () => small.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets: [], why: 'first' }, signatures: ['s'] }));
    at(400, () => small.append({ kind: 'tick', ok: true })); // the propose line is ≥ 200 bytes: this append rotates it out
    assert.ok(existsSync(join(dir, 'journal.jsonl.1')));
    assert.ok(!fileText().includes('"propose"'), 'the proposal lives in the rotated file');
    assert.equal(small.rebuildLedger({ now: NOW_SECS }).proposalsLast30d, 1);
  });

  it('the window is two files: a second rotation replaces the first rotated file', () => {
    const small = openJournal({ rotateBytes: 200 });
    at(500, () => small.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets: [], why: 'first' }, signatures: ['s'] }));
    at(400, () => small.append({ kind: 'verb', verb: 'propose', ok: true, args: { targets: [], why: 'second' }, signatures: ['s'] }));
    at(300, () => small.append({ kind: 'tick', ok: true }));
    assert.equal(small.rebuildLedger({ now: NOW_SECS }).proposalsLast30d, 1, 'only the second proposal is still on disk');
  });

  it('write verbs are the nine that reach the chain', () => {
    assert.deepEqual([...LEDGER_WRITE_VERBS], ['propose', 'apply', 'cancel', 'deposit', 'withdraw', 'refreshNav', 'rotateCurator', 'setDelay', 'setMetadata']);
  });
});

describe('canonicalSha256', () => {
  it('is key-order independent at every level, sensitive to a value, and what argsSha256 uses', () => {
    const a = canonicalSha256({ b: { y: 1, x: [1, { q: 2, p: 3 }] }, a: 'z' });
    const b = canonicalSha256({ a: 'z', b: { x: [1, { p: 3, q: 2 }], y: 1 } });
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
    assert.notEqual(a, canonicalSha256({ a: 'z', b: { x: [1, { p: 3, q: 2 }], y: 2 } }));
    assert.notEqual(a, canonicalSha256({ a: 'z', b: { x: [{ p: 3, q: 2 }, 1], y: 1 } }), 'array order is meaning');
    assert.equal(argsSha256({ amountUsd: 5, why: 'x' }), canonicalSha256({ why: 'x', amountUsd: 5 }));
    assert.equal(canonicalSha256(undefined), canonicalSha256(null));
  });
});

describe('scrub', () => {
  it('leaves an ordinary record untouched', () => {
    const record = { kind: 'verb', verb: 'deposit', args: { amountUsd: 5 }, signatures: [SIGNATURE], n: 1, flag: false, nothing: null };
    assert.deepEqual(scrub(record), { value: record, redacted: [] });
  });

  it('redacts 32-byte arrays too (a seed) and bounds the depth', () => {
    const { value, redacted } = scrub({ seedBytes: Array.from({ length: 32 }, () => 1), deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } });
    assert.equal(value.seedBytes, '[redacted:key-bytes]');
    assert.ok(redacted.includes('seedBytes'));
    assert.ok(redacted.some((path) => path.startsWith('deep.a.b.c')));
  });
});
