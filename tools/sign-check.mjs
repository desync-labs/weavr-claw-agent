#!/usr/bin/env node
/**
 * sign-check.mjs: prove the agent wallet can sign, at no cost, before a demo.
 *
 * Signs one memo transaction with the configured wallet and throws it away.
 * Nothing is sent: the transaction's hash is valid in shape only. The wallet
 * is picked exactly as sign.mjs picks it (`--wallet paybox|local|link`, else
 * WEAVR_WALLET, else inference: local when SIGN_LOCAL_KEYPAIR_FILE is set,
 * paybox when any PAYBOX_* variable is set, link when nothing is) and
 * the same environment applies. Prints one JSON line:
 *
 *   {"status":"ok","address":"...","sent":false,"signer":"paybox","clientId":"...","wallet":"paybox"}   exit 0
 *   {"status":"ok","address":"...","sent":false,"signer":"local","clientId":null,"wallet":"local"}      exit 0
 *   {"status":"failed","error":"NO_WALLET","detail":"this host has no signing wallet: ...","wallet":"link"}  exit 9
 *   {"status":"failed","error":"WALLET_DECLINED","detail":"... revoked ...",...}                        exit 3
 *   {"status":"failed","error":"CONFIG",...}                                                            exit 5
 *
 * `clientId` is the PayBox client the CLI is logged in as, the id a new
 * signing key is minted for when PayBox answers "agent signer has been
 * revoked". `--recent` uses a live recent hash from SOLANA_RPC_URL (public
 * mainnet RPC by default) in case PayBox refuses the placeholder.
 */
import { runSignCheck } from './lib/sign-check.mjs';
import { signerFor } from './lib/cli.mjs';

async function fetchRecentHash() {
  const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
  });
  return (await res.json()).result.value.blockhash;
}

runSignCheck(process.argv.slice(2), signerFor, process.env, { fetchRecentHash });
