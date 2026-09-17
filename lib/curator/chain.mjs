/**
 * The two chain reads the commands make, over plain JSON-RPC: the signer's
 * SOL balance and the factory's guardian. `rpc(method, params)` returns the
 * JSON-RPC `result`; the real one is `jsonRpc(url, fetchImpl)`, the tests
 * hand in a table. The FactoryConfig layout is checked by discriminator
 * before any offset is trusted: a mismatch is a refusal, never a guess.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');

export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
export const FACTORY_PROGRAM = 'CB1Tw9aB8ju66q9ZVcezyfCbwNJDVLAMn2RpU3K1tVn';
export const FACTORY_CONFIG_SEED = 'factory_config';
export const FACTORY_CONFIG_DISCRIMINATOR = Object.freeze([29, 197, 255, 232, 22, 128, 67, 26]);
export const FACTORY_CONFIG_OFFSETS = Object.freeze({ governance: 10, guardian: 42, treasury: 74, keeperProcessor: 106 });
export const FACTORY_CONFIG_MIN_BYTES = FACTORY_CONFIG_OFFSETS.keeperProcessor + 32;

/** The portfolio_factory program id from a manifest.json, or the pinned one. */
export function factoryProgramFrom(manifest) {
  return manifest?.repos?.['composable-portfolios-programs']?.deployed_programs?.portfolio_factory ?? FACTORY_PROGRAM;
}

/** True for a base58 string that decodes to a 32-byte key. */
export function isPubkey(value) {
  try {
    return typeof value === 'string' && new PublicKey(value).toBytes().length === 32;
  } catch {
    return false;
  }
}

/** The FactoryConfig PDA of a factory program, base58. */
export function factoryConfigAddress(program = FACTORY_PROGRAM) {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from(FACTORY_CONFIG_SEED)], new PublicKey(program));
  return pda.toBase58();
}

/**
 * Decode a FactoryConfig account. Pure. `{ ok: false, reason }` on a short
 * account or a discriminator that is not FactoryConfig's; the offsets are
 * read only after the discriminator matched.
 */
export function decodeFactoryConfig(bytes) {
  const raw = Buffer.from(bytes);
  if (raw.length < FACTORY_CONFIG_MIN_BYTES) return { ok: false, reason: `account is ${raw.length} bytes, FactoryConfig needs ${FACTORY_CONFIG_MIN_BYTES}` };
  const disc = [...raw.subarray(0, 8)];
  if (disc.some((b, i) => b !== FACTORY_CONFIG_DISCRIMINATOR[i])) {
    return { ok: false, reason: `discriminator [${disc.join(',')}] is not FactoryConfig's [${FACTORY_CONFIG_DISCRIMINATOR.join(',')}]` };
  }
  const key = (offset) => new PublicKey(raw.subarray(offset, offset + 32)).toBase58();
  return {
    ok: true,
    governance: key(FACTORY_CONFIG_OFFSETS.governance),
    guardian: key(FACTORY_CONFIG_OFFSETS.guardian),
    treasury: key(FACTORY_CONFIG_OFFSETS.treasury),
    keeperProcessor: key(FACTORY_CONFIG_OFFSETS.keeperProcessor),
  };
}

/** Read and decode the factory's config through `rpc`. */
export async function readFactoryConfig(rpc, program = FACTORY_PROGRAM) {
  const address = factoryConfigAddress(program);
  const result = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
  const value = result?.value ?? null;
  if (!value) return { ok: false, address, reason: `no account at the FactoryConfig address ${address}` };
  const data = Array.isArray(value.data) ? Buffer.from(value.data[0], 'base64') : Buffer.from(value.data ?? '', 'base64');
  const decoded = decodeFactoryConfig(data);
  return { ...decoded, address, owner: value.owner ?? null };
}

/** The SOL balance of a key, in lamports. */
export async function readBalance(rpc, pubkey) {
  const result = await rpc('getBalance', [pubkey]);
  const value = typeof result === 'number' ? result : result?.value;
  if (!Number.isFinite(Number(value))) throw new Error('getBalance answered without a value');
  return Number(value);
}

/** Lamports as a SOL string without trailing zeros: 20000000 -> "0.02". */
export function lamportsToSol(lamports) {
  const sol = Number(lamports) / 1e9;
  return sol.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * A JSON-RPC caller bound to one endpoint. The endpoint never appears in an
 * error: a failure names the method and the failure class only, because RPC
 * URLs carry keys and this text reaches a terminal and a JSON report.
 */
export function jsonRpc(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  return async function rpc(method, params = []) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`rpc ${method}: ${failureClass(e)}`);
    }
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc ${method}: ${String(body.error.message ?? body.error.code ?? 'error').slice(0, 120)}`);
    return body.result;
  };
}

/** The class of a fetch failure, never its URL: timeout, refused, unresolved, or the error name. */
export function failureClass(e) {
  const cause = e?.cause ?? e;
  if (e?.name === 'TimeoutError' || cause?.name === 'TimeoutError') return 'timeout';
  if (e?.name === 'AbortError') return 'timeout';
  const code = cause?.code ?? e?.code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code) return String(code);
  return e?.name && e.name !== 'Error' ? e.name : 'request failed';
}
