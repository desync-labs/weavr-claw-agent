/**
 * Fakes for the server, verbs and loop tests: a clock, a snapshot with the
 * real on-chain value types (PublicKey, BN), a recording api client, a
 * recording signer and the pure-module deps hung on `ctx.deps`. Every fake
 * records into one shared `trace` so a test can assert the pipeline order
 * across modules (never sign before verify, never send before sign). The
 * journal is the real one on a temp file with the stdout mirror off.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { Journal } from '../src/journal.js';
import { initialState } from '../src/verbs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const { BN } = anchor;

export const POLICY = Object.freeze(JSON.parse(readFileSync(join(HERE, 'fixtures', 'policy.v1.json'), 'utf8')));
export const T0_MS = 1_760_000_000_000; // 2025-10-09T08:53:20Z
export const T0 = Math.floor(T0_MS / 1000);

export const KEYS = Object.freeze({
  curator: Keypair.generate(),
  mint: Keypair.generate().publicKey,
  treasury: Keypair.generate().publicKey,
  guardian: Keypair.generate().publicKey,
  governance: Keypair.generate().publicKey,
  keeper: Keypair.generate().publicKey,
  portfolio: Keypair.generate().publicKey,
  vault: Keypair.generate().publicKey,
  accountant: Keypair.generate().publicKey,
  pendingTargets: Keypair.generate().publicKey,
  usdc: Keypair.generate().publicKey,
});
export const WALLET = KEYS.curator.publicKey.toBase58();
export const MINT = KEYS.mint.toBase58();
export const TREASURY = KEYS.treasury.toBase58();
export const GUARDIAN = KEYS.guardian.toBase58();

export const LEGS = Object.freeze([
  { poolId: 'pSOL', symbol: 'pSOL', targetWeightBps: 4000, weightBps: 4000, valueUsdc: 400 },
  { poolId: 'pCBBTC', symbol: 'pCBBTC', targetWeightBps: 3000, weightBps: 3000, valueUsdc: 300 },
  { poolId: 'pUSDT', symbol: 'pUSDT', targetWeightBps: 3000, weightBps: 3000, valueUsdc: 300 },
]);
export const NEW_TARGETS = Object.freeze([
  { poolId: 'pSOL', weightBps: 3000 },
  { poolId: 'pJITOSOL', weightBps: 3000 },
  { poolId: 'pCBBTC', weightBps: 2000 },
  { poolId: 'pUSDT', weightBps: 2000 },
]);
/** Holdings legs whose target weights equal NEW_TARGETS (what the chain shows after an apply). */
export const LEGS_AFTER = Object.freeze(NEW_TARGETS.map((t) => ({ poolId: t.poolId, symbol: t.poolId, targetWeightBps: t.weightBps, weightBps: t.weightBps, valueUsdc: t.weightBps / 10 })));

export const POOLS = Object.freeze(['pSOL', 'pJITOSOL', 'pCBBTC', 'pUSDT', 'pMSOL'].map((symbol) => ({
  poolId: symbol, symbol, chain: 'solana', status: 'active', priceState: 'fresh', pendingPrice: null, tvlUsdc: 100000, riskTier: 2, maxWeightBps: 5000, maxExecutionLossBps: 50, trailingYieldBps: 300, pythFeedId: `feed-${symbol}`,
})));

export function fakeClock(startMs = T0_MS) {
  let t = startMs;
  return { now: () => t, advance(secs) { t += secs * 1000; return t; }, set(ms) { t = ms; } };
}

