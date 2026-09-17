/**
 * The weavr side of the wallet tool: MCP calls, the REST rebuild, and the
 * three flows an agent needs (finish a create, make a deposit, sign a payload).
 * A `signer` is `{ wallet, sign(encodedList) -> Promise<string[]> }`; the
 * checks run here, before any signer sees a transaction.
 */
import { readFileSync } from 'node:fs';
import { checkAll, EXIT } from './tx-checks.mjs';
import { readShareBalance } from './balance.mjs';
import { assertPartialExit, parseSpokenShares, sizeUsdWithdraw } from './shares.mjs';

export const DEFAULT_MCP = 'https://api.weavr.sh/mcp';
export const DEFAULT_API = 'https://api.weavr.sh';

export function weavrClient({ mcpUrl = DEFAULT_MCP, apiUrl = DEFAULT_API, fetchImpl = fetch, headers = {} } = {}) {
  async function mcpCall(name, argumentsObj) {
    const res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argumentsObj } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`weavr ${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
    const r = body.result;
    const payload = r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? '{}');
    return { isError: Boolean(r.isError), payload };
  }
  async function rest(method, path, body) {
    const res = await fetchImpl(apiUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, json };
  }
  return { mcpCall, rest };
}

/** Strip the one field that must never reach a transcript. */
export const scrub = (p) => { const { walletPayload, ...rest } = p ?? {}; return rest; };

function refusal(check) {
  return { ok: false, exit: check.exit, output: { error: check.error, detail: check.detail } };
}

/**
 * Sign a list of encoded transactions after the checks. A signer that signs
 * v0 says so with `allowVersioned: true` (the local key); any other signer
 * gets legacy transactions only, so PayBox never sees a v0 payload.
 */
export async function signChecked(encodedList, signer, allowed) {
  const check = checkAll(encodedList, { wallet: signer.wallet, allowed, allowVersioned: signer.allowVersioned === true });
  if (!check.ok) return refusal(check);
  const signed = await signer.sign(encodedList);
  return { ok: true, signed };
}

/** Sign what `create_portfolio` handed back and wait until the portfolio is live. */
export async function finishDeployment(client, deploymentId, signer, allowed, { awaitRounds = 6, timeoutSecs = 50 } = {}) {
  const rebuilt = await client.rest('POST', `/v1/deployments/${deploymentId}/rebuild`, {});
  if (rebuilt.status >= 400) return { ok: false, exit: 7, output: { step: 'rebuild', status: rebuilt.status, ...scrub(rebuilt.json) } };
  const record = rebuilt.json.deployment ?? rebuilt.json;
  const steps = (record.transactions ?? []).filter((s) => s.signer === 'creator' && s.tx);
  if (!steps.length) {
    return { ok: false, exit: 7, output: { step: 'rebuild', detail: 'no creator step to sign (already signed?)', status: record.status, waitingOn: record.waitingOn } };
  }
  const signedResult = await signChecked(steps.map((s) => s.tx), signer, allowed);
  if (!signedResult.ok) return signedResult;
  const last = await watchDeployment(client, deploymentId, { signed: signedResult.signed, awaitRounds, timeoutSecs });
  return { ok: !last.isError, exit: last.isError ? 7 : 0, output: { step: 'await_portfolio', ...scrub(last.payload) } };
}

/** Statuses await_portfolio cannot move past on its own; polling stops there. */
export const SETTLED_STATUSES = Object.freeze(['live', 'sign_again', 'expired']);

/**
 * Poll await_portfolio until the deployment settles or the rounds run out.
 * `signed` rides along on the first round only; without it (the sign link:
 * the owner signs in a browser) the poll carries the deploymentId alone and
 * awaiting_wallet, finishing, live and expired pass through as weavr reports
 * them. Returns the last MCP result, unscrubbed.
 */
export async function watchDeployment(client, deploymentId, { signed, awaitRounds = 6, timeoutSecs = 50 } = {}) {
  let last;
  for (let i = 0; i < awaitRounds; i += 1) {
    const args = i === 0 && signed ? { deploymentId, signed, timeoutSecs } : { deploymentId, timeoutSecs };
    last = await client.mcpCall('await_portfolio', args);
    if (last.isError || SETTLED_STATUSES.includes(last.payload?.status)) break;
  }
  return last;
}

/**
 * The one-signature user flows share a shape: a `build_*` tool answers a
 * walletPayload, the checks run, the signer signs, `send_signed` sends.
 * `report` is what the JSON line carries besides weavr's answer.
 */
async function buildSignSend(client, buildTool, buildArgs, signer, allowed, report) {
  const built = await client.mcpCall(buildTool, buildArgs);
  if (built.isError) return { ok: false, exit: 7, output: { step: buildTool, ...scrub(built.payload) } };
  const txs = built.payload.walletPayload?.transactions ?? [];
  if (!txs.length) return { ok: false, exit: 7, output: { step: buildTool, ...scrub(built.payload) } };
  const signedResult = await signChecked(txs, signer, allowed);
  if (!signedResult.ok) return signedResult;
  const sent = await client.mcpCall('send_signed', { signed: signedResult.signed });
  return { ok: !sent.isError, exit: sent.isError ? 7 : 0, output: { step: 'send_signed', ...report, ...scrub(sent.payload) } };
}

/** Build, sign and send a deposit. */
export function makeDeposit(client, portfolio, amountUsd, signer, allowed) {
  return buildSignSend(client, 'build_deposit', { portfolio, user: signer.wallet, amountUsd }, signer, allowed, { portfolio, amountUsd });
}

/**
 * Build, sign and send a withdrawal request. Prefer `amountUsd` (what the
 * user said in dollars). `shares` is "all" or a count for the rare case
 * they named shares. Either way we send the 6-decimal integer the program
 * expects, and we take the whole position when a dollar request would
 * leave dust.
 */
export async function makeWithdraw(client, portfolio, shares, signer, allowed, { minAmountOut, connection, amountUsd } = {}) {
  const held = (amountUsd != null || (shares != null && /^all$/i.test(String(shares).trim())) || connection)
    ? await resolveHeldShares(client, portfolio, signer.wallet, connection)
    : null;
  if (held && !held.ok && (amountUsd != null || (shares != null && /^all$/i.test(String(shares).trim())))) {
    return held;
  }

  let sharesBase;
  let report = { portfolio };
  if (amountUsd != null && String(amountUsd) !== '') {
    if (!held?.ok) return held ?? { ok: false, exit: EXIT.FAILED, output: { error: 'RPC_UNAVAILABLE', detail: 'a dollar withdrawal needs the portfolio price and the wallet\'s shares' } };
    const sized = sizeUsdWithdraw(amountUsd, { held: held.sharesBase, price: held.price });
    if (!sized.ok) return { ok: false, exit: EXIT.USAGE, output: { error: sized.error, detail: sized.detail, minUsd: sized.minUsd } };
    sharesBase = sized.sharesBase;
    report = { ...report, amountUsd: sized.amountUsd, fullExit: sized.fullExit, sharesBase };
  } else {
    let parsed;
    try { parsed = parseSpokenShares(shares); }
    catch (e) { return { ok: false, exit: EXIT.USAGE, output: { error: 'USAGE', detail: e.message } }; }
    if (parsed.kind === 'all') {
      if (!held?.ok) return held ?? { ok: false, exit: EXIT.FAILED, output: { error: 'RPC_UNAVAILABLE', detail: '--shares all needs the wallet\'s shares' } };
      sharesBase = held.sharesBase;
      report = { ...report, shares: 'all', sharesBase, fullExit: true };
    } else {
      sharesBase = parsed.sharesBase;
      if (held?.ok) {
        const gate = assertPartialExit(held.sharesBase, sharesBase);
        if (!gate.ok) return { ok: false, exit: EXIT.USAGE, output: { error: gate.error, detail: gate.detail } };
      }
      report = { ...report, shares: String(shares), sharesBase };
    }
  }

  const args = { portfolio, user: signer.wallet, shares: sharesBase };
  if (minAmountOut !== undefined) args.minAmountOut = String(minAmountOut);
  return buildSignSend(client, 'build_withdraw', args, signer, allowed, report);
}

async function resolveHeldShares(client, portfolio, wallet, connection) {
  let book;
  try {
    const r = await client.rest('GET', `/v1/portfolios/${encodeURIComponent(portfolio)}`);
    if (r.status >= 400 || r.json?.mint == null || r.json?.price == null) {
      return { ok: false, exit: EXIT.WEAVR_ERROR, output: { error: 'WEAVR_ERROR', detail: `could not read ${portfolio}`, status: r.status, ...scrub(r.json) } };
    }
    book = r.json;
  } catch (e) {
    return { ok: false, exit: EXIT.WEAVR_ERROR, output: { error: 'WEAVR_ERROR', detail: String(e.message).slice(0, 160) } };
  }
  if (!connection) {
    return { ok: false, exit: EXIT.FAILED, output: { error: 'RPC_UNAVAILABLE', detail: 'an RPC is needed to read the wallet\'s shares' } };
  }
  try {
    const held = await readShareBalance(wallet, book.mint, connection);
    if (held <= 0n) {
      return { ok: false, exit: EXIT.USAGE, output: { error: 'NO_SHARES', detail: 'this wallet holds nothing in that portfolio' } };
    }
    return { ok: true, sharesBase: String(held), price: String(book.price), mint: book.mint };
  } catch (e) {
    return { ok: false, exit: EXIT.FAILED, output: { error: 'RPC_UNAVAILABLE', detail: `could not read shares: ${String(e.message).slice(0, 160)}` } };
  }
}

/** Build, sign and send a valuation refresh: the user-side crank, paid by the wallet. */
export function makeRefreshNav(client, portfolio, signer, allowed) {
  return buildSignSend(client, 'build_refresh_nav', { portfolio, payer: signer.wallet }, signer, allowed, { portfolio });
}

/** Read the transactions out of a saved walletPayload (or a bare list). */
export function transactionsFromFile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const list = json.walletPayload?.transactions ?? json.transactions ?? (Array.isArray(json) ? json : null);
  if (!Array.isArray(list) || !list.length) throw new Error(`${path}: no transactions found`);
  return list;
}
