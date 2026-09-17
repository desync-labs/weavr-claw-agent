/**
 * The weavr REST calls the commands make: resolve a portfolio (by mint or by
 * ticker), list the catalogue, build the two curator handover transactions
 * and send what was signed. Every call has a timeout; a network failure is
 * reported by class. The api answers `{ error: { code, message } }` on a
 * refusal, which `ApiError` carries.
 */
import { failureClass } from './chain.mjs';

export const DEFAULT_API = 'https://api.weavr.sh';
export const DEFAULT_MCP = 'https://api.weavr.sh/mcp';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}${message ? `: ${message}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = message;
  }
}

export function apiClient({ apiUrl = DEFAULT_API, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const base = String(apiUrl).replace(/\/$/, '');
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`weavr api ${method} ${path}: ${failureClass(e)}`);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, json };
  }
  return {
    base,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  };
}

const refuse = (r) => new ApiError(r.status, r.json?.error?.code ?? 'HTTP', r.json?.error?.message ?? r.json?.raw ?? '');

/**
 * The portfolio row for a mint or a ticker: GET /v1/portfolios/<id> first,
 * then the list matched on the symbol (case-insensitive) or the mint, and the
 * single-row read again for the matched mint so the row carries holdings.
 * Returns null when nothing matches.
 */
export async function resolvePortfolio(api, id) {
  const direct = await api.get(`/v1/portfolios/${encodeURIComponent(id)}`);
  if (direct.status >= 200 && direct.status < 300 && direct.json?.mint) return direct.json;
  if (direct.status !== 404 && direct.status >= 500) throw refuse(direct);
  const list = await api.get('/v1/portfolios');
  if (list.status < 200 || list.status >= 300) throw refuse(list);
  const rows = Array.isArray(list.json) ? list.json : list.json?.portfolios ?? [];
  const wanted = String(id).toLowerCase();
  const match = rows.find((r) => r.mint === id || String(r.symbol ?? '').toLowerCase() === wanted);
  if (!match) return null;
  if (match.holdings) return match;
  const full = await api.get(`/v1/portfolios/${encodeURIComponent(match.mint)}`);
  return full.status >= 200 && full.status < 300 && full.json?.mint ? full.json : match;
}

/** The catalogue rows. */
export async function listPools(api) {
  const r = await api.get('/v1/pools');
  if (r.status < 200 || r.status >= 300) throw refuse(r);
  return Array.isArray(r.json) ? r.json : r.json?.pools ?? [];
}

/**
 * The legs of a row as the policy sees them: one per target, with the
 * catalogue row (when the pool is in the catalogue), its symbol and its
 * target weight. Symbol from the catalogue, else from holdings, else the
 * part of the poolId before '@'.
 */
export function legsOf(row, pools = []) {
  const byId = new Map(pools.map((p) => [p.poolId, p]));
  const held = new Map((row?.holdings?.legs ?? []).map((l) => [l.poolId, l]));
  const targets = Array.isArray(row?.targets) && row.targets.length
    ? row.targets
    : (row?.holdings?.legs ?? []).map((l) => ({ poolId: l.poolId, weightBps: l.targetWeightBps }));
  return targets.map((t) => {
    const pool = byId.get(t.poolId) ?? null;
    const symbol = pool?.symbol ?? held.get(t.poolId)?.symbol ?? String(t.poolId).split('@')[0];
    // A missing weight stays NaN (Number(null) would read as 0 and pass for a real weight).
    const weightBps = t.weightBps === null || t.weightBps === undefined || t.weightBps === '' ? NaN : Number(t.weightBps);
    return { poolId: t.poolId, symbol, weightBps, pool };
  });
}

const pct = (bps) => {
  const n = Number(bps) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

/** 'pSOL 60 / pCBBTC 40'. */
export const legsText = (legs) => legs.map((l) => `${l.symbol} ${pct(l.weightBps)}`).join(' / ');

const built = (r) => {
  if (r.status < 200 || r.status >= 300) throw refuse(r);
  const txs = r.json?.transactions ?? [];
  if (!txs.length) throw new ApiError(r.status, 'NO_TRANSACTIONS', 'the api built nothing to sign');
  return txs;
};

/** POST /v1/portfolios/<mint>/curator { signer, newCurator } -> the transactions to sign. */
export async function buildTransferCurator(api, mint, signer, newCurator) {
  return built(await api.post(`/v1/portfolios/${encodeURIComponent(mint)}/curator`, { signer, newCurator }));
}

/** POST /v1/portfolios/<mint>/curator/accept { signer } -> the transactions to sign. */
export async function buildAcceptCurator(api, mint, signer) {
  return built(await api.post(`/v1/portfolios/${encodeURIComponent(mint)}/curator/accept`, { signer }));
}

/** POST /v1/transactions/send { signed } -> { status, signatures }. */
export async function sendSigned(api, signed) {
  const r = await api.post('/v1/transactions/send', { signed });
  if (r.status < 200 || r.status >= 300) throw refuse(r);
  return { status: r.json?.status ?? 'unknown', signatures: r.json?.signatures ?? [] };
}
