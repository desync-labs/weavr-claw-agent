#!/usr/bin/env node
/**
 * Boot. Everything that can be wrong with the environment is found here and
 * ends the process with exit 1 and a plain reason — never a secret — before
 * a key is read or a port is bound: both tokens present, ≥ 32 bytes and
 * different; keypair readable; mint, treasury, guardian, api URL, RPC URL
 * and policy present; policy valid. Then: ctx, ledger rebuilt from the
 * journal, loop started, server listening on 0.0.0.0:CURATOR_PORT.
 *
 * Why `readConfig` is a separate pure function: the guards are the test
 * surface ("short token ⇒ boot refused") and must run without a key file,
 * an RPC or a port. Why `overrides` exists: a full boot in a test needs a
 * fake connection and a fake api (never the network) — the seams are the
 * same objects `ctx` carries, nothing extra is wired for tests.
 *
 * Why the paused/self-locked state comes from the journal and not only
 * from env: a pod restart must not silently resume a paused signer or
 * forget a self-lock; `CURATOR_START_PAUSED=1` adds a pause, it never
 * removes one.
 *
 * Why `ctx.chain.lookupTables` is the NAV table's *contents* (a Map of
 * address → `AddressLookupTableAccount`, `null` while unread) and not only
 * its address: an apply page is a v0 message whose accounts are indexes
 * into that table, and the decoder can only assert an account it can
 * resolve — with the address alone every v0 page is UNKNOWN_INSTRUCTION.
 * The address set stays as `lookupTableAllowlist`; the contents are read
 * once here and refreshed by the loop every tick and by a verb on a miss.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { connect, idlFor, programId, readNavLookupTableAddress } from '@composable-portfolios/chain';
import { loadPolicy } from './policy.js';
import { loadSigner } from './keys.js';
import { weavrClient } from './weavr.js';
import { Journal, DEFAULT_JOURNAL_FILE, scrub } from './journal.js';
import { loadKnownProgramIds } from './errors.js';
import { createLoop } from './loop.js';
import { createServer, validateTokens } from './server.js';
import { initialState, policyDigestOf, scrubText } from './verbs.js';

export const DEFAULT_PORT = 8091;
export const DEFAULT_TICK_MS = 30000;
export const DEFAULT_REBALANCE_DELAY_SECS = 86400;

/** Core Solana programs a weavr transaction may touch (api `sendSigned.js CORE_PROGRAMS`). */
export const CORE_PROGRAMS = Object.freeze({
  system: '11111111111111111111111111111111',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
});

/** The programs manifest.json pins for this deployment (those it does pin). */
const WEAVR_PROGRAMS = ['stoken', 'accountant', 'asset_manager_escrow', 'portfolio_factory', 'portfolio_allocator', 'portfolio_nav', 'pyth_price_adapter'];

/** The manifest's programs plus the core ones — the same set the api's send guard uses. */
export function allowedProgramSet() {
  const ids = new Set(Object.values(CORE_PROGRAMS));
  for (const name of WEAVR_PROGRAMS) {
    try {
      ids.add(programId(name).toBase58());
    } catch {
      // not pinned on this deployment
    }
  }
  return ids;
}

/** The lookup tables a v0 message may load from: the published NAV table, when this host knows it. */
export function allowedLookupTableSet() {
  const address = readNavLookupTableAddress();
  return new Set(address ? [String(address)] : []);
}

/**
 * The contents of every allowed lookup table, read from the chain, as
 * `Map(address → AddressLookupTableAccount | null)`. A table the RPC did not
 * return (or a connection without `getAddressLookupTable`) stays `null`:
 * still allowed, never resolved, so an account the decoder must assert
 * refuses (UNKNOWN_INSTRUCTION) instead of passing unseen. Never throws.
 * @param {{ getAddressLookupTable?: (key: PublicKey) => Promise<{ value: object | null }> }} connection
 * @param {Iterable<string>} allowlist base58 table addresses
 * @returns {Promise<Map<string, object | null>>}
 */
export async function loadLookupTables(connection, allowlist) {
  const tables = new Map();
  for (const address of allowlist ?? []) {
    let account = null;
    try {
      const got = await connection.getAddressLookupTable(new PublicKey(String(address)));
      account = got?.value ?? null;
    } catch {
      account = null;
    }
    tables.set(String(address), account);
  }
  return tables;
}

const need = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
};

