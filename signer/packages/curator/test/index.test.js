/**
 * Boot guards: a short, missing or shared token, a bad pubkey, a missing
 * policy or RPC each refuse before a key file is opened or a port is bound,
 * with a reason that names the variable and never its value. A full boot on
 * port 0 with fakes for the chain and the api proves the wiring (ctx,
 * journal boot record, first tick, /healthz, clean stop) without a network.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressLookupTableAccount, Keypair } from '@solana/web3.js';
import { boot, readConfig, allowedProgramSet, loadLookupTables, CORE_PROGRAMS, jsonLogger } from '../src/index.js';
import { fakeDeps, fakeClient, fakeSigner, fakeSnapshot, POLICY, MINT, TREASURY, GUARDIAN, WALLET } from './fakes.js';
import { Journal, canonicalSha256 } from '../src/journal.js';

/** The real journal on a temp file, with the stdout mirror off so a planted lock line is not printed. */
const quietJournal = (file) => new Journal({ file, stdout: null });

const AGENT = 'agent-token-0123456789abcdef0123456789abcdef';
const OPS = 'ops-token-0123456789abcdef0123456789abcdef00';
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const fullEnv = (over = {}) => ({
  CURATOR_SIGNER_TOKEN: AGENT,
  CURATOR_OPS_TOKEN: OPS,
  CURATOR_KEYPAIR: '/nonexistent/curator.json',
  CURATOR_PORTFOLIO_MINT: MINT,
  CURATOR_TREASURY: TREASURY,
  CURATOR_EXPECTED_GUARDIAN: GUARDIAN,
  CURATOR_API_URL: 'http://api.test:8080',
  CURATOR_RPC_URL: 'http://rpc.test:8899/with-a-secret-key',
  CURATOR_POLICY_JSON: JSON.stringify(POLICY),
  CURATOR_PORT: '0',
  CURATOR_TICK_MS: '1000',
  ...over,
});

test('readConfig refuses each missing or malformed variable by name, never by value', () => {
  const cases = [
    [{ CURATOR_SIGNER_TOKEN: 'short' }, /CURATOR_SIGNER_TOKEN must be at least 32 bytes/],
    [{ CURATOR_OPS_TOKEN: undefined }, /CURATOR_OPS_TOKEN is not set/],
    [{ CURATOR_OPS_TOKEN: AGENT }, /must differ/],
    [{ CURATOR_KEYPAIR: '' }, /CURATOR_KEYPAIR is required/],
    [{ CURATOR_PORTFOLIO_MINT: 'nope' }, /CURATOR_PORTFOLIO_MINT is not a base58 public key/],
    [{ CURATOR_TREASURY: undefined }, /CURATOR_TREASURY is required/],
    [{ CURATOR_EXPECTED_GUARDIAN: '1234' }, /CURATOR_EXPECTED_GUARDIAN is not a base58 public key/],
    [{ CURATOR_API_URL: 'api:8080' }, /CURATOR_API_URL must be an http/],
    [{ CURATOR_RPC_URL: undefined }, /CURATOR_RPC_URL \(or SOLANA_RPC_URL\) is required/],
    [{ CURATOR_POLICY_JSON: '' }, /CURATOR_POLICY_JSON \(or CURATOR_POLICY_FILE\) is required/],
    [{ CURATOR_PORT: '70000' }, /CURATOR_PORT must be an integer/],
    [{ CURATOR_TICK_MS: '10' }, /CURATOR_TICK_MS must be an integer between 1000/],
  ];
  for (const [over, pattern] of cases) {
    const env = fullEnv(over);
    for (const key of Object.keys(over)) if (over[key] === undefined) delete env[key];
    assert.throws(() => readConfig(env), (error) => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes(AGENT) && !error.message.includes(OPS) && !error.message.includes('with-a-secret-key'), 'no secret in the reason');
      return true;
    });
  }
  const cfg = readConfig(fullEnv({ SOLANA_RPC_URL: 'http://fallback.test', CURATOR_RPC_URL: undefined, CURATOR_JOURNAL_PATH: '/tmp/j.jsonl', CURATOR_SIGNER_PORT: '9000', CURATOR_PORT: undefined, CURATOR_PAUSED: '1' }));
  assert.equal(cfg.rpcUrl, 'http://fallback.test');
  assert.equal(cfg.journalFile, '/tmp/j.jsonl');
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.startPaused, true);
  assert.equal(cfg.tickMs, 1000);
});

