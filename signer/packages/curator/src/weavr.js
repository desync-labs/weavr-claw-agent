/**
 * The REST client for the api. Only the routes the curator needs, with
 * `fetchImpl` injectable so every verb test runs against a fake api that
 * returns captured payloads (the ops wallet tool does the same in
 * `integrations/claw-agent/tools/lib/weavr.mjs`). Bodies that carry a `tx`
 * are never logged; an api error becomes a Refusal with the api's
 * `{ code, message }` in `detail`.
 *
 * Why the client throws instead of returning `{ status, json }` like the ops
 * tool: every verb is "policy → build → decode → sign → send → journal", and
 * a build the api refused must stop that chain with a code the server can
 * map to a status (`BUILD_REFUSED` → 502) and the journal can record. A
 * caller that wants the raw pair uses `request()`; `get`/`post` are the
 * fail-closed layer on top.
 *
 * Why every message is URL-free: the api URL is an in-cluster service name
 * today, but the same client will be pointed at other hosts from a laptop,
 * and a fetch error message carries the address it tried. Only the method,
 * the path and an error `code`/`name` reach a Refusal.
 *
 * Why a timeout is an AbortSignal and not a race: a raced promise leaves the
 * request open; an aborted fetch releases the socket, which matters in a
 * 30 s loop that would otherwise pile up connections to a stalled api.
 */
import { Refusal } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_SIGNED_PER_SEND = 16; // the api's own cap on /v1/transactions/send

const encode = (value) => encodeURIComponent(String(value));

/**
 * @param {{ apiUrl: string, fetchImpl?: typeof fetch, partnerKey?: string | null, timeoutMs?: number }} opts
 *   `partnerKey` is sent as `x-weavr-key` (the api's partner header) when given.
 * @returns {{
 *   request: (method: string, path: string, body?: object) => Promise<{ status: number, json: object | null }>,
 *   get: (path: string) => Promise<object>,
 *   post: (path: string, body: object, opts?: { refusalCode?: string }) => Promise<object>,
 *   portfolio: (mint: string) => Promise<object>,
 *   pools: () => Promise<object[]>,
 *   health: () => Promise<object>,
 *   buildPropose: (mint: string, body: { curator: string, targets: Array<{ poolId: string, weightBps: number }> }) => Promise<object>,
 *   buildApply: (mint: string, body: { caller: string }) => Promise<object>,
 *   buildCancel: (mint: string, body: { signer: string }) => Promise<object>,
 *   buildRefreshNav: (mint: string, body: { payer: string }) => Promise<object>,
 *   buildDeposit: (mint: string, body: { user: string, amount: string, minShares: string }) => Promise<object>,
 *   buildWithdraw: (mint: string, body: { user: string, shares: string, minAmountOut: string }) => Promise<object>,
 *   buildProposeCurator: (mint: string, body: { signer: string, newCurator: string }) => Promise<object>,
 *   buildRebalanceDelay: (mint: string, body: { curator: string, rebalanceDelaySecs: number }) => Promise<object>,
 *   buildMetadata: (mint: string, body: { signer: string, uri: string }) => Promise<object>,
 *   simulateRebalance: (mint: string, body: { targets: Array<{ poolId: string, weightBps: number }> }) => Promise<object>,
 *   send: (signed: string[]) => Promise<{ ok: boolean, status: string, signatures: string[], error: { code: string, message: string } | null }>,
 * }}
 *   Build responses are `{ deploymentId?, recentBlockhashExpiresAtHeight, transactions: [{ step, signer, signerKey, tx, pageIndex? }] }`.
 *   Throws Refusal('BUILD_REFUSED') on HTTP 4xx `{ error: { code, message } }` from a build (`SEND_FAILED` from send, `UPSTREAM` from a read),
 *   Refusal('UPSTREAM') on ≥ 500, a non-JSON body, a timeout or a network error.
 */