export function fakeSnapshot(over = {}) {
  const {
    pending = null, legs = LEGS, priceState = 'fresh', lamports = 100_000_000, lastRebalanceAt = T0 - 30 * 86400,
    curator = WALLET, pendingCurator = null, applyNextPage = 0, vaultPaused = false, withdrawalsPending = 0,
    keeperOk = true, rebalanceDelaySecs = 86400, compositionLocked = false, health, at = T0, recipient1 = KEYS.treasury, guardian = KEYS.guardian,
  } = over;
  return {
    at,
    slot: 1000,
    portfolioRow: {
      mint: MINT, symbol: 'WEAVR', state: 'active', priceState, pendingPrice: null, withdrawalsPending,
      pendingTargets: pending, holdings: { legs, idleWeightBps: 500 }, curator, feeRecipient: TREASURY,
      rebalanceDelaySecs, compositionLocked, vaultKey: KEYS.vault.toBase58(), accountant: KEYS.accountant.toBase58(), portfolio: KEYS.portfolio.toBase58(),
    },
    portfolioAccount: {
      curator: new PublicKey(curator), pendingCurator: pendingCurator ? new PublicKey(pendingCurator) : null, accountant: KEYS.accountant,
      sharesMint: KEYS.mint, compositionLocked, rebalanceDelaySecs: new BN(rebalanceDelaySecs), lastRebalanceAt: new BN(lastRebalanceAt),
      pendingTargets: pending ? KEYS.pendingTargets : null, applyNextPage, state: { active: {} }, vault: KEYS.vault, creator: KEYS.treasury,
      legCount: legs.length, pageCount: 1,
    },
    vaultAccount: {
      totalShares: new BN(1_000_000_000), totalIdle: new BN(50_000_000), totalWithdrawalsPending: new BN(withdrawalsPending),
      maxTotalShares: new BN('2000000000000'), maxSharesPerUser: new BN('500000000000'), maxTotalIdle: new BN('200000000000'),
      pendingPrice: null, paused: vaultPaused, price: new BN(1_000_000), lastPriceUpdateTimestamp: new BN(at), maxPriceStalenessSecs: new BN(720), underlyingMint: KEYS.usdc,
    },
    accountantAccount: { recipient1, recipient2: KEYS.curator.publicKey, weight1: 6000, weight2: 4000, manager: KEYS.treasury, pendingRecipients: null },
    factoryConfig: { governance: KEYS.governance, guardian, treasury: KEYS.treasury, keeperProcessor: KEYS.keeper, policy: {}, creationPaused: false, keeperRiskPaused: false },
    pools: POOLS,
    health: health ?? { status: 'ok', keeper: { ok: keeperOk } },
    signer: { lamports, usdcBaseUnits: '1000000000', shares: '100000000' },
  };
}

/** The pure-module deps, permissive by default; every call lands in `trace`. */
export function fakeDeps(over = {}) {
  const { snapshot, trace = [], ...rest } = over;
  const holder = { snapshot: snapshot ?? fakeSnapshot() };
  const base = {
    verbAllowed: () => ({ ok: true }),
    evaluateWrite: () => ({ ok: true }),
    evaluateProposal: () => ({ ok: true, summary: { turnoverBps: 1000, estimatedCostBps: 5, legs: [], categories: {}, nextProposeAt: null } }),
    evaluateDeposit: ({ amountUsd }) => ({ ok: true, summary: { amountBaseUnits: String(Math.round(amountUsd * 1e6)), minShares: '0', headroomBaseUnits: '1000000000' } }),
    evaluateWithdraw: () => ({ ok: true, summary: { shares: '1000000', minAmountOut: '0' } }),
    verifyBuilt: ({ transactions }) => ({ ok: true, summary: { transactions: transactions.length, steps: transactions.map((t) => t.step), instructions: [] } }),
    readSnapshot: async () => (typeof holder.snapshot === 'function' ? holder.snapshot() : holder.snapshot),
    applyGates: () => ({ ok: true }),
    proposeGates: () => ({ ok: true }),
    checkInvariants: () => ({ ok: true }),
    deriveReview: () => ({ brief: 'HOLD: nothing to do', triggers: [], wakeAgent: false, holdReason: 'steady' }),
    renderPrometheus: (gauges) => `${Object.entries(gauges).map(([k, v]) => (typeof v === 'number' ? `${k} ${v}` : `${k}{state="${v}"} 1`)).join('\n')}\n`,
    nameProgramError: () => null,
  };
  const deps = { trace, setSnapshot: (s) => { holder.snapshot = s; } };
  for (const [name, impl] of Object.entries(base)) {
    const fn = rest[name] ?? impl;
    deps[name] = (...args) => { trace.push(name); return fn(...args); };
  }
  return deps;
}