const pubkey = (env, name) => {
  const value = need(env, name);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${name} is not a base58 public key`);
  }
};

const integer = (env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
};

/**
 * The environment, validated. Throws `Error` with a plain reason that names
 * the variable and never echoes a token, a URL or a key.
 * @param {NodeJS.ProcessEnv} env
 */
export function readConfig(env = process.env) {
  const tokens = { agent: env.CURATOR_SIGNER_TOKEN, ops: env.CURATOR_OPS_TOKEN };
  validateTokens(tokens);
  const keypairFile = need(env, 'CURATOR_KEYPAIR');
  const mint = pubkey(env, 'CURATOR_PORTFOLIO_MINT');
  const treasury = pubkey(env, 'CURATOR_TREASURY');
  const guardian = pubkey(env, 'CURATOR_EXPECTED_GUARDIAN');
  const apiUrl = need(env, 'CURATOR_API_URL');
  if (!/^https?:\/\//.test(apiUrl)) throw new Error('CURATOR_API_URL must be an http(s) URL');
  const rpcUrl = String(env.CURATOR_RPC_URL ?? env.SOLANA_RPC_URL ?? '').trim();
  if (rpcUrl === '') throw new Error('CURATOR_RPC_URL (or SOLANA_RPC_URL) is required');
  if (!/^(https?|wss?):\/\//.test(rpcUrl)) throw new Error('CURATOR_RPC_URL must be an http(s) URL');
  const policyJson = typeof env.CURATOR_POLICY_JSON === 'string' && env.CURATOR_POLICY_JSON.trim() !== '' ? env.CURATOR_POLICY_JSON : null;
  const policyFile = typeof env.CURATOR_POLICY_FILE === 'string' && env.CURATOR_POLICY_FILE.trim() !== '' ? env.CURATOR_POLICY_FILE.trim() : null;
  if (!policyJson && !policyFile) throw new Error('CURATOR_POLICY_JSON (or CURATOR_POLICY_FILE) is required');
  const journalFile = String(env.CURATOR_JOURNAL ?? env.CURATOR_JOURNAL_PATH ?? '').trim() || DEFAULT_JOURNAL_FILE;
  const port = integer(env, 'CURATOR_PORT', integer(env, 'CURATOR_SIGNER_PORT', DEFAULT_PORT, { max: 65535 }), { max: 65535 });
  const tickMs = integer(env, 'CURATOR_TICK_MS', DEFAULT_TICK_MS, { min: 1000 });
  const startPaused = env.CURATOR_START_PAUSED === '1' || env.CURATOR_PAUSED === '1';
  const rebalanceDelaySecs = integer(env, 'CURATOR_REBALANCE_DELAY_SECS', DEFAULT_REBALANCE_DELAY_SECS, { min: 0 });
  return { tokens, keypairFile, mint, treasury, guardian, apiUrl, rpcUrl, policyJson, policyFile, journalFile, port, tickMs, startPaused, rebalanceDelaySecs };
}

/** A JSON line per event on stdout; strings URL-scrubbed, secret-shaped keys dropped by the journal's scrubber. */
export function jsonLogger(stream = process.stdout) {
  return (level, event, fields = {}) => {
    const { value } = scrub(fields ?? {});
    const clean = JSON.parse(JSON.stringify(value, (key, entry) => (typeof entry === 'string' ? scrubText(entry, 1000) : entry)));
    const line = { at: new Date().toISOString(), level, event, curator: 'log', ...clean };
    try {
      stream.write(`${JSON.stringify(line)}\n`);
    } catch {
      // a closed pipe must not stop the loop
    }
  };
}

/**
 * Validate env, build ctx, rebuild the ledger, start the loop and the
 * server. Rejects with a plain reason (never a secret) on any guard; the CLI
 * wrapper turns that into exit 1.
 * @param {{ env?: NodeJS.ProcessEnv, overrides?: { policy?: object, signer?: object, client?: object, fetchImpl?: typeof fetch, connection?: object, journal?: object, log?: Function, deps?: object, sleep?: Function, now?: () => number, signals?: boolean, listen?: boolean } }} [opts]
 * @returns {Promise<{ ctx: object, loop: object, server: import('node:http').Server, stop: () => Promise<void> }>}
 */
export async function boot(opts = {}) {
  const { env = process.env, overrides = {} } = opts;
  const cfg = readConfig(env);
  const log = overrides.log ?? jsonLogger(process.stdout);
  const now = overrides.now ?? (() => Date.now());

  let policy;
  try {
    policy = overrides.policy ?? loadPolicy(cfg.policyJson ?? (await import('node:fs')).readFileSync(cfg.policyFile, 'utf8'));
  } catch (error) {
    throw new Error(`policy: ${scrubText(error?.message ?? String(error))}`);
  }
  const rebalanceDelaySecs = Number(policy?.invariants?.rebalanceDelaySecs ?? cfg.rebalanceDelaySecs);

  let signer;
  try {
    signer = overrides.signer ?? loadSigner({ file: cfg.keypairFile });
  } catch (error) {
    throw new Error(scrubText(error?.message ?? 'CURATOR_KEYPAIR: keypair unreadable'));
  }

  const connection = overrides.connection ?? connect(cfg.rpcUrl);
  const lookupTableAllowlist = allowedLookupTableSet();
  const chain = {
    connection,
    programs: allowedProgramSet(),
    lookupTableAllowlist,
    lookupTables: new Map([...lookupTableAllowlist].map((address) => [address, null])),
    idls: {
      portfolio_factory: idlFor('portfolio_factory'),
      stoken: idlFor('stoken'),
      accountant: idlFor('accountant'),
    },
    /** Re-read the allowed tables' contents; the loop calls this every tick, a verb on a decode miss. */
    async refreshLookupTables() {
      chain.lookupTables = await loadLookupTables(connection, lookupTableAllowlist);
      return chain.lookupTables;
    },
  };
  await loadKnownProgramIds();
  await chain.refreshLookupTables();

  const client = overrides.client ?? weavrClient({ apiUrl: cfg.apiUrl, fetchImpl: overrides.fetchImpl ?? globalThis.fetch });

  let journal = overrides.journal;
  if (!journal) {
    mkdirSync(dirname(cfg.journalFile), { recursive: true, mode: 0o700 });
    journal = new Journal({ file: cfg.journalFile, now });
  }
  const nowSecs = Math.floor(now() / 1000);
  const ledger = journal.rebuildLedger({ now: nowSecs });
  const state = initialState({
    paused: cfg.startPaused || Boolean(ledger.paused),
    selfLocked: ledger.selfLocked ? { at: ledger.selfLocked.at, reason: ledger.selfLocked.reason ?? 'INVARIANT_DRIFT', drift: ledger.selfLocked.drift ?? [] } : null,
    operatorRequest: ledger.operatorRequest ?? null,
    // The last plain review's drift streak and risk tiers, so a restart does
    // not forget how long an asset has sat under target.
    reviewState: ledger.reviewState ?? null,
    ledger,
  });

  const ctx = {
    policy,
    signer,
    client,
    journal,
    chain,
    config: {
      mint: cfg.mint,
      treasury: cfg.treasury,
      expectedCurator: signer.wallet,
      guardian: cfg.guardian,
      rebalanceDelaySecs,
      apiUrl: cfg.apiUrl,
      port: cfg.port,
      tickMs: cfg.tickMs,
      journalFile: cfg.journalFile,
    },
    state,
    now,
    log,
    ...(overrides.deps ? { deps: overrides.deps } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  };

  // Once, at boot: the digest of the policy as loaded. GET /policy and
  // status.policy.sha256 quote the same value, so an agent's transcript and
  // the boot record can be matched to one document.
  policyDigestOf(ctx);

  const loop = createLoop({ ctx, intervalMs: cfg.tickMs });
  const server = createServer({ ctx, loop, tokens: cfg.tokens });

  if (overrides.listen !== false) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  journal.append({
    kind: 'boot',
    wallet: signer.wallet,
    mint: cfg.mint,
    policyVersion: policy?.version ?? null,
    policySha256: ctx.policyDigest,
    paused: state.paused,
    selfLocked: state.selfLocked ? { at: state.selfLocked.at, reason: state.selfLocked.reason } : null,
    reviewState: state.reviewState ? { at: state.reviewState.at } : null,
    port: server.address()?.port ?? cfg.port,
    tickMs: cfg.tickMs,
    programs: chain.programs.size,
    lookupTables: chain.lookupTables.size,
    lookupTablesResolved: [...chain.lookupTables.values()].filter(Boolean).length,
  });
  log('info', 'boot', { wallet: signer.wallet, mint: cfg.mint, port: server.address()?.port ?? cfg.port, paused: state.paused, selfLocked: Boolean(state.selfLocked), policyVersion: policy?.version ?? null, policySha256: ctx.policyDigest });

  loop.start();

  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      log('info', 'stopping', {});
      await loop.stop();
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    })();
    return stopping;
  };

  if (overrides.signals !== false) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        stop().then(() => process.exit(0), () => process.exit(0));
      });
    }
  }

  return { ctx, loop, server, stop };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  boot().catch((error) => {
    console.error(`curator: ${scrubText(error?.message ?? String(error))}`);
    process.exit(1);
  });
}
