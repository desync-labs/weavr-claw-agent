// weavr-curator ops: the ops-token port. The token comes from a 0600 file
// under the home and never from argv; each verb's exact method, path, body
// and headers are recorded by a fake signer; a refusal is exit 1 with the
// signer's code; the token never reaches stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { COMMANDS, DEFAULT_URL, REQUEST_REVIEW_MAX_CHARS, buildRequest, ops, readOpsToken } from '../lib/curator/ops.mjs';
import { homePaths } from '../lib/curator/home.mjs';
import { startFakeServer } from './fixtures/curator/fake-server.mjs';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/weavr-curator.mjs');
const OPS_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const AGENT_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function homeWith(token, mode = 0o600) {
  const home = join(mkdtempSync(join(tmpdir(), 'weavr-ops-')), 'CLAWA1');
  const paths = homePaths(home);
  mkdirSync(paths.curatorDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.opsToken, token, { mode: 0o600 });
  chmodSync(paths.opsToken, mode);
  return { home, paths };
}

async function signer(extra = {}) {
  const server = await startFakeServer({ portfolios: [], pools: [], signer: { agentToken: AGENT_TOKEN, opsToken: OPS_TOKEN, status: { ok: true, paused: true }, ...extra } });
  return server;
}

function run(command, opts, { home, url }) {
  const lines = [];
  return ops(command, { url, ...opts }, { home, log: (l) => lines.push(l) })
    .then((r) => ({ ...r, lines, text: lines.join('\n') }), (e) => ({ error: e, lines, text: lines.join('\n') }));
}

test('ops: a 0644 token file is refused, naming the file and not the token', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const { home, paths } = homeWith(OPS_TOKEN, 0o644);
  const r = await run('status', {}, { home, url: s.url });
  assert.ok(r.error);
  assert.match(r.error.message, /ops token: .*ops-token must be mode 0600 \(is 644\)/);
  assert.ok(r.error.message.includes(paths.opsToken));
  assert.ok(!r.error.message.includes(OPS_TOKEN));
  assert.equal(s.hits.length, 0, 'no request was made');
  assert.throws(() => readOpsToken(home), /must be mode 0600/);
});

test('ops: a token under 32 bytes is refused', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const { home } = homeWith('short-token');
  const r = await run('status', {}, { home, url: s.url });
  assert.match(r.error.message, /ops token: .*holds no usable token \(need at least 32 bytes\)/);
  assert.equal(s.hits.length, 0);
  const missing = homeWith(OPS_TOKEN);
  const r2 = await run('status', {}, { home: join(missing.home, 'nope'), url: s.url });
  assert.match(r2.error.message, /ops token: .*is missing/);
});

test('ops: --token on the command line is refused before anything is read or sent', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const { home } = homeWith(OPS_TOKEN);
  const r = await run('status', { token: OPS_TOKEN }, { home, url: s.url });
  assert.equal(r.error.code, 'USAGE');
  assert.match(r.error.message, /refusing --token: the ops token is read from <home>\/curator\/ops-token, never the command line/);
  assert.equal(s.hits.length, 0);
});

test('ops: each command sends exactly its method, path, body and headers', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const { home } = homeWith(OPS_TOKEN);
  const newCurator = Keypair.generate().publicKey.toBase58();
  const table = [
    ['status', {}, 'GET', '/status', null],
    ['resume', {}, 'POST', '/resume', {}],
    ['resume', { why: 'doctor green' }, 'POST', '/resume', { why: 'doctor green' }],
    ['unlock', { why: 'drift gone' }, 'POST', '/unlock', { why: 'drift gone' }],
    ['request-review', { text: 'look at pSOL', why: 'owner asks' }, 'POST', '/operator-request', { text: 'look at pSOL', why: 'owner asks' }],
    ['request-review', { clear: true, why: 'withdrawn' }, 'POST', '/operator-request', { clear: true, why: 'withdrawn' }],
    ['rotate-curator', { 'new-curator': newCurator, why: 'key rotation' }, 'POST', '/rotate-curator', { newCurator, why: 'key rotation' }],
    ['set-delay', { 'rebalance-delay-secs': '3600', why: 'longer notice' }, 'POST', '/set-delay', { rebalanceDelaySecs: 3600, why: 'longer notice' }],
  ];
  for (const [command, opts, method, path, body] of table) {
    s.hits.length = 0;
    const r = await run(command, opts, { home, url: s.url });
    assert.ok(!r.error, `${command}: ${r.error?.message}`);
    assert.equal(r.status, 200);
    assert.equal(s.hits.length, 1, `${command} makes one request`);
    const hit = s.hits[0];
    assert.equal(hit.method, method, command);
    assert.equal(hit.path, path, command);
    assert.deepEqual(hit.body, body, command);
    assert.equal(hit.headers.authorization, `Bearer ${OPS_TOKEN}`);
    assert.equal(hit.headers['x-curator-session'], 'chat');
    assert.equal(hit.headers['x-curator-caller'], 'weavr-curator-cli');
    assert.equal(r.lines[0], `${method} ${path} -> 200`);
    assert.ok(!r.text.includes(OPS_TOKEN), 'the token never reaches stdout');
    assert.doesNotMatch(r.text, /Bearer/);
  }
  assert.deepEqual([...COMMANDS].sort(), ['request-review', 'resume', 'rotate-curator', 'set-delay', 'status', 'unlock']);
  assert.equal(DEFAULT_URL, 'http://127.0.0.1:8091');
});