/** A recording api client; `fail[name]` makes that call throw, `sendResult` overrides the send answer. */
export function fakeClient({ trace = [] } = {}) {
  const calls = [];
  const client = { calls, trace, fail: {}, sendResult: null, deploymentId: 'dep-1' };
  const payload = (step) => ({ deploymentId: client.deploymentId, recentBlockhashExpiresAtHeight: 100, transactions: [{ step, signer: 'curator', signerKey: WALLET, tx: 'AQIDBA==' }] });
  const build = (name, step) => async (mint, body) => {
    calls.push({ name, mint, body });
    trace.push(name);
    if (client.fail[name]) throw client.fail[name];
    return payload(step);
  };
  Object.assign(client, {
    buildPropose: build('buildPropose', 'propose_targets'),
    buildApply: build('buildApply', 'apply_targets'),
    buildCancel: build('buildCancel', 'cancel_targets'),
    buildRefreshNav: build('buildRefreshNav', 'crank_nav'),
    buildDeposit: build('buildDeposit', 'deposit'),
    buildWithdraw: build('buildWithdraw', 'withdraw_request'),
    buildProposeCurator: build('buildProposeCurator', 'propose_curator'),
    buildRebalanceDelay: build('buildRebalanceDelay', 'update_rebalance_delay'),
    buildMetadata: build('buildMetadata', 'set_portfolio_metadata'),
    async send(signed) {
      calls.push({ name: 'send', count: signed.length });
      trace.push('send');
      const fail = client.fail.send;
      if (fail) {
        if (typeof fail === 'function') return fail(calls.filter((c) => c.name === 'send').length);
        throw fail;
      }
      return client.sendResult ?? { ok: true, status: 'confirmed', signatures: ['sig-1'], error: null };
    },
    portfolio: async () => ({}),
    pools: async () => [],
    health: async () => ({}),
  });
  return client;
}

export function fakeSigner({ trace = [] } = {}) {
  const calls = [];
  return {
    calls,
    wallet: WALLET,
    kind: 'curator',
    async sign(list) {
      calls.push(list.length);
      trace.push('sign');
      return list.map((tx) => `signed:${tx}`);
    },
  };
}

/** A ctx wired with the fakes above; call `ctx.cleanup()` to drop the temp journal. */
export function fakeCtx(over = {}) {
  const clock = over.clock ?? fakeClock();
  const trace = [];
  const dir = mkdtempSync(join(tmpdir(), 'curator-test-'));
  const journalFile = join(dir, 'journal.jsonl');
  const journal = over.journal ?? new Journal({ file: journalFile, now: clock.now, stdout: null });
  const deps = over.deps ?? fakeDeps({ snapshot: over.snapshot, trace, ...(over.depsOverrides ?? {}) });
  const client = over.client ?? fakeClient({ trace });
  const signer = over.signer ?? fakeSigner({ trace });
  const logs = [];
  const ctx = {
    policy: over.policy ?? POLICY,
    signer,
    client,
    journal,
    chain: { connection: {}, programs: new Set(['11111111111111111111111111111111']), lookupTables: new Set(), idls: {} },
    config: {
      mint: MINT, treasury: TREASURY, expectedCurator: WALLET, guardian: GUARDIAN, rebalanceDelaySecs: 86400,
      apiUrl: 'http://api.test', port: 0, tickMs: 30000, journalFile,
    },
    state: initialState({ paused: over.paused ?? false, selfLocked: over.selfLocked ?? null }),
    now: clock.now,
    log: (level, event, fields) => logs.push({ level, event, ...(fields ?? {}) }),
    deps,
    sleep: async (ms) => { ctx.sleeps.push(ms); },
    sleeps: [],
    clock,
    trace,
    logs,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return ctx;
}

export const meta = (over = {}) => ({ session: 'chat', caller: 'test', tokenKind: 'agent', ...over });
