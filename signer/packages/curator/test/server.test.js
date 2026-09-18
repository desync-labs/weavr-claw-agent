/**
 * The HTTP surface on a loopback port: no token is a boot failure, no
 * header is 401, the agent token on an ops route is 403 OPS_ONLY, a missing
 * session header is cron (so withdraw is refused), bodies are bounded, and
 * nothing that looks like a transaction leaves the process.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fakeCtx, fakeSnapshot, NEW_TARGETS, T0 } from './fakes.js';
import { createServer, authenticate, readBody, scrubResponse, validateTokens, metaOf, ROUTES, MIN_TOKEN_BYTES } from '../src/server.js';
import { readConfig } from '../src/index.js';

const AGENT = 'agent-token-0123456789abcdef0123456789abcdef';
const OPS = 'ops-token-0123456789abcdef0123456789abcdef00';
const TOKENS = { agent: AGENT, ops: OPS };

const open = [];
after(async () => {
  for (const entry of open) {
    await entry.close();
    entry.ctx.cleanup();
  }
});

async function up(over = {}, tokens = TOKENS) {
  const ctx = fakeCtx(over);
  const server = createServer({ ctx, tokens });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text response */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') };
  };
  const handle = { ctx, server, call, close: () => new Promise((resolve) => server.close(resolve)) };
  open.push(handle);
  return handle;
}
const refusals = (ctx) => ctx.journal.records().filter((r) => r.kind === 'refusal');

test('createServer and readConfig refuse a missing, short or shared token without echoing it', () => {
  const ctx = fakeCtx();
  try {
    for (const [tokens, needle] of [
      [{ agent: undefined, ops: OPS }, 'CURATOR_SIGNER_TOKEN is not set'],
      [{ agent: AGENT, ops: '' }, 'CURATOR_OPS_TOKEN is not set'],
      [{ agent: 'short', ops: OPS }, `CURATOR_SIGNER_TOKEN must be at least ${MIN_TOKEN_BYTES} bytes`],
      [{ agent: AGENT, ops: 'x'.repeat(31) }, 'CURATOR_OPS_TOKEN must be at least'],
      [{ agent: AGENT, ops: AGENT }, 'must differ'],
      [{ agent: `${AGENT} `, ops: OPS }, 'whitespace'],
    ]) {
      assert.throws(() => createServer({ ctx, tokens }), (error) => error.message.includes(needle) && !error.message.includes(OPS) && !error.message.includes(AGENT), needle);
    }
    assert.throws(() => readConfig({ CURATOR_SIGNER_TOKEN: 'short', CURATOR_OPS_TOKEN: OPS }), /CURATOR_SIGNER_TOKEN must be at least/);
    assert.throws(() => readConfig({ CURATOR_OPS_TOKEN: OPS }), /CURATOR_SIGNER_TOKEN is not set/);
    assert.doesNotThrow(() => validateTokens(TOKENS));
  } finally {
    ctx.cleanup();
  }
});

test('authenticate: null for a missing, malformed, unknown or short-configured token; the matched token decides the kind', () => {
  assert.equal(authenticate(undefined, TOKENS), null);
  assert.equal(authenticate('', TOKENS), null);
  assert.equal(authenticate(`Basic ${AGENT}`, TOKENS), null);
  assert.equal(authenticate(AGENT, TOKENS), null);
  assert.equal(authenticate(`Bearer ${AGENT}x`, TOKENS), null);
  assert.equal(authenticate(`Bearer ${AGENT.slice(0, -1)}`, TOKENS), null);
  assert.equal(authenticate('Bearer short', { agent: 'short', ops: OPS }), null, 'a short configured token never matches');
  assert.deepEqual(authenticate(`Bearer ${AGENT}`, TOKENS), { kind: 'agent' });
  assert.deepEqual(authenticate(`bearer   ${OPS}`, TOKENS), { kind: 'ops' });
  assert.equal(authenticate(`Bearer ${AGENT}`, { agent: undefined, ops: OPS }), null, 'an unset token is closed, not open');
});

