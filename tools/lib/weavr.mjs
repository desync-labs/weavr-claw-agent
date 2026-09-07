/**
 * The weavr side of the wallet tool: MCP calls, the REST rebuild, and the
 * three flows an agent needs (finish a create, make a deposit, sign a payload).
 * A `signer` is `{ wallet, sign(encodedList) -> Promise<string[]> }`; the
 * checks run here, before any signer sees a transaction.
 */
import { readFileSync } from 'node:fs';
import { checkAll } from './tx-checks.mjs';

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

/** Sign a list of encoded transactions after the checks. */
export async function signChecked(encodedList, signer, allowed) {
  const check = checkAll(encodedList, { wallet: signer.wallet, allowed });
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
  let last;
  for (let i = 0; i < awaitRounds; i += 1) {
    const args = i === 0 ? { deploymentId, signed: signedResult.signed, timeoutSecs } : { deploymentId, timeoutSecs };
    last = await client.mcpCall('await_portfolio', args);
    const st = last.payload?.status;
    if (last.isError || st === 'live' || st === 'sign_again') break;
  }
  return { ok: !last.isError, exit: last.isError ? 7 : 0, output: { step: 'await_portfolio', ...scrub(last.payload) } };
}

/** Build, sign and send a deposit. */
export async function makeDeposit(client, portfolio, amountUsd, signer, allowed) {
  const built = await client.mcpCall('build_deposit', { portfolio, user: signer.wallet, amountUsd });
  if (built.isError) return { ok: false, exit: 7, output: { step: 'build_deposit', ...scrub(built.payload) } };
  const txs = built.payload.walletPayload?.transactions ?? [];
  if (!txs.length) return { ok: false, exit: 7, output: { step: 'build_deposit', ...scrub(built.payload) } };
  const signedResult = await signChecked(txs, signer, allowed);
  if (!signedResult.ok) return signedResult;
  const sent = await client.mcpCall('send_signed', { signed: signedResult.signed });
  return { ok: !sent.isError, exit: sent.isError ? 7 : 0, output: { step: 'send_signed', portfolio, amountUsd, ...scrub(sent.payload) } };
}

/** Read the transactions out of a saved walletPayload (or a bare list). */
export function transactionsFromFile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const list = json.walletPayload?.transactions ?? json.transactions ?? (Array.isArray(json) ? json : null);
  if (!Array.isArray(list) || !list.length) throw new Error(`${path}: no transactions found`);
  return list;
}
