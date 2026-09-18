/**
 * Transaction checks a text-only agent's wallet tool runs before it signs
 * anything. Pure functions: no network, no keys, so the unit tests can plant
 * violations (a v0 transaction where the signer takes legacy only, a foreign
 * program, a program loaded from a lookup table, the wrong fee payer) and
 * prove each one is refused.
 *
 * A versioned (v0) transaction is what weavr builds for a create of five or
 * more assets, against its NAV lookup table. The PayBox signer decodes legacy
 * only, so by default a v0 payload is refused as LEGACY_ONLY; a signer that
 * can sign v0 (the local key) says so with `allowVersioned`, and the same
 * payer and program checks then run on the v0 message.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { Transaction, VersionedTransaction } = require('@solana/web3.js');

/** Core Solana programs a weavr user transaction may touch. */
export const CORE_PROGRAMS = Object.freeze({
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
});

/** Exit codes the CLIs map each refusal to. */
export const EXIT = Object.freeze({
  USAGE: 1,
  LEGACY_ONLY: 2,
  WALLET_DECLINED: 3,
  REFUSED: 4, // WRONG_PAYER, FOREIGN_PROGRAM, NOT_A_TRANSACTION
  CONFIG: 5,
  BUSY: 6,
  WEAVR_ERROR: 7,
  FAILED: 8,
  NO_WALLET: 9, // link mode: this host has no signing wallet
});

/** Every deployed program id recorded in an ops manifest.json. */
export function programsFromManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const ids = [];
  for (const repo of Object.values(manifest.repos ?? {})) {
    for (const id of Object.values(repo.deployed_programs ?? {})) ids.push(id);
  }
  if (!ids.length) throw new Error(`no deployed_programs in ${manifestPath}`);
  return ids;
}

/** The allowlist: manifest programs plus the core programs. */
export function allowedPrograms(manifestIds) {
  return new Set([...manifestIds, ...Object.values(CORE_PROGRAMS)]);
}

/** True when the encoded transaction uses a versioned (v0) message. */
export function isVersioned(raw) {
  if (!raw.length) return false;
  const count = raw[0];
  const first = raw[1 + 64 * count];
  return first !== undefined && (first & 0x80) !== 0;
}

/** The refusal a legacy-only signer gives a v0 transaction. */
export const LEGACY_ONLY_DETAIL = 'this transaction is versioned (v0); the PayBox signer decodes legacy transactions only, a local key or the sign link can sign it. weavr signs up to 3 assets in one legacy transaction, or up to 4 as two when its legacy-only create mode (MCP_LEGACY_SIGNER) is on; suggest fewer assets.';

/** The refusal a v0 instruction gets when its program id is not a static key. */
export const PROGRAM_FROM_LOOKUP_TABLE = 'program loaded from a lookup table';

/**
 * Check one encoded transaction. Returns `{ ok: true, bytes, programs }`
 * (`versioned: true` added for a v0 transaction) or
 * `{ ok: false, error, detail, exit }`. Never throws on bad input.
 *
 * `allowVersioned` (default false) is the signer's word that it signs v0:
 * without it every v0 transaction is LEGACY_ONLY, whatever it carries.
 */
export function checkTransaction(encoded, { wallet, allowed, allowVersioned = false }) {
  let raw;
  try {
    raw = Buffer.from(encoded, 'base64');
  } catch {
    return { ok: false, error: 'NOT_A_TRANSACTION', detail: 'not a transaction', exit: EXIT.REFUSED };
  }
  if (!raw.length) return { ok: false, error: 'NOT_A_TRANSACTION', detail: 'empty payload', exit: EXIT.REFUSED };
  if (isVersioned(raw)) {
    if (allowVersioned !== true) {
      return { ok: false, error: 'LEGACY_ONLY', detail: LEGACY_ONLY_DETAIL, exit: EXIT.LEGACY_ONLY };
    }
    return checkVersioned(raw, { wallet, allowed });
  }
  let tx;
  try {
    tx = Transaction.from(raw);
  } catch (e) {
    return { ok: false, error: 'NOT_A_TRANSACTION', detail: String(e.message).slice(0, 120), exit: EXIT.REFUSED };
  }
  const payer = tx.feePayer?.toBase58();
  if (payer !== wallet) {
    return { ok: false, error: 'WRONG_PAYER', detail: `fee payer ${payer} is not the wallet ${wallet}`, exit: EXIT.REFUSED };
  }
  const programs = [];
  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    programs.push(pid);
    if (!allowed.has(pid)) {
      return { ok: false, error: 'FOREIGN_PROGRAM', detail: `instruction targets ${pid}, which is not a weavr or core program`, exit: EXIT.REFUSED };
    }
  }
  return { ok: true, bytes: raw.length, programs };
}

/**
 * The v0 checks. The fee payer is the first static key. A program id is
 * always a static key (the runtime never loads one from a lookup table), so a
 * `programIdIndex` past the static keys is refused before the allowlist is
 * consulted: the key it would name is not in the message at all.
 */
function checkVersioned(raw, { wallet, allowed }) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch (e) {
    return { ok: false, error: 'NOT_A_TRANSACTION', detail: String(e.message).slice(0, 120), exit: EXIT.REFUSED };
  }
  const staticKeys = tx.message.staticAccountKeys;
  const payer = staticKeys[0]?.toBase58();
  if (payer !== wallet) {
    return { ok: false, error: 'WRONG_PAYER', detail: `fee payer ${payer} is not the wallet ${wallet}`, exit: EXIT.REFUSED };
  }
  const programs = [];
  for (const ix of tx.message.compiledInstructions) {
    if (!(ix.programIdIndex < staticKeys.length)) {
      return { ok: false, error: 'FOREIGN_PROGRAM', detail: `${PROGRAM_FROM_LOOKUP_TABLE} (instruction program index ${ix.programIdIndex}, ${staticKeys.length} static keys)`, exit: EXIT.REFUSED };
    }
    const pid = staticKeys[ix.programIdIndex].toBase58();
    programs.push(pid);
    if (!allowed.has(pid)) {
      return { ok: false, error: 'FOREIGN_PROGRAM', detail: `instruction targets ${pid}, which is not a weavr or core program`, exit: EXIT.REFUSED };
    }
  }
  return { ok: true, bytes: raw.length, programs, versioned: true };
}

/** Check every transaction of a payload; the first refusal wins. */
export function checkAll(encodedList, opts) {
  const results = [];
  for (const encoded of encodedList) {
    const r = checkTransaction(encoded, opts);
    if (!r.ok) return r;
    results.push(r);
  }
  return { ok: true, results };
}