export function weavrClient(opts = {}) {
  const { apiUrl, fetchImpl = globalThis.fetch, partnerKey = null, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (typeof apiUrl !== 'string' || !/^https?:\/\//.test(apiUrl)) throw new Refusal('CONFIG', 'CURATOR_API_URL must be an http(s) URL');
  if (typeof fetchImpl !== 'function') throw new Refusal('CONFIG', 'weavrClient needs a fetch implementation');
  const base = apiUrl.replace(/\/+$/, '');
  const baseHeaders = { accept: 'application/json' };
  if (partnerKey) baseHeaders['x-weavr-key'] = String(partnerKey);

  /**
   * One HTTP round trip. Never throws on an HTTP status; throws
   * Refusal('UPSTREAM') when the api cannot be reached, times out, or
   * answers with something that is not JSON.
   */
  async function request(method, path, body) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Refusal('BAD_REQUEST', 'api path must start with /');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: body === undefined ? baseHeaders : { ...baseHeaders, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new Refusal('UPSTREAM', `api ${method} ${path} timed out after ${timeoutMs} ms`, { path, timeoutMs });
      }
      const reason = error?.cause?.code ?? error?.code ?? error?.name ?? 'error';
      throw new Refusal('UPSTREAM', `api ${method} ${path} unreachable (${reason})`, { path, reason });
    } finally {
      clearTimeout(timer);
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      throw new Refusal('UPSTREAM', `api ${method} ${path}: body could not be read`, { path, status: response.status });
    }
    let json = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: Number(response.status), json };
  }

  /** The api's `{ error: { code, message } }`, or a placeholder when it sent none. */
  const apiError = (status, json) => {
    const error = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
    return {
      code: typeof error?.code === 'string' ? error.code : `HTTP_${status}`,
      message: typeof error?.message === 'string' ? error.message : `api answered ${status}`,
    };
  };

  /** Turn a status/json pair into the json or a Refusal with the given 4xx code. */
  function settle(method, path, { status, json }, refusalCode) {
    if (status >= 200 && status < 300) {
      if (!json || typeof json !== 'object') throw new Refusal('UPSTREAM', `api ${method} ${path} answered ${status} without a JSON object`, { path, status });
      return json;
    }
    const { code, message } = apiError(status, json);
    if (status >= 400 && status < 500) {
      throw new Refusal(refusalCode, `api ${method} ${path} refused: ${message}`, { path, status, code, message });
    }
    throw new Refusal('UPSTREAM', `api ${method} ${path} answered ${status}`, { path, status, code, message });
  }

  async function get(path) {
    return settle('GET', path, await request('GET', path), 'UPSTREAM');
  }

  async function post(path, body, { refusalCode = 'BUILD_REFUSED' } = {}) {
    if (!body || typeof body !== 'object') throw new Refusal('BAD_REQUEST', 'post body must be an object');
    return settle('POST', path, await request('POST', path, body), refusalCode);
  }

  const mintPath = (mint, suffix = '') => {
    if (typeof mint !== 'string' || mint.trim() === '') throw new Refusal('BAD_REQUEST', 'mint is required');
    return `/v1/portfolios/${encode(mint)}${suffix}`;
  };

  /**
   * `POST /v1/transactions/send { signed }`. A 2xx answer is normalised to
   * `{ ok, status, signatures, error }` where `ok` is `status === 'confirmed'`
   * (the api also answers 200 with `status: 'expired'`); a 4xx (SEND_REFUSED,
   * SEND_FAILED, TOO_MANY…) throws Refusal('SEND_FAILED') with the api's code
   * in `detail`. The signed bytes are never part of a message or a detail.
   */
  async function send(signed) {
    const list = Array.isArray(signed) ? signed : [signed];
    if (!list.length || !list.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
      throw new Refusal('SEND_FAILED', 'send expects a non-empty list of base64 signed transactions');
    }
    if (list.length > MAX_SIGNED_PER_SEND) throw new Refusal('SEND_FAILED', `send takes at most ${MAX_SIGNED_PER_SEND} transactions per call`);
    const json = await post('/v1/transactions/send', { signed: list }, { refusalCode: 'SEND_FAILED' });
    const status = typeof json.status === 'string' ? json.status : 'unknown';
    const signatures = Array.isArray(json.signatures) ? json.signatures.filter((entry) => typeof entry === 'string') : [];
    const ok = status === 'confirmed';
    return {
      ok,
      status,
      signatures,
      error: ok ? null : {
        code: `SEND_${status.toUpperCase()}`,
        message: typeof json.message === 'string' ? json.message : `the api reports the send as ${status}`,
      },
    };
  }

  // Every method is async so a refusal is always a rejection, never a
  // synchronous throw a caller's `.catch` would miss.
  const build = (suffix) => async (mint, body) => post(mintPath(mint, suffix), body);

  return Object.freeze({
    request,
    get,
    post,
    portfolio: async (mint) => get(mintPath(mint)),
    pools: async () => {
      const json = await get('/v1/pools');
      if (!Array.isArray(json.pools)) throw new Refusal('UPSTREAM', 'api GET /v1/pools answered without a pools list');
      return json.pools;
    },
    health: async () => get('/health'),
    buildPropose: build('/rebalance'),
    buildApply: build('/rebalance/apply'),
    buildCancel: build('/rebalance/cancel'),
    buildRefreshNav: build('/refresh-nav'),
    buildDeposit: build('/deposit'),
    buildWithdraw: build('/withdraw'),
    buildProposeCurator: build('/curator'),
    buildRebalanceDelay: build('/rebalance-delay'),
    buildMetadata: build('/metadata'),
    simulateRebalance: build('/rebalance/simulate'),
    send,
  });
}