test('an unauthenticated request is 401 UNAUTHORIZED, journaled, and the verb never runs', async () => {
  const { ctx, call } = await up();
  for (const [method, path] of [['GET', '/status'], ['POST', '/propose'], ['POST', '/resume'], ['GET', '/journal']]) {
    const res = await call(method, path, { body: method === 'POST' ? {} : undefined, headers: { 'x-curator-caller': 'stranger' } });
    assert.equal(res.status, 401, path);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
  }
  const wrong = await call('GET', '/status', { token: 'nope-nope-nope-nope-nope-nope-nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(ctx.trace.length, 0);
  assert.equal(refusals(ctx).length, 5);
  assert.equal(refusals(ctx)[0].caller, 'stranger');
});

test('an ops route with the agent token is 403 OPS_ONLY; the ops token passes on both kinds of route', async () => {
  const { ctx, call } = await up({ paused: true });
  for (const path of ['/resume', '/unlock', '/rotate-curator', '/set-delay', '/set-metadata', '/operator-request']) {
    const res = await call('POST', path, { token: AGENT, body: { why: 'x' } });
    assert.equal(res.status, 403, path);
    assert.equal(res.json.error.code, 'OPS_ONLY');
  }
  assert.equal(ctx.state.paused, true, 'resume did not run');
  // /operator-request among them: an agent that can ask itself to wake makes the
  // wake gate the model's decision, which is the one thing it must not be.
  assert.equal(ctx.state.operatorRequest, null, 'the agent token did not set a request');
  assert.equal(refusals(ctx).filter((r) => r.code === 'OPS_ONLY').length, 6);
  const resumed = await call('POST', '/resume', { token: OPS, body: { why: 'drill' } });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.json, { ok: true, paused: false });
  const status = await call('GET', '/status', { token: OPS });
  assert.equal(status.status, 200);
  assert.equal(status.json.paused, false);
});

test('X-Curator-Session missing or unknown is cron; caller is journaled and bounded', async () => {
  const { ctx, call } = await up();
  await call('POST', '/note', { token: AGENT, body: { text: 'one' } });
  await call('POST', '/note', { token: AGENT, body: { text: 'two' }, headers: { 'x-curator-session': 'CHAT', 'x-curator-caller': 'hermes-plugin' } });
  await call('POST', '/note', { token: AGENT, body: { text: 'three' }, headers: { 'x-curator-session': 'batch', 'x-curator-caller': 'a'.repeat(100) } });
  const notes = ctx.journal.records().filter((r) => r.kind === 'note');
  assert.deepEqual(notes.map((r) => [r.session, r.caller, r.tokenKind]), [
    ['cron', 'unknown', 'agent'],
    ['chat', 'hermes-plugin', 'agent'],
    ['cron', 'a'.repeat(64), 'agent'],
  ]);
  assert.deepEqual(metaOf({}), { session: 'cron', caller: 'unknown', tokenKind: 'agent' });
  assert.equal(metaOf({ 'x-curator-caller': 'tab\there' }).caller, 'unknown', 'non-printable callers are dropped');
});

test('withdraw in a cron session is 403 WITHDRAW_CRON_BLOCKED and nothing is signed; in chat it goes through', async () => {
  const { ctx, call } = await up();
  const cron = await call('POST', '/withdraw', { token: AGENT, body: { amountUsd: 10 } });
  assert.equal(cron.status, 403);
  assert.equal(cron.json.error.code, 'WITHDRAW_CRON_BLOCKED');
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal(ctx.client.calls.length, 0);
  const chat = await call('POST', '/withdraw', { token: AGENT, body: { amountUsd: 10 }, headers: { 'x-curator-session': 'chat' } });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.verb, 'withdraw');
  assert.deepEqual(chat.json.signatures, ['sig-1']);
  assert.equal(chat.json.transactions, undefined);
});

test('malformed, non-object and oversized bodies are 400 BAD_REQUEST', async () => {
  const { call } = await up();
  const bad = await call('POST', '/note', { token: AGENT, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'BAD_REQUEST');
  const array = await call('POST', '/note', { token: AGENT, body: '[1,2]' });
  assert.equal(array.status, 400);
  const big = await call('POST', '/note', { token: AGENT, body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }) });
  assert.equal(big.status, 400);
  const empty = await call('POST', '/hermes-heartbeat', { token: AGENT });
  assert.equal(empty.status, 200, 'an empty body is {}');
  assert.equal(empty.json.at, T0);
  const badType = await call('POST', '/note', { token: AGENT, body: { text: 5 } });
  assert.equal(badType.status, 400);
});