test('boot with a short token rejects before the key file is opened or a port is bound', async () => {
  await assert.rejects(boot({ env: fullEnv({ CURATOR_SIGNER_TOKEN: 'x'.repeat(31) }), overrides: { signals: false } }), /CURATOR_SIGNER_TOKEN must be at least 32 bytes/);
  await assert.rejects(boot({ env: fullEnv(), overrides: { signals: false } }), /CURATOR_KEYPAIR: keypair file is unreadable \(ENOENT\)/);
  await assert.rejects(boot({ env: fullEnv({ CURATOR_POLICY_JSON: '{"version":' }), overrides: { signals: false, signer: fakeSigner() } }), /^Error: policy:/);
});

test('the program allowlist is the manifest pins plus the core programs', () => {
  const programs = allowedProgramSet();
  for (const id of Object.values(CORE_PROGRAMS)) assert.ok(programs.has(id), id);
  assert.ok(programs.size > Object.keys(CORE_PROGRAMS).length, 'the vendored manifest pins at least one weavr program');
});

test('a full boot on port 0 with fakes: ctx wired, boot record journaled, first tick runs, /healthz answers, stop is clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-boot-'));
  dirs.push(dir);
  const journalFile = join(dir, 'journal.jsonl');
  const trace = [];
  const deps = fakeDeps({ trace, snapshot: fakeSnapshot() });
  const client = fakeClient({ trace });
  const signer = fakeSigner({ trace });
  const logs = [];
  const started = await boot({
    env: fullEnv({ CURATOR_JOURNAL: journalFile, CURATOR_START_PAUSED: '1' }),
    overrides: {
      signer, client, deps, connection: { getSlot: async () => 1 }, log: (level, event, fields) => logs.push({ level, event, ...fields }), signals: false,
      journal: quietJournal(journalFile),
    },
  });
  const { ctx, loop, server, stop } = started;
  try {
    assert.equal(ctx.config.mint, MINT);
    assert.equal(ctx.config.expectedCurator, WALLET);
    assert.equal(ctx.config.treasury, TREASURY);
    assert.equal(ctx.config.guardian, GUARDIAN);
    assert.equal(ctx.config.rebalanceDelaySecs, 86400);
    assert.equal(ctx.state.paused, true, 'CURATOR_START_PAUSED');
    assert.equal(ctx.policy.version, 1);
    assert.ok(ctx.chain.idls.portfolio_factory && ctx.chain.idls.stoken && ctx.chain.idls.accountant, 'IDLs loaded from deploy/idls');
    assert.ok(ctx.chain.programs.has(CORE_PROGRAMS.computeBudget));
    assert.ok(ctx.chain.lookupTables instanceof Map, 'table contents, keyed by address');
    assert.ok(ctx.chain.lookupTableAllowlist instanceof Set);
    assert.equal(typeof ctx.chain.refreshLookupTables, 'function');
    const { port } = server.address();
    assert.ok(port > 0);
    await loop.tick();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const unauth = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(unauth.status, 401);
    const status = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.paused, true);
    const lines = readFileSync(journalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].kind, 'boot');
    assert.equal(lines[0].wallet, WALLET);
    assert.equal(lines[0].paused, true);
    // The policy digest: computed once at boot over the LOADED document (comments stripped), quoted by the boot
    // record, the boot log line and /status alike, and served whole by /policy.
    assert.match(lines[0].policySha256, /^[0-9a-f]{64}$/);
    assert.equal(lines[0].policySha256, canonicalSha256(ctx.policy));
    assert.notEqual(lines[0].policySha256, canonicalSha256(POLICY), 'the env text carries _comment keys the loaded document does not');
    assert.equal(ctx.policyDigest, lines[0].policySha256);
    assert.equal(statusBody.policy.sha256, lines[0].policySha256);
    assert.equal(logs.find((l) => l.event === 'boot').policySha256, lines[0].policySha256);
    const served = await fetch(`http://127.0.0.1:${port}/policy`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(served.status, 200);
    const policyBody = await served.json();
    assert.equal(policyBody.sha256, lines[0].policySha256);
    assert.deepEqual(policyBody.policy, JSON.parse(JSON.stringify(ctx.policy)));
    assert.equal(ctx.state.reviewState, null, 'a fresh journal seeds no review state');
    assert.equal(lines[0].reviewState, null);
    assert.ok(!readFileSync(journalFile, 'utf8').includes('with-a-secret-key'));
    assert.ok(!JSON.stringify(logs).includes('with-a-secret-key'));
    assert.ok(logs.some((l) => l.event === 'boot'));
    assert.equal(client.calls.length, 0, 'nothing was built or sent');
  } finally {
    await stop();
  }
  assert.equal(loop.state().running, false);
  assert.equal(server.listening, false);
});

