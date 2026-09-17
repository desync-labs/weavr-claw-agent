/**
 * What the agent wallet holds, read from a public RPC so the agent can tell
 * the user what to send before a create or a deposit fails for want of it.
 * Read-only: no key, no signature, no approval needed.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * The SOL the wallet should hold. A create spends about 0.08 SOL on rent
 * and fees (weavr's simulate_portfolio prints the exact figure); every other
 * action (deposit, withdrawal, valuation refresh) is a few thousandths.
 * Deposits themselves are paid in USDC, not SOL.
 */
export const MIN_SOL = Object.freeze({ create: 0.15, action: 0.02 });

export function connectionFor(env = process.env) {
  return new Connection(env.SOLANA_RPC_URL ?? DEFAULT_RPC, 'confirmed');
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * SOL and USDC held by `address`. `conn` needs `getBalance` and
 * `getParsedTokenAccountsByOwner` (a web3.js Connection, or a stub in tests).
 */
export async function readBalances(address, conn) {
  const owner = new PublicKey(address);
  const lamports = await conn.getBalance(owner);
  const parsed = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) });
  let usdc = 0;
  for (const { account } of parsed?.value ?? []) {
    usdc += Number(account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
  }
  const sol = lamports / 1e9;
  return {
    address,
    sol: round(sol, 6),
    usdc: round(usdc, 2),
    minSol: MIN_SOL,
    ok: { create: sol >= MIN_SOL.create, action: sol >= MIN_SOL.action },
    note: 'SOL pays network fees only; deposits are paid in USDC (Solana), so a deposit of $X needs at least X USDC here.',
  };
}

/** Share balance of `mint` held by `address`, in base units. Zero if none. */
export async function readShareBalance(address, mint, conn) {
  const parsed = await conn.getParsedTokenAccountsByOwner(new PublicKey(address), { mint: new PublicKey(mint) });
  let raw = 0n;
  for (const { account } of parsed?.value ?? []) {
    raw += BigInt(account?.data?.parsed?.info?.tokenAmount?.amount ?? '0');
  }
  return raw;
}