test('unknown paths and wrong methods are 404 NOT_FOUND', async () => {
  const { call } = await up();
  for (const [method, path] of [['GET', '/nope'], ['POST', '/status'], ['GET', '/propose'], ['DELETE', '/status'], ['GET', '/healthz/x']]) {
    const res = await call(method, path, { token: AGENT, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.json?.error?.code, 'NOT_FOUND', `${method} ${path}: ${res.text}`);
    assert.match(res.json.error.message, /no route/);
  }
  assert.equal((await call('GET', '/status/', { token: AGENT })).status, 200, 'a trailing slash is tolerated');
  assert.equal(ROUTES.length, 23);
  assert.deepEqual(ROUTES.filter((r) => r[3].tokenKind === 'none').map((r) => r[1]), ['/healthz', '/metrics']);
});

/** Every key at any depth of a JSON value. */
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((entry) => keysOf(entry, out));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { out.add(key); keysOf(entry, out); }
  return out;
};

test('GET /policy serves the live document with its digest to the agent and ops tokens, never without one; the digest is the one /status quotes', async () => {
  const { ctx, call } = await up();
  const none = await call('GET', '/policy');
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, 'UNAUTHORIZED');
  const agent = await call('GET', '/policy', { token: AGENT });
  assert.equal(agent.status, 200, agent.text);
  assert.deepEqual(Object.keys(agent.json), ['version', 'sha256', 'policy']);
  assert.equal(agent.json.version, 1);
  assert.match(agent.json.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(agent.json.policy, JSON.parse(JSON.stringify(ctx.policy)), 'the document as loaded, whole');
  const ops = await call('GET', '/policy', { token: OPS });
  assert.equal(ops.status, 200);
  assert.deepEqual(ops.json, agent.json, 'ops is a superset of agent');
  const status = await call('GET', '/status', { token: AGENT });
  assert.equal(status.json.policy.version, 1);
  assert.equal(status.json.policy.sha256, agent.json.sha256, 'one digest for the one document');
  assert.deepEqual(Object.keys(status.json.policy), ['version', 'sha256', 'review'], 'status quotes the digest and the review thresholds, not the whole document');
  assert.deepEqual(status.json.policy.review, agent.json.policy.review, 'the thresholds in force are the served document\'s');
  const keys = keysOf(agent.json);
  for (const banned of ['walletPayload', 'tx', 'signed', 'transactions', 'secretKey', 'privateKey', 'mnemonic', 'keypair', 'rpcUrl', 'token']) {
    assert.ok(!keys.has(banned), `the policy body must not carry ${banned}`);
  }
  assert.equal(ctx.journal.records().filter((r) => r.kind !== 'refusal').length, 0, 'a read leaves no record');
  assert.deepEqual(refusals(ctx).map((r) => [r.verb, r.code]), [['policy', 'UNAUTHORIZED']], 'the unauthenticated call is the only line');
  assert.equal(status.json.ledger.lastDepositAt, null);
  assert.equal(status.json.ledger.topUpBudgetSpent, false);
});

test('/healthz is unauthenticated: 503 before any tick or when the tick is stale, 200 when fresh', async () => {
  const { ctx, call } = await up();
  const cold = await call('GET', '/healthz');
  assert.equal(cold.status, 503);
  assert.equal(cold.json.lastTickAgeSecs, null);
  ctx.state.lastTick = { at: T0 - 10, ok: true, error: null };
  const fresh = await call('GET', '/healthz');
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.json, { ok: true, at: T0, lastTickAgeSecs: 10 });
  ctx.state.lastTick = { at: T0 - 91, ok: true, error: null };
  const stale = await call('GET', '/healthz');
  assert.equal(stale.status, 503);
  assert.equal(stale.json.ok, false);
});

test('/metrics is unauthenticated text with the seven plan gauges from the live state', async () => {
  const { ctx, call } = await up();
  ctx.state.lastSnapshot = fakeSnapshot({ lamports: 42 });
  ctx.state.lastTick = { at: T0 - 1, ok: true, error: null };
  ctx.state.hermesHeartbeatAt = T0 - 2;
  ctx.state.paused = true;
  const res = await call('GET', '/metrics');
  assert.equal(res.status, 200);
  assert.ok(res.type.startsWith('text/plain'));
  for (const name of ['curator_last_tick_ts', 'curator_hermes_heartbeat_ts', 'curator_pending_effective_at', 'curator_apply_state', 'curator_book_price_fresh', 'curator_signer_lamports', 'curator_self_locked']) {
    assert.ok(res.text.includes(name), name);
  }
  assert.ok(res.text.includes('curator_paused 1'));
  assert.ok(res.text.includes('curator_signer_lamports 42'));
  assert.ok(res.text.includes(`curator_last_tick_ts ${T0 - 1}`));
  assert.ok(ctx.trace.includes('renderPrometheus'));
});