test('ops: buildRequest refuses a missing --why, a bad key, a bad delay and an oversize text', () => {
  assert.throws(() => buildRequest('unlock', {}), /unlock needs --why/);
  assert.throws(() => buildRequest('unlock', { why: true }), /unlock needs --why/);
  assert.throws(() => buildRequest('rotate-curator', { 'new-curator': 'not-a-key', why: 'x' }), /--new-curator not-a-key is not a public key/);
  assert.throws(() => buildRequest('rotate-curator', { why: 'x' }), /--new-curator <pubkey> is required/);
  assert.throws(() => buildRequest('set-delay', { 'rebalance-delay-secs': '0', why: 'x' }), /must be a positive integer/);
  assert.throws(() => buildRequest('set-delay', { 'rebalance-delay-secs': '1.5', why: 'x' }), /must be a positive integer/);
  assert.throws(() => buildRequest('request-review', { text: 'x'.repeat(REQUEST_REVIEW_MAX_CHARS + 1), why: 'x' }), /at most 200 characters/);
  assert.throws(() => buildRequest('request-review', { text: '  ', why: 'x' }), /--text must not be empty/);
  assert.throws(() => buildRequest('request-review', { why: 'x' }), /--text <text> is required/);
  assert.throws(() => buildRequest('frobnicate', {}), /unknown command "frobnicate"/);
  assert.throws(() => buildRequest(undefined, {}), /ops <status\|resume\|unlock\|request-review\|rotate-curator\|set-delay>/);
  assert.deepEqual(buildRequest('request-review', { text: 'x'.repeat(REQUEST_REVIEW_MAX_CHARS), why: 'y' }).body.text.length, REQUEST_REVIEW_MAX_CHARS);
});

test('ops: a non-2xx is "signer refused <cmd>: <status> <code> <message>", with the reply printed', async (t) => {
  const s = await signer({ replies: { '/unlock': { status: 409, json: { error: { code: 'DRIFT_PRESENT', message: 'curator drift still present' } } } } });
  t.after(() => s.close());
  const { home } = homeWith(OPS_TOKEN);
  const r = await run('unlock', { why: 'trying' }, { home, url: s.url });
  assert.ok(r.error);
  assert.equal(r.error.message, 'signer refused unlock: 409 DRIFT_PRESENT curator drift still present');
  assert.equal(r.lines[0], 'POST /unlock -> 409');
  assert.match(r.text, /"DRIFT_PRESENT"/);
  assert.ok(!r.text.includes(OPS_TOKEN));
});

test('ops: the agent token in the ops-token file is 403 OPS_ONLY, an unknown token 401', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const agent = homeWith(AGENT_TOKEN);
  const r = await run('resume', {}, { home: agent.home, url: s.url });
  assert.match(r.error.message, /signer refused resume: 403 OPS_ONLY/);
  const stranger = homeWith('e'.repeat(64));
  const r2 = await run('status', {}, { home: stranger.home, url: s.url });
  assert.match(r2.error.message, /signer refused status: 401 UNAUTHORIZED/);
});

test('bin: ops status reaches the fake signer through --home and --url; --token is refused with exit 1', async (t) => {
  const s = await signer();
  t.after(() => s.close());
  const { home } = homeWith(OPS_TOKEN);
  const runBin = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args]);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const r = await runBin(['ops', 'status', '--home', home, '--url', s.url]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^GET \/status -> 200\n/);
  assert.match(r.stdout, /"paused": true/);
  assert.ok(!r.stdout.includes(OPS_TOKEN));
  const refused = await runBin(['ops', 'status', '--home', home, '--url', s.url, '--token', OPS_TOKEN]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing --token/);
  assert.equal(s.hits.length, 1, 'the refused run made no request');
  const usage = await runBin(['ops', 'unlock', '--home', home, '--url', s.url]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /unlock needs --why/);
  const refusedByServer = await runBin(['ops', 'resume', '--home', homeWith(AGENT_TOKEN).home, '--url', s.url]);
  assert.equal(refusedByServer.status, 1);
  assert.match(refusedByServer.stderr, /signer refused resume: 403 OPS_ONLY/);
});
