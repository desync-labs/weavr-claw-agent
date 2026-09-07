#!/usr/bin/env node
/**
 * sign-check.mjs — prove the agent wallet can sign, at no cost, before a demo.
 *
 * Signs one memo transaction through the PayBox CLI and throws it away.
 * Nothing is sent: the transaction's hash is valid in shape only. Same
 * environment as sign-solana.mjs (PAYBOX_CONFIG_DIR, PAYBOX_CREDENTIAL_ID,
 * PAYBOX_CLI, the key file). Prints one JSON line:
 *
 *   {"status":"ok","address":"…","sent":false,"signer":"paybox","clientId":"…"}   exit 0
 *   {"status":"failed","error":"WALLET_DECLINED","detail":"… revoked …",…}       exit 3
 *   {"status":"failed","error":"CONFIG",…}                                        exit 5
 *
 * `clientId` is the PayBox client the CLI is logged in as — the id a new
 * signing key is minted for when PayBox answers "agent signer has been
 * revoked". `--recent` uses a live recent hash from SOLANA_RPC_URL (public
 * mainnet RPC by default) in case PayBox refuses the placeholder.
 */
import { runSignCheck } from './lib/sign-check.mjs';
import { payboxSigner } from './lib/paybox-signer.mjs';

async function fetchRecentHash() {
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
  });
  return (await res.json()).result.value.blockhash;
}

runSignCheck(process.argv.slice(2), () => payboxSigner(), process.env, { fetchRecentHash });
