/**
 * Three definitions the signer uses whose home files the mirror does not
 * carry: `PAGE_LEGS` and `applyScratchPda` live in the backend's
 * `navCrank.js` (the keeper's NAV crank builders, 664 lines) and
 * `readNavLookupTableAddress` in its `lookupTable.js` (352 lines). They are
 * restated here, one constant and two small functions, and kept in step by
 * value rather than by bytes: the ops gate `sync_signer_chain.mjs --check`
 * imports both packages and compares `PAGE_LEGS`, the PDA of a fixed key and
 * the lookup-table read under a fixed environment. A body edited on one side
 * is a failing gate on the other.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { programId } from './chain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UMBRELLA = join(HERE, '..', '..', '..', '..');
const CACHE = join(UMBRELLA, '.cache', 'nav-lookup-table.json');

const asPk = (value) => (value instanceof PublicKey ? value : new PublicKey(value));

/** Legs per NAV page: `crank_nav` pages eight legs into the book vault. */
export const PAGE_LEGS = 8;

/** The `apply_scratch` PDA of a portfolio under the factory program. */
export function applyScratchPda(portfolio) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('apply_scratch'), asPk(portfolio).toBuffer()],
    programId('portfolio_factory'),
  )[0];
}

/** Where the keeper caches the NAV lookup table address it created. */
export function navLookupTableCachePath() {
  return process.env.NAV_LOOKUP_TABLE_CACHE ?? CACHE;
}

/** `NAV_LOOKUP_TABLE`, else the cached address, else null. */
export function readNavLookupTableAddress() {
  if (process.env.NAV_LOOKUP_TABLE) return process.env.NAV_LOOKUP_TABLE;
  const path = navLookupTableCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed.address ?? null;
  } catch {
    return null;
  }
}
