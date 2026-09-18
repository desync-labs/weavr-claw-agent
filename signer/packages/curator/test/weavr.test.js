/**
 * The REST client against a fake api: every route hits its path with its
 * body, every failure class becomes the right Refusal, and no message ever
 * carries a URL, a body or a transaction. Nothing here touches the network.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { weavrClient, DEFAULT_TIMEOUT_MS, MAX_SIGNED_PER_SEND } from '../src/weavr.js';
import { Refusal } from '../src/errors.js';

const API = 'http://composable-portfolios-backend-api:8080';
const MINT = 'So11111111111111111111111111111111111111112';
const TX = Buffer.alloc(240, 0x42).toString('base64');
const BUILT = { deploymentId: 'dep-1', recentBlockhashExpiresAtHeight: 100, transactions: [{ step: 'propose', signer: 'curator', signerKey: 'k', tx: TX }] };

/** A fake fetch: `routes` maps `METHOD path` to a `{ status, body }` or a function of (url, init). Records every call. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const path = url.slice(API.length);
    const key = `${init.method ?? 'GET'} ${path}`;
    const route = routes[key] ?? routes['*'];
    if (!route) return { status: 404, text: async () => JSON.stringify({ error: { code: 'NOT_FOUND', message: `${key} not found` } }) };
    const result = typeof route === 'function' ? await route(url, init) : route;
    if (result instanceof Error) throw result;
    return {
      status: result.status ?? 200,
      text: async () => (typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {})),
    };
  };
  impl.calls = calls;
  return impl;
}

const expectRefusal = async (promise, code, check = () => {}) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code, `code ${error.code} (${error.message})`);
    check(error);
    return true;
  });
};

let consoleCalls;
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
const originalConsole = {};
beforeEach(() => {
  consoleCalls = 0;
  for (const method of consoleMethods) {
    originalConsole[method] = console[method];
    console[method] = () => { consoleCalls += 1; };
  }
});
afterEach(() => {
  for (const method of consoleMethods) console[method] = originalConsole[method];
});

describe('weavrClient construction', () => {
  it('refuses a missing or non-http api url and a missing fetch', () => {
    assert.throws(() => weavrClient({}), (e) => e instanceof Refusal && e.code === 'CONFIG');
    assert.throws(() => weavrClient({ apiUrl: 'api:8080' }), (e) => e.code === 'CONFIG');
    assert.throws(() => weavrClient({ apiUrl: API, fetchImpl: null }), (e) => e.code === 'CONFIG');
  });

  it('is frozen, has the documented surface and a 20 s default timeout', () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({}) });
    assert.ok(Object.isFrozen(client));
    for (const name of ['request', 'get', 'post', 'portfolio', 'pools', 'health', 'buildPropose', 'buildApply', 'buildCancel', 'buildRefreshNav', 'buildDeposit', 'buildWithdraw', 'buildProposeCurator', 'buildRebalanceDelay', 'buildMetadata', 'simulateRebalance', 'send']) {
      assert.equal(typeof client[name], 'function', name);
    }
    assert.equal(DEFAULT_TIMEOUT_MS, 20000);
    assert.equal(MAX_SIGNED_PER_SEND, 16);
  });
});

describe('get / post mechanics', () => {
  it('GET sends accept only, no body; a trailing slash on apiUrl is trimmed; the mint is URL-encoded', async () => {
    const fetchImpl = fakeFetch({
      [`GET /v1/portfolios/${MINT}`]: { body: { mint: MINT, state: 'live' } },
      'GET /v1/portfolios/a%20b%2Fc': { body: { mint: 'a b/c' } },
    });
    const client = weavrClient({ apiUrl: `${API}/`, fetchImpl });
    const row = await client.portfolio(MINT);
    assert.equal(row.state, 'live');
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, `${API}/v1/portfolios/${MINT}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.accept, 'application/json');
    assert.equal(init.headers['content-type'], undefined);
    assert.equal(init.headers['x-weavr-key'], undefined);
    assert.ok(init.signal instanceof AbortSignal);
    await client.portfolio('a b/c');
    assert.equal(fetchImpl.calls[1].url, `${API}/v1/portfolios/a%20b%2Fc`);
  });

  it('POST sends JSON with content-type and the partner key header when configured', async () => {
    const fetchImpl = fakeFetch({ [`POST /v1/portfolios/${MINT}/rebalance`]: { body: BUILT } });
    const client = weavrClient({ apiUrl: API, fetchImpl, partnerKey: 'pk-1' });
    const body = { curator: 'CUR', targets: [{ poolId: 'pSOL', weightBps: 10000 }] };
    const built = await client.buildPropose(MINT, body);
    assert.deepEqual(built, BUILT);
    const [{ init }] = fetchImpl.calls;
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.headers['x-weavr-key'], 'pk-1');
    assert.deepEqual(JSON.parse(init.body), body);
  });

  it('request() returns the raw pair without throwing on an HTTP status', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ 'GET /x': { status: 418, body: { error: { code: 'TEAPOT', message: 'short and stout' } } } }) });
    assert.deepEqual(await client.request('GET', '/x'), { status: 418, json: { error: { code: 'TEAPOT', message: 'short and stout' } } });
    await expectRefusal(client.request('GET', 'x'), 'BAD_REQUEST');
  });

  it('post refuses a non-object body before calling fetch, and mint-less helpers refuse', async () => {
    const fetchImpl = fakeFetch({});
    const client = weavrClient({ apiUrl: API, fetchImpl });
    await expectRefusal(client.post('/v1/x', 'nope'), 'BAD_REQUEST');
    await expectRefusal(client.buildApply('', { caller: 'c' }), 'BAD_REQUEST');
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('failure classes', () => {
  it('api 400 on a build → BUILD_REFUSED (502) with the api code and message in detail, never the request body', async () => {
    const fetchImpl = fakeFetch({ [`POST /v1/portfolios/${MINT}/rebalance`]: { status: 400, body: { error: { code: 'RebalanceTooSoon', message: 'wait 3 days' } } } });
    const client = weavrClient({ apiUrl: API, fetchImpl });
    await expectRefusal(client.buildPropose(MINT, { curator: 'CURATOR_PUBKEY_MARKER', targets: [] }), 'BUILD_REFUSED', (error) => {
      assert.equal(error.status, 502);
      assert.deepEqual(error.detail, { path: `/v1/portfolios/${MINT}/rebalance`, status: 400, code: 'RebalanceTooSoon', message: 'wait 3 days' });
      assert.match(error.message, /wait 3 days/);
      assert.ok(!JSON.stringify({ m: error.message, d: error.detail }).includes('CURATOR_PUBKEY_MARKER'));
      assert.ok(!error.message.includes(API), 'no URL in the message');
    });
    assert.equal(consoleCalls, 0, 'nothing logged');
  });

  it('api 404 on a read → UPSTREAM with detail.status 404', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({}) });
    await expectRefusal(client.portfolio(MINT), 'UPSTREAM', (error) => {
      assert.equal(error.detail.status, 404);
      assert.equal(error.detail.code, 'NOT_FOUND');
    });
  });

  it('api 500, and a 503 HTML page from an ingress → UPSTREAM', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({
      'GET /health': { status: 500, body: { error: { code: 'BOOM', message: 'db down' } } },
      'GET /v1/pools': { status: 503, body: '<html>Service Unavailable</html>' },
    }) });
    await expectRefusal(client.health(), 'UPSTREAM', (error) => {
      assert.equal(error.status, 502);
      assert.deepEqual(error.detail, { path: '/health', status: 500, code: 'BOOM', message: 'db down' });
    });
    await expectRefusal(client.pools(), 'UPSTREAM', (error) => {
      assert.equal(error.detail.status, 503);
      assert.equal(error.detail.code, 'HTTP_503');
      assert.ok(!error.message.includes('<html>'));
    });
    assert.equal(consoleCalls, 0);
  });

  it('a 200 that is not a JSON object → UPSTREAM; pools without a list → UPSTREAM', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({
      'GET /health': { body: 'OK' },
      'GET /v1/pools': { body: { nope: true } },
      [`GET /v1/portfolios/${MINT}`]: { body: '' },
    }) });
    await expectRefusal(client.health(), 'UPSTREAM');
    await expectRefusal(client.pools(), 'UPSTREAM');
    await expectRefusal(client.portfolio(MINT), 'UPSTREAM');
  });

  it('a network error → UPSTREAM naming the code but never the address', async () => {
    const failure = new TypeError('fetch failed');
    failure.cause = Object.assign(new Error(`connect ECONNREFUSED ${API}`), { code: 'ECONNREFUSED' });
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ '*': () => failure }) });
    await expectRefusal(client.health(), 'UPSTREAM', (error) => {
      assert.match(error.message, /ECONNREFUSED/);
      assert.ok(!error.message.includes('composable-portfolios-backend-api'));
      assert.ok(!JSON.stringify(error.detail).includes('composable-portfolios-backend-api'));
    });
  });

  it('a stalled api → UPSTREAM "timed out" via the AbortSignal, within the timeout', async () => {
    const fetchImpl = fakeFetch({ '*': (_url, init) => new Promise((_resolve, reject) => {
      // A real stalled request holds an open socket, which holds the loop; this
      // fake holds nothing, and the client's own timeout timer is unref'd on
      // purpose (src/weavr.js). Without something referenced here, node 20 ends
      // the loop before the 20 ms abort and cancels the rest of the file.
      const socket = setTimeout(() => {}, 1000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(socket);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }) });
    const client = weavrClient({ apiUrl: API, fetchImpl, timeoutMs: 20 });
    const started = Date.now();
    await expectRefusal(client.health(), 'UPSTREAM', (error) => {
      assert.match(error.message, /timed out after 20 ms/);
      assert.equal(error.detail.timeoutMs, 20);
    });
    assert.ok(Date.now() - started < 2000);
    assert.ok(fetchImpl.calls[0].init.signal.aborted, 'the signal was aborted so the socket is released');
  });
});

describe('typed routes', () => {
  const cases = [
    ['buildApply', '/rebalance/apply', { caller: 'C' }],
    ['buildCancel', '/rebalance/cancel', { signer: 'S' }],
    ['buildRefreshNav', '/refresh-nav', { payer: 'P' }],
    ['buildDeposit', '/deposit', { user: 'U', amount: '1000000', minShares: '0' }],
    ['buildWithdraw', '/withdraw', { user: 'U', shares: '5', minAmountOut: '0' }],
    ['buildProposeCurator', '/curator', { signer: 'S', newCurator: 'N' }],
    ['buildRebalanceDelay', '/rebalance-delay', { curator: 'C', rebalanceDelaySecs: 86400 }],
    ['buildMetadata', '/metadata', { signer: 'S', uri: 'https://www.weavr.sh/metadata/WEAVR.json' }],
    ['simulateRebalance', '/rebalance/simulate', { targets: [{ poolId: 'pSOL', weightBps: 10000 }] }],
  ];
  for (const [name, suffix, body] of cases) {
    it(`${name} posts to /v1/portfolios/:mint${suffix} with the body as given`, async () => {
      const fetchImpl = fakeFetch({ [`POST /v1/portfolios/${MINT}${suffix}`]: { body: BUILT } });
      const client = weavrClient({ apiUrl: API, fetchImpl });
      assert.deepEqual(await client[name](MINT, body), BUILT);
      assert.equal(fetchImpl.calls.length, 1);
      assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), body);
    });
  }

  it('pools() unwraps the list; health() returns the json', async () => {
    const pools = [{ poolId: 'pSOL', symbol: 'pSOL', chain: 'solana', status: 'active' }];
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ 'GET /v1/pools': { body: { pools } }, 'GET /health': { body: { ok: true, slot: 1 } } }) });
    assert.deepEqual(await client.pools(), pools);
    assert.deepEqual(await client.health(), { ok: true, slot: 1 });
  });
});

describe('send', () => {
  it('posts { signed } and normalises a confirmed answer', async () => {
    const fetchImpl = fakeFetch({ 'POST /v1/transactions/send': { body: { status: 'confirmed', signatures: ['sig1', 'sig2'] } } });
    const client = weavrClient({ apiUrl: API, fetchImpl });
    const result = await client.send([TX, TX]);
    assert.deepEqual(result, { ok: true, status: 'confirmed', signatures: ['sig1', 'sig2'], error: null });
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { signed: [TX, TX] });
    assert.equal(fetchImpl.calls[0].url, `${API}/v1/transactions/send`);
  });

  it('a 200 "expired" is ok:false with a SEND_EXPIRED error, not a throw', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ 'POST /v1/transactions/send': { body: { status: 'expired', signatures: ['sig1'] } } }) });
    const result = await client.send([TX]);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'expired');
    assert.deepEqual(result.signatures, ['sig1']);
    assert.equal(result.error.code, 'SEND_EXPIRED');
    assert.ok(!JSON.stringify(result).includes(TX));
  });

  it('a 400 (SEND_REFUSED / SEND_FAILED / TOO_MANY) → Refusal SEND_FAILED with the api code in detail and no bytes anywhere', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ 'POST /v1/transactions/send': { status: 400, body: { error: { code: 'SEND_REFUSED', message: 'signed[0] was refused: instruction targets X, which is not a weavr or core program' } } } }) });
    await expectRefusal(client.send([TX]), 'SEND_FAILED', (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.detail.code, 'SEND_REFUSED');
      assert.match(error.detail.message, /not a weavr or core program/);
      assert.ok(!JSON.stringify({ m: error.message, d: error.detail }).includes(TX));
    });
    assert.equal(consoleCalls, 0);
  });

  it('a 500 on send → UPSTREAM', async () => {
    const client = weavrClient({ apiUrl: API, fetchImpl: fakeFetch({ 'POST /v1/transactions/send': { status: 502, body: 'bad gateway' } }) });
    await expectRefusal(client.send([TX]), 'UPSTREAM');
  });

  it('refuses an empty list, a non-string entry and more than 16 without calling the api', async () => {
    const fetchImpl = fakeFetch({ 'POST /v1/transactions/send': { body: { status: 'confirmed', signatures: [] } } });
    const client = weavrClient({ apiUrl: API, fetchImpl });
    await expectRefusal(client.send([]), 'SEND_FAILED');
    await expectRefusal(client.send([TX, 42]), 'SEND_FAILED');
    await expectRefusal(client.send(['']), 'SEND_FAILED');
    await expectRefusal(client.send(Array.from({ length: 17 }, () => TX)), 'SEND_FAILED');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal((await client.send(TX)).ok, true, 'a single string is wrapped');
  });
});