test('a verb refusal is answered with its REFUSAL_STATUS and journaled once; a blocked apply carries the blocker status', async () => {
  const { ctx, call } = await up({ depsOverrides: {
    evaluateProposal: () => ({ ok: false, code: 'PROPOSAL_QUOTA', message: '2 proposals in 30 d', refusals: [{ code: 'PROPOSAL_QUOTA', message: 'x' }], summary: {} }),
    applyGates: () => ({ ok: false, blockers: [{ code: 'BOOK_NOT_FRESH', action: 'wait', message: 'stale' }] }),
  } });
  const quota = await call('POST', '/propose', { token: AGENT, body: { targets: NEW_TARGETS, why: 'x' }, headers: { 'x-curator-session': 'chat' } });
  assert.equal(quota.status, 429);
  assert.equal(quota.json.error.code, 'PROPOSAL_QUOTA');
  assert.equal(quota.json.error.detail.refusals.length, 1);
  assert.equal(refusals(ctx).filter((r) => r.code === 'PROPOSAL_QUOTA').length, 1);
  const bad = await call('POST', '/simulate', { token: AGENT, body: { targets: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'BAD_REQUEST');
  const blocked = await call('POST', '/apply', { token: AGENT, body: {} });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.json.ok, false);
  assert.equal(blocked.json.blockers[0].code, 'BOOK_NOT_FRESH');
  assert.equal(blocked.json.httpStatus, undefined);
});

test('a crash inside a verb is 500 INTERNAL with the URL scrubbed, never a stack or a body', async () => {
  const { ctx, call } = await up();
  ctx.journal.tail = () => { throw new Error('disk gone at https://pvc.internal/journal'); };
  const res = await call('GET', '/journal?n=5', { token: AGENT });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'INTERNAL');
  assert.ok(res.json.error.message.includes('<url>') && !res.json.error.message.includes('pvc.internal'));
  assert.equal(ctx.logs.at(-1).event, 'verb-crashed');
});

test('GET /journal takes n from the query, and GET /alerts, /review, /status answer compact JSON', async () => {
  const { ctx, call } = await up();
  await call('POST', '/note', { token: AGENT, body: { text: 'a' } });
  await call('POST', '/note', { token: AGENT, body: { text: 'b' } });
  const one = await call('GET', '/journal?n=1', { token: AGENT });
  assert.equal(one.json.records.length, 1);
  assert.equal(one.json.records[0].text, 'b');
  assert.equal((await call('GET', '/journal?n=x', { token: AGENT })).status, 400);
  const status = await call('GET', '/status', { token: AGENT });
  assert.equal(status.json.ok, true);
  assert.equal(status.json.signer.wallet, ctx.signer.wallet);
  const review = await call('GET', '/review', { token: AGENT });
  assert.deepEqual(Object.keys(review.json), ['brief', 'triggers', 'wakeAgent', 'holdReason']);
  const alerts = await call('GET', '/alerts', { token: AGENT });
  assert.deepEqual(alerts.json, { since: null, alerts: [] });
  assert.equal(status.text.split('\n').length, 1, 'compact');
});

test('scrubResponse drops tx, signed, walletPayload and transaction lists at any depth, keeps counts', () => {
  const out = scrubResponse({ ok: true, tx: 'AAA', signed: ['x'], walletPayload: { tx: 'y' }, transactions: [{ tx: 'z' }], summary: { transactions: 2, nested: { tx: 'q', steps: ['a'] } }, httpStatus: 409 });
  assert.deepEqual(out, { ok: true, summary: { transactions: 2, nested: { steps: ['a'] } } });
});

test('readBody rejects over the byte cap with BAD_REQUEST', async () => {
  const req = new EventEmitter();
  let drained = false;
  req.resume = () => { drained = true; };
  const promise = readBody(req, { maxBytes: 10 });
  req.emit('data', Buffer.from('{"a":"0123456789"}'));
  await assert.rejects(promise, (error) => error.code === 'BAD_REQUEST');
  assert.equal(drained, true, 'the rest of the body is drained, not destroyed');
});