test('a second boot on the same journal keeps the pause, the self-lock and the review state from the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-boot2-'));
  dirs.push(dir);
  const journalFile = join(dir, 'journal.jsonl');
  const first = await boot({
    env: fullEnv({ CURATOR_JOURNAL: journalFile }),
    overrides: { signer: fakeSigner(), client: fakeClient(), deps: fakeDeps(), connection: {}, log: () => {}, signals: false, journal: quietJournal(journalFile) },
  });
  assert.equal(first.ctx.state.reviewState, null);
  first.ctx.journal.append({ kind: 'pause', why: 'incident' });
  first.ctx.journal.append({ kind: 'lock', reason: 'INVARIANT_DRIFT', drift: [{ invariant: 'portfolio.curator', expected: 'a', actual: 'b' }] });
  first.ctx.journal.append({ kind: 'review', driftStreak: { pSOL: 1 }, riskTiers: { pSOL: 2 }, triggers: [] });
  const review = first.ctx.journal.append({ kind: 'review', driftStreak: { pSOL: 2, pCBBTC: 0 }, riskTiers: { pSOL: 2, pCBBTC: 2 }, triggers: [] });
  await first.stop();
  const second = await boot({
    env: fullEnv({ CURATOR_JOURNAL: journalFile }),
    overrides: { signer: fakeSigner(), client: fakeClient(), deps: fakeDeps(), connection: {}, log: () => {}, signals: false, journal: quietJournal(journalFile) },
  });
  try {
    assert.equal(second.ctx.state.paused, true);
    assert.equal(second.ctx.state.selfLocked.reason, 'INVARIANT_DRIFT');
    assert.equal(second.ctx.state.selfLocked.drift.length, 1);
    // The last review record seeds the restarted process, so the streak an asset built up is not forgotten.
    assert.deepEqual(second.ctx.state.reviewState, { at: review.at, driftStreak: { pSOL: 2, pCBBTC: 0 }, riskTiers: { pSOL: 2, pCBBTC: 2 } });
    assert.deepEqual(second.ctx.state.ledger.reviewState, second.ctx.state.reviewState);
    const boots = readFileSync(journalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => line.kind === 'boot');
    assert.equal(boots.length, 2);
    assert.deepEqual(boots[1].reviewState, { at: review.at }, 'the boot record says what it replayed, by date only');
    assert.equal(boots[1].policySha256, boots[0].policySha256, 'the same document digests the same across boots');
  } finally {
    await second.stop();
  }
});

test('jsonLogger scrubs URLs and secret-shaped keys', () => {
  const lines = [];
  const log = jsonLogger({ write: (line) => lines.push(JSON.parse(line)) });
  log('info', 'x', { url: 'https://rpc.test/key123', token: 'abc', nested: { authorization: 'Bearer z', fine: 'ok' } });
  assert.equal(lines[0].url, '<url>');
  assert.equal(lines[0].token, '[redacted]');
  assert.equal(lines[0].nested.authorization, '[redacted]');
  assert.equal(lines[0].nested.fine, 'ok');
  assert.equal(lines[0].curator, 'log');
});

const tableAccount = (key, addresses) => new AddressLookupTableAccount({
  key,
  state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
});

test('loadLookupTables reads the allowed tables\' contents through the connection and keeps an unreadable one as null (allowed, unresolved); it never throws', async () => {
  const known = Keypair.generate().publicKey;
  const unknown = Keypair.generate().publicKey;
  const account = tableAccount(known, [Keypair.generate().publicKey]);
  const connection = { getAddressLookupTable: async (key) => ({ value: key.equals(known) ? account : null }) };
  const tables = await loadLookupTables(connection, new Set([known.toBase58(), unknown.toBase58()]));
  assert.equal(tables.size, 2);
  assert.equal(tables.get(known.toBase58()), account);
  assert.equal(tables.get(unknown.toBase58()), null);
  const none = await loadLookupTables({}, new Set([known.toBase58()]));
  assert.equal(none.get(known.toBase58()), null, 'a connection without the method is an unresolved table, not a crash');
  const failing = await loadLookupTables({ getAddressLookupTable: async () => { throw new Error('rpc down'); } }, [known.toBase58()]);
  assert.equal(failing.get(known.toBase58()), null);
  assert.equal((await loadLookupTables({}, new Set())).size, 0);
});

test('boot reads the NAV table\'s contents once and wires the allowlist, the contents Map and the refresh on ctx.chain; the loop refreshes it again on its tick', async () => {
  const table = Keypair.generate().publicKey;
  const account = tableAccount(table, [Keypair.generate().publicKey, Keypair.generate().publicKey]);
  let reads = 0;
  const connection = {
    getSlot: async () => 1,
    getAddressLookupTable: async (key) => { reads += 1; return { value: key.equals(table) ? account : null }; },
  };
  const dir = mkdtempSync(join(tmpdir(), 'curator-boot3-'));
  dirs.push(dir);
  const journalFile = join(dir, 'journal.jsonl');
  const previous = process.env.NAV_LOOKUP_TABLE;
  process.env.NAV_LOOKUP_TABLE = table.toBase58();
  let started;
  try {
    started = await boot({
      env: fullEnv({ CURATOR_JOURNAL: journalFile, CURATOR_START_PAUSED: '1' }),
      overrides: { signer: fakeSigner(), client: fakeClient(), deps: fakeDeps(), connection, log: () => {}, signals: false, journal: quietJournal(journalFile) },
    });
  } finally {
    if (previous === undefined) delete process.env.NAV_LOOKUP_TABLE;
    else process.env.NAV_LOOKUP_TABLE = previous;
  }
  const { ctx, loop, stop } = started;
  try {
    assert.deepEqual([...ctx.chain.lookupTableAllowlist], [table.toBase58()]);
    assert.ok(ctx.chain.lookupTables instanceof Map);
    assert.equal(ctx.chain.lookupTables.get(table.toBase58()), account, 'the contents, not only the address');
    assert.equal(typeof ctx.chain.refreshLookupTables, 'function');
    await loop.tick();
    assert.ok(reads >= 2, `once at boot and once per tick (${reads})`);
    const boot0 = readFileSync(journalFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))[0];
    assert.equal(boot0.kind, 'boot');
    assert.equal(boot0.lookupTables, 1);
    assert.equal(boot0.lookupTablesResolved, 1);
  } finally {
    await stop();
  }
});
