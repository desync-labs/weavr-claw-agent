/**
 * Pre-flight gates: one planted violation per blocker row of README §5 (plan
 * §4.5), the retirable exemption in all three of its states, the strict
 * per-pool parked-mark rule the book-level tolerance would hide, and the
 * propose-side mirror of `validate_proposal`. Every account is a fixture in
 * the shape `fetchDecoded` returns (PublicKey, BN); nothing here touches a
 * network. `readSnapshot` runs against a fake api client, a fake connection
 * and a fake chain lib.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { applyGates, proposeGates, checkInvariants, readSnapshot } from '../src/preflight.js';

const bn = (value) => new anchor.BN(String(value));
const key = () => Keypair.generate().publicKey;
const iso = (unixSecs) => new Date(unixSecs * 1000).toISOString();

const NOW = 1_800_000_000;
const EFFECTIVE = NOW - 60;
const DAY = 86400;

const CURATOR = key();
const TREASURY = key();
const GUARDIAN = key();
const CREATOR = key();
const ACCOUNTANT = key();
const MINT = key();
const VAULT = key();
const PORTFOLIO = key();
const USDC = key();

const POLICY = Object.freeze({
  invariants: { rebalanceDelaySecs: 86400, compositionLocked: false, pendingCuratorMustBeNone: true },
  apply: {
    tickSecs: 30,
    armBeforeEffectiveSecs: 120,
    windowAfterEffectiveSecs: 21600,
    refreshNavWhenBookStaleSecs: 900,
    applyInFlightWaitSlots: 320,
    applyInFlightMaxAttempts: 3,
    missingCustodyRetries: 1,
    escalateAfterSecs: {
      BOOK_NOT_FRESH: 1800,
      BOOK_PENDING_PRICE: 1200,
      LEG_PENDING_PRICE_PYTH: 600,
      LEG_PENDING_PRICE_PUBLISHER: 0,
      LEG_STALE: 1800,
      WITHDRAWALS_PENDING: 3600,
      LEG_NOT_ACTIVE: 0,
      VAULT_PAUSED: 0,
      WINDOW_CLOSED: 0,
    },
  },
});

const CONFIG = Object.freeze({
  expectedCurator: CURATOR.toBase58(),
  treasury: TREASURY.toBase58(),
  guardian: GUARDIAN.toBase58(),
  rebalanceDelaySecs: 86400,
});

const SOL = 'pSOL@solana';
const USDT = 'pUSDT@solana';
const MSOL = 'pMSOL@solana';
const JITO = 'pJITOSOL@solana';

const pool = (poolId, symbol, extra = {}) => ({
  poolId,
  symbol,
  chain: 'solana',
  status: 'active',
  priceState: 'fresh',
  pendingPrice: null,
  tvlUsdc: '5000000000000',
  riskTier: 2,
  maxWeightBps: 4000,
  maxExecutionLossBps: 50,
  trailingYieldBps: 300,
  pythFeedId: '0xfeed',
  ...extra,
});

/** Held: pSOL, pUSDT, pMSOL. Proposed: pSOL, pUSDT, pJITOSOL — so pMSOL is omitted (still funded) and pJITOSOL is new. */
function fixture(overrides = {}) {
  const base = {
    at: NOW,
    slot: 1000,
    portfolioRow: {
      mint: MINT.toBase58(),
      symbol: 'WEAVR',
      state: 'live',
      priceState: 'fresh',
      pendingPrice: null,
      withdrawalsPending: '0',
      pendingTargets: {
        targets: [{ poolId: SOL, weightBps: 5000 }, { poolId: USDT, weightBps: 3000 }, { poolId: JITO, weightBps: 2000 }],
        proposedAt: iso(EFFECTIVE - DAY),
        effectiveAt: iso(EFFECTIVE),
      },
      holdings: {
        legs: [
          { poolId: SOL, symbol: 'pSOL', targetWeightBps: 4000, weightBps: 4100, valueUsdc: '410000000', shares: '400000000' },
          { poolId: USDT, symbol: 'pUSDT', targetWeightBps: 4000, weightBps: 3900, valueUsdc: '390000000', shares: '390000000' },
          { poolId: MSOL, symbol: 'pMSOL', targetWeightBps: 2000, weightBps: 1500, valueUsdc: '150000000', shares: '140000000' },
        ],
        idleWeightBps: 500,
      },
      positions: [SOL, USDT, MSOL],
      targets: [{ poolId: SOL, weightBps: 4000 }, { poolId: USDT, weightBps: 4000 }, { poolId: MSOL, weightBps: 2000 }],
      curator: CURATOR.toBase58(),
      feeRecipient: TREASURY.toBase58(),
      rebalanceDelaySecs: 86400,
      compositionLocked: false,
      vaultKey: VAULT.toBase58(),
      accountant: ACCOUNTANT.toBase58(),
      portfolio: PORTFOLIO.toBase58(),
    },
    portfolioAccount: {
      curator: CURATOR,
      pendingCurator: null,
      accountant: ACCOUNTANT,
      sharesMint: MINT,
      compositionLocked: false,
      rebalanceDelaySecs: bn(86400),
      lastRebalanceAt: bn(NOW - 10 * DAY),
      pendingTargets: { proposedAt: bn(EFFECTIVE - DAY), effectiveAt: bn(EFFECTIVE) },
      applyNextPage: 0,
      state: { live: {} },
      vault: VAULT,
      creator: CREATOR,
      legCount: 3,
      pageCount: 1,
    },
    vaultAccount: {
      totalShares: bn('1000000000000'),
      totalIdle: bn('50000000'),
      totalWithdrawalsPending: bn(0),
      maxTotalShares: bn('2000000000000'),
      maxSharesPerUser: bn('500000000000'),
      maxTotalIdle: bn('200000000000'),
      pendingPrice: null,
      paused: false,
      price: bn(1_000_000),
      lastPriceUpdateTimestamp: bn(NOW - 60),
      maxPriceStalenessSecs: bn(3600),
      underlyingMint: USDC,
    },
    accountantAccount: { recipient1: TREASURY, recipient2: CREATOR, weight1: 4000, weight2: 6000, manager: TREASURY, pendingRecipients: null },
    factoryConfig: { governance: key(), guardian: GUARDIAN, treasury: TREASURY, keeperProcessor: key(), policy: {}, creationPaused: false, keeperRiskPaused: false, underlyingMint: USDC },
    applyScratch: null,
    pools: [pool(SOL, 'pSOL'), pool(USDT, 'pUSDT', { maxExecutionLossBps: 20 }), pool(MSOL, 'pMSOL', { pythFeedId: null }), pool(JITO, 'pJITOSOL')],
    health: { status: 'ok', processes: { keeper: { status: 'ok' } } },
    pendingUnwinds: [],
    custody: null,
    signer: { lamports: 1_000_000_000, usdcBaseUnits: '0', shares: '0' },
  };
  const merged = { ...base };
  for (const [section, value] of Object.entries(overrides)) {
    merged[section] = value && typeof value === 'object' && !Array.isArray(value) && base[section] && typeof base[section] === 'object' && !Array.isArray(base[section])
      ? { ...base[section], ...value }
      : value;
  }
  return merged;
}

const withPool = (snapshot, poolId, patch) => ({
  ...snapshot,
  pools: snapshot.pools.map((row) => (row.poolId === poolId ? { ...row, ...patch } : row)),
});
const withLeg = (snapshot, poolId, patch) => ({
  ...snapshot,
  portfolioRow: {
    ...snapshot.portfolioRow,
    holdings: {
      ...snapshot.portfolioRow.holdings,
      legs: snapshot.portfolioRow.holdings.legs.map((leg) => (leg.poolId === poolId ? { ...leg, ...patch } : leg)),
    },
  },
});
const codes = (result) => result.blockers.map((entry) => entry.code);
const only = (result, code) => {
  assert.equal(result.ok, false);
  const found = result.blockers.filter((entry) => entry.code === code);
  assert.equal(found.length, 1, `expected exactly one ${code}, got ${JSON.stringify(codes(result))}`);
  return found[0];
};

describe('applyGates', () => {
  it('passes a fresh, effective, unblocked change', () => {
    assert.deepEqual(applyGates(fixture(), POLICY, NOW), { ok: true });
  });

  it('throws without the required accounts rather than answering', () => {
    assert.throws(() => applyGates(fixture({ vaultAccount: null }), POLICY, NOW), /vaultAccount/);
    assert.throws(() => applyGates(fixture({ portfolioAccount: null }), POLICY, NOW), /portfolioAccount/);
  });

  it('NO_PENDING_CHANGE: nothing pending on chain is "done", and nothing else is evaluated', () => {
    const result = applyGates(fixture({ portfolioAccount: { pendingTargets: null }, vaultAccount: { paused: true } }), POLICY, NOW);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['NO_PENDING_CHANGE']);
    assert.equal(result.blockers[0].action, 'done');
  });

  it('WINDOW_CLOSED: past effectiveAt + 6 h escalates at once', () => {
    const effective = NOW - POLICY.apply.windowAfterEffectiveSecs - 1;
    const result = applyGates(fixture({ portfolioAccount: { pendingTargets: { proposedAt: bn(effective - DAY), effectiveAt: bn(effective) } } }), POLICY, NOW);
    const found = only(result, 'WINDOW_CLOSED');
    assert.equal(found.action, 'escalate');
    assert.equal(found.escalateAfterSecs, 0);
  });

  it('NOTICE_NOT_ELAPSED: TargetsNotEffective waits until effectiveAt', () => {
    const result = applyGates(fixture({ portfolioAccount: { pendingTargets: { proposedAt: bn(NOW - 100), effectiveAt: bn(NOW + 100) } } }), POLICY, NOW);
    const found = only(result, 'NOTICE_NOT_ELAPSED');
    assert.equal(found.action, 'wait');
    assert.equal(found.waitSecs, 100);
  });

  it('VAULT_PAUSED: a paused book vault is blocked', () => {
    const found = only(applyGates(fixture({ vaultAccount: { paused: true } }), POLICY, NOW), 'VAULT_PAUSED');
    assert.equal(found.action, 'blocked');
    assert.equal(found.escalateAfterSecs, 0);
  });

  it('LEG_NOT_ACTIVE: a funded held pool that is paused blocks (RequiredPoolPaused)', () => {
    const found = only(applyGates(withPool(fixture(), MSOL, { status: 'paused' }), POLICY, NOW), 'LEG_NOT_ACTIVE');
    assert.equal(found.action, 'blocked');
    assert.equal(found.poolId, MSOL);
    assert.match(found.message, /RequiredPoolPaused/);
  });

  it('LEG_NOT_ACTIVE: a new pool that is not active blocks (PoolNotActive)', () => {
    const found = only(applyGates(withPool(fixture(), JITO, { status: 'retired' }), POLICY, NOW), 'LEG_NOT_ACTIVE');
    assert.equal(found.action, 'blocked');
    assert.match(found.message, /PoolNotActive/);
  });

  it('retirable exemption: omitted + custody 0 + no unwind pending skips the pool entirely', () => {
    const snapshot = withLeg(withPool(fixture(), MSOL, { status: 'paused', priceState: 'stale', pendingPrice: { proposedAt: iso(NOW - 10) } }), MSOL, { shares: '0', valueUsdc: '0' });
    assert.deepEqual(applyGates(snapshot, POLICY, NOW), { ok: true });
  });

  it('retirable but the unwind state is unknown: escalates instead of guessing', () => {
    const snapshot = { ...withLeg(withPool(fixture(), MSOL, { status: 'paused' }), MSOL, { shares: '0' }), pendingUnwinds: null };
    const found = only(applyGates(snapshot, POLICY, NOW), 'LEG_NOT_ACTIVE');
    assert.equal(found.action, 'escalate');
    assert.match(found.message, /unwind state is unknown/);
  });

  it('omitted with custody 0 but an unwind pending is not retirable: blocked', () => {
    const snapshot = { ...withLeg(withPool(fixture(), MSOL, { status: 'paused' }), MSOL, { shares: '0' }), pendingUnwinds: [MSOL] };
    assert.equal(only(applyGates(snapshot, POLICY, NOW), 'LEG_NOT_ACTIVE').action, 'blocked');
  });

  it('custody unknown (no holdings) never counts as zero: the omitted pool is still checked', () => {
    const snapshot = withPool(fixture(), MSOL, { status: 'paused' });
    snapshot.portfolioRow = { ...snapshot.portfolioRow, holdings: null };
    assert.equal(only(applyGates(snapshot, POLICY, NOW), 'LEG_NOT_ACTIVE').action, 'blocked');
  });

  it('LEG_PENDING_PRICE: a Pyth-cranked pool with a parked mark waits, 10 min to escalate', () => {
    const found = only(applyGates(withPool(fixture(), SOL, { pendingPrice: { proposedPrice: '1', previousPrice: '1', proposedAt: iso(NOW - 30) } }), POLICY, NOW), 'LEG_PENDING_PRICE');
    assert.equal(found.action, 'wait');
    assert.equal(found.source, 'pyth');
    assert.equal(found.escalateAfterSecs, 600);
  });

  it('LEG_PENDING_PRICE: a publisher-marked pool with a parked mark escalates at once', () => {
    const found = only(applyGates(withPool(fixture(), MSOL, { pendingPrice: { proposedPrice: '1', previousPrice: '1', proposedAt: iso(NOW - 30) } }), POLICY, NOW), 'LEG_PENDING_PRICE');
    assert.equal(found.action, 'escalate');
    assert.equal(found.source, 'publisher');
    assert.equal(found.escalateAfterSecs, 0);
  });

  it('strict per pool: the book says fresh (its tolerance) but the pool says pending_acceptance — still a blocker', () => {
    const snapshot = withPool(fixture(), JITO, { priceState: 'pending_acceptance', pendingPrice: null });
    assert.equal(snapshot.portfolioRow.priceState, 'fresh');
    const found = only(applyGates(snapshot, POLICY, NOW), 'LEG_PENDING_PRICE');
    assert.equal(found.poolId, JITO);
  });

  it('LEG_STALE: a stale pool mark waits for the keeper, 30 min to escalate', () => {
    const found = only(applyGates(withPool(fixture(), USDT, { priceState: 'stale' }), POLICY, NOW), 'LEG_STALE');
    assert.equal(found.action, 'wait');
    assert.equal(found.escalateAfterSecs, 1800);
  });

  it('LEG_STALE: no catalogue at all, or no row for a leg, is unknown and waits', () => {
    const noCatalogue = applyGates(fixture({ pools: null }), POLICY, NOW);
    assert.equal(noCatalogue.ok, false);
    assert.equal(noCatalogue.blockers.filter((entry) => entry.code === 'LEG_STALE').length, 4);
    assert.match(noCatalogue.blockers[0].message, /catalogue unavailable/);
    const snapshot = fixture();
    snapshot.pools = snapshot.pools.filter((row) => row.poolId !== JITO);
    assert.match(only(applyGates(snapshot, POLICY, NOW), 'LEG_STALE').message, /no catalogue row/);
  });

  it('BOOK_NOT_FRESH: the vault clock past max_price_staleness_secs waits (PortfolioPriceStale), no refresh while the keeper is ok', () => {
    const found = only(applyGates(fixture({ vaultAccount: { lastPriceUpdateTimestamp: bn(NOW - 4000) } }), POLICY, NOW), 'BOOK_NOT_FRESH');
    assert.equal(found.action, 'wait');
    assert.equal(found.escalateAfterSecs, 1800);
    assert.equal(found.ageSecs, 4000);
    assert.equal(found.refreshNav, false);
  });

  it('BOOK_NOT_FRESH: stale > 15 min past the window and the keeper down asks for one refresh-nav', () => {
    const snapshot = fixture({ vaultAccount: { lastPriceUpdateTimestamp: bn(NOW - 3600 - 901) }, health: { status: 'degraded', processes: { keeper: { status: 'error' } } } });
    assert.equal(only(applyGates(snapshot, POLICY, NOW), 'BOOK_NOT_FRESH').refreshNav, true);
    const unknownKeeper = fixture({ vaultAccount: { lastPriceUpdateTimestamp: bn(NOW - 3600 - 901) }, health: null });
    assert.equal(only(applyGates(unknownKeeper, POLICY, NOW), 'BOOK_NOT_FRESH').refreshNav, false);
  });

  it('BOOK_NOT_FRESH: the api row not fresh waits even when the vault clock is inside its window', () => {
    const found = only(applyGates(fixture({ portfolioRow: { priceState: 'stale' } }), POLICY, NOW), 'BOOK_NOT_FRESH');
    assert.match(found.message, /priceState is stale/);
  });

  it('BOOK_NOT_FRESH: no portfolio row at all is unknown, not fine', () => {
    const found = only(applyGates(fixture({ portfolioRow: null }), POLICY, NOW), 'BOOK_NOT_FRESH');
    assert.match(found.message, /row unavailable/);
  });

  it('BOOK_PENDING_PRICE: a parked book mark waits, 20 min to escalate', () => {
    const found = only(applyGates(fixture({ vaultAccount: { pendingPrice: { value: bn(1), timestamp: bn(NOW - 5) } } }), POLICY, NOW), 'BOOK_PENDING_PRICE');
    assert.equal(found.action, 'wait');
    assert.equal(found.escalateAfterSecs, 1200);
  });

  it('WITHDRAWALS_PENDING: queued withdrawals wait, 60 min without progress to escalate', () => {
    const found = only(applyGates(fixture({ vaultAccount: { totalWithdrawalsPending: bn(5) } }), POLICY, NOW), 'WITHDRAWALS_PENDING');
    assert.equal(found.action, 'wait');
    assert.equal(found.pendingShares, '5');
    assert.equal(found.escalateAfterSecs, 3600);
  });

  it('APPLY_IN_FLIGHT: apply_next_page != 0 waits 320 slots from the scratch start slot', () => {
    const found = only(applyGates(fixture({ portfolioAccount: { applyNextPage: 1 }, applyScratch: { startedSlot: bn(900) } }), POLICY, NOW, 1000), 'APPLY_IN_FLIGHT');
    assert.equal(found.action, 'wait');
    assert.equal(found.waitSlots, 220);
    assert.equal(found.waitSecs, 88);
    assert.equal(found.maxAttempts, 3);
    const noScratch = only(applyGates(fixture({ portfolioAccount: { applyNextPage: 2 } }), POLICY, NOW), 'APPLY_IN_FLIGHT');
    assert.equal(noScratch.waitSlots, 320);
    const elapsed = only(applyGates(fixture({ portfolioAccount: { applyNextPage: 1 }, applyScratch: { startedSlot: bn(100) } }), POLICY, NOW, 1000), 'APPLY_IN_FLIGHT');
    assert.equal(elapsed.waitSlots, 0);
  });

  it('APPLY_IN_FLIGHT: a policy wait under the chain constant (300) is raised to it', () => {
    const lax = { ...POLICY, apply: { ...POLICY.apply, applyInFlightWaitSlots: 100 } };
    assert.equal(only(applyGates(fixture({ portfolioAccount: { applyNextPage: 1 } }), lax, NOW), 'APPLY_IN_FLIGHT').waitSlots, 301);
  });

  it('MISSING_CUSTODY: a new pool without its custody ATA waits for the create_custody retry', () => {
    const found = only(applyGates(fixture({ custody: { [JITO]: false, [SOL]: true } }), POLICY, NOW), 'MISSING_CUSTODY');
    assert.equal(found.action, 'wait');
    assert.equal(found.retries, 1);
    assert.deepEqual(applyGates(fixture({ custody: { [JITO]: true } }), POLICY, NOW), { ok: true });
  });

  it('collects every blocker in evaluation order', () => {
    const snapshot = withPool(fixture({ vaultAccount: { paused: true, totalWithdrawalsPending: bn(1), pendingPrice: { value: bn(1), timestamp: bn(NOW) } } }), USDT, { priceState: 'stale' });
    assert.deepEqual(codes(applyGates(snapshot, POLICY, NOW)), ['VAULT_PAUSED', 'LEG_STALE', 'BOOK_PENDING_PRICE', 'WITHDRAWALS_PENDING']);
  });

  it('falls back to escalation defaults when the policy carries no table', () => {
    const found = only(applyGates(withPool(fixture(), USDT, { priceState: 'stale' }), { apply: {} }, NOW), 'LEG_STALE');
    assert.equal(found.escalateAfterSecs, 1800);
  });
});

describe('proposeGates', () => {
  const clear = (overrides = {}) => fixture({ portfolioAccount: { pendingTargets: null, ...overrides } });

  it('passes a live, unlocked portfolio with nothing pending and the delay elapsed', () => {
    assert.deepEqual(proposeGates(clear(), POLICY, NOW), { ok: true });
  });

  it('COMPOSITION_LOCKED', () => {
    assert.equal(only(proposeGates(clear({ compositionLocked: true }), POLICY, NOW), 'COMPOSITION_LOCKED').action, 'blocked');
  });

  it('WRONG_PORTFOLIO_STATE: an Anchor enum or an api string that is not live', () => {
    assert.equal(only(proposeGates(clear({ state: { draft: {} } }), POLICY, NOW), 'WRONG_PORTFOLIO_STATE').state, 'draft');
    assert.equal(only(proposeGates(clear({ state: 'sharesReady' }), POLICY, NOW), 'WRONG_PORTFOLIO_STATE').state, 'sharesReady');
  });

  it('TARGETS_PENDING: one change at a time', () => {
    const found = only(proposeGates(fixture(), POLICY, NOW), 'TARGETS_PENDING');
    assert.equal(found.action, 'blocked');
    assert.equal(found.effectiveAt, EFFECTIVE);
  });

  it('REBALANCE_TOO_SOON: now − last_rebalance_at < rebalance_delay_secs', () => {
    const found = only(proposeGates(clear({ lastRebalanceAt: bn(NOW - 100) }), POLICY, NOW), 'REBALANCE_TOO_SOON');
    assert.equal(found.readyAt, NOW - 100 + 86400);
    assert.deepEqual(proposeGates(clear({ lastRebalanceAt: bn(NOW - 86400) }), POLICY, NOW), { ok: true });
  });

  it('APPLY_IN_FLIGHT and VAULT_PAUSED block a proposal too', () => {
    assert.equal(only(proposeGates(clear({ applyNextPage: 1 }), POLICY, NOW), 'APPLY_IN_FLIGHT').action, 'blocked');
    assert.equal(only(proposeGates(fixture({ portfolioAccount: { pendingTargets: null }, vaultAccount: { paused: true } }), POLICY, NOW), 'VAULT_PAUSED').action, 'blocked');
  });

  it('reports in validate_proposal order', () => {
    const result = proposeGates(fixture({ portfolioAccount: { compositionLocked: true, lastRebalanceAt: bn(NOW - 1) } }), POLICY, NOW);
    assert.deepEqual(codes(result), ['COMPOSITION_LOCKED', 'TARGETS_PENDING', 'REBALANCE_TOO_SOON']);
  });
});

describe('checkInvariants', () => {
  it('passes the expected curator, no pending curator, 24 h delay, unlocked, treasury and guardian', () => {
    assert.deepEqual(checkInvariants(fixture(), CONFIG, POLICY), { ok: true, unverified: [] });
  });

  const drifted = (snapshot, invariant) => {
    const result = checkInvariants(snapshot, CONFIG, POLICY);
    assert.equal(result.ok, false);
    const entry = result.drift.find((row) => row.invariant === invariant);
    assert.ok(entry, `expected drift on ${invariant}, got ${JSON.stringify(result.drift)}`);
    return entry;
  };

  it('INVARIANT_DRIFT: curator moved', () => {
    const other = key();
    const entry = drifted(fixture({ portfolioAccount: { curator: other } }), 'portfolio.curator');
    assert.equal(entry.expected, CURATOR.toBase58());
    assert.equal(entry.actual, other.toBase58());
  });

  it('INVARIANT_DRIFT: a curator transfer is pending', () => {
    drifted(fixture({ portfolioAccount: { pendingCurator: key() } }), 'portfolio.pendingCurator');
  });

  it('INVARIANT_DRIFT: rebalance delay shortened', () => {
    const entry = drifted(fixture({ portfolioAccount: { rebalanceDelaySecs: bn(3600) } }), 'portfolio.rebalanceDelaySecs');
    assert.equal(entry.expected, '86400');
    assert.equal(entry.actual, '3600');
  });

  it('INVARIANT_DRIFT: composition locked', () => {
    drifted(fixture({ portfolioAccount: { compositionLocked: true } }), 'portfolio.compositionLocked');
  });

  it('INVARIANT_DRIFT: fee recipient is not the treasury', () => {
    drifted(fixture({ accountantAccount: { recipient1: key() } }), 'accountant.recipient1');
  });

  it('INVARIANT_DRIFT: guardian changed', () => {
    drifted(fixture({ factoryConfig: { guardian: key() } }), 'factory.guardian');
  });

  it('an unreadable optional account is unverified, not drift', () => {
    const result = checkInvariants(fixture({ accountantAccount: null, factoryConfig: null }), CONFIG, POLICY);
    assert.deepEqual(result, { ok: true, unverified: ['accountant.recipient1', 'factory.guardian'] });
  });
});

describe('readSnapshot', () => {
  const accounts = (snapshot) => ({
    'portfolio_factory.Portfolio': snapshot.portfolioAccount,
    'stoken.VaultConfig': snapshot.vaultAccount,
    'accountant.Accountant': snapshot.accountantAccount,
    'portfolio_factory.FactoryConfig': snapshot.factoryConfig,
    'portfolio_factory.ApplyScratch': { startedSlot: bn(900), nextPage: 1 },
  });

  function fakeCtx(snapshot, { failing = new Set(), apiDown = false } = {}) {
    const reads = [];
    const logs = [];
    const table = accounts(snapshot);
    const lib = {
      fetchDecoded: async (connection, program, account, pubkey) => {
        reads.push(`${program}.${account}`);
        if (failing.has(`${program}.${account}`)) throw new Error(`rpc: ${account}`);
        assert.ok(pubkey, `${account} needs a key`);
        return table[`${program}.${account}`] ?? null;
      },
      factoryConfigKey: () => key(),
      applyScratchPda: (portfolio) => { assert.ok(portfolio instanceof PublicKey); return key(); },
      associatedTokenAddress: (mint, owner) => { assert.ok(mint instanceof PublicKey && owner instanceof PublicKey); return key(); },
      tokenBalanceMany: async () => [123n, 456n],
    };
    const connection = {
      getSlot: async () => 4321,
      getBalance: async (pubkey) => { assert.ok(pubkey instanceof PublicKey); return 250_000_000; },
    };
    const down = () => { throw new Error('ECONNREFUSED'); };
    const client = apiDown
      ? { portfolio: down, pools: down, health: down }
      : { portfolio: async () => snapshot.portfolioRow, pools: async () => snapshot.pools, health: async () => snapshot.health };
    return {
      ctx: {
        signer: { wallet: CURATOR.toBase58(), kind: 'curator' },
        client,
        chain: { connection, lib, programs: new Set(), lookupTables: new Set(), idls: {} },
        config: { mint: MINT.toBase58() },
        state: {},
        now: () => NOW * 1000,
        log: (level, event, fields) => logs.push({ level, event, fields }),
      },
      reads,
      logs,
    };
  }

  it('builds the §4.2 snapshot from the fakes and caches the account keys', async () => {
    const source = fixture();
    const { ctx, reads } = fakeCtx(source);
    const snapshot = await readSnapshot(ctx);
    assert.equal(snapshot.at, NOW);
    assert.equal(snapshot.slot, 4321);
    assert.equal(snapshot.portfolioRow, source.portfolioRow);
    assert.equal(snapshot.portfolioAccount, source.portfolioAccount);
    assert.equal(snapshot.vaultAccount, source.vaultAccount);
    assert.equal(snapshot.accountantAccount, source.accountantAccount);
    assert.equal(snapshot.factoryConfig, source.factoryConfig);
    assert.equal(snapshot.applyScratch, null);
    assert.equal(snapshot.pools, source.pools);
    assert.equal(snapshot.health, source.health);
    assert.equal(snapshot.pendingUnwinds, null);
    assert.deepEqual(snapshot.signer, { lamports: 250_000_000, usdcBaseUnits: '123', shares: '456' });
    assert.deepEqual(ctx.state.snapshotKeys, { portfolio: PORTFOLIO.toBase58(), vaultKey: VAULT.toBase58(), accountant: ACCOUNTANT.toBase58() });
    assert.ok(!reads.includes('portfolio_factory.ApplyScratch'));
    assert.deepEqual(applyGates(snapshot, POLICY, NOW), { ok: true });
  });

  it('reads the apply scratch only while a paged apply is in flight', async () => {
    const { ctx, reads } = fakeCtx(fixture({ portfolioAccount: { applyNextPage: 1 } }));
    const snapshot = await readSnapshot(ctx);
    assert.ok(reads.includes('portfolio_factory.ApplyScratch'));
    assert.equal(only(applyGates(snapshot, POLICY, NOW, 1000), 'APPLY_IN_FLIGHT').waitSlots, 220);
  });

  it('api down with nothing cached is a tick error; with cached keys the chain half still reads', async () => {
    const source = fixture();
    const cold = fakeCtx(source, { apiDown: true });
    await assert.rejects(readSnapshot(cold.ctx), /keys unknown/);
    const warm = fakeCtx(source, { apiDown: true });
    warm.ctx.state.snapshotKeys = { portfolio: PORTFOLIO.toBase58(), vaultKey: VAULT.toBase58(), accountant: ACCOUNTANT.toBase58() };
    const snapshot = await readSnapshot(warm.ctx);
    assert.equal(snapshot.portfolioRow, null);
    assert.equal(snapshot.pools, null);
    assert.equal(snapshot.health, null);
    assert.equal(snapshot.portfolioAccount, source.portfolioAccount);
    assert.ok(warm.logs.some((entry) => entry.event === 'snapshot_read_failed' && entry.fields.read === 'portfolio'));
    assert.match(only(applyGates(snapshot, POLICY, NOW), 'BOOK_NOT_FRESH').message, /row unavailable/);
  });

  it('a failed optional read is null and logged; a failed required read throws', async () => {
    const soft = fakeCtx(fixture(), { failing: new Set(['accountant.Accountant']) });
    const snapshot = await readSnapshot(soft.ctx);
    assert.equal(snapshot.accountantAccount, null);
    assert.ok(soft.logs.some((entry) => entry.fields.read === 'accountant'));
    assert.deepEqual(checkInvariants(snapshot, CONFIG, POLICY), { ok: true, unverified: ['accountant.recipient1'] });
    const hard = fakeCtx(fixture(), { failing: new Set(['stoken.VaultConfig']) });
    await assert.rejects(readSnapshot(hard.ctx), /rpc: VaultConfig/);
    const missing = fakeCtx({ ...fixture(), portfolioAccount: null });
    await assert.rejects(readSnapshot(missing.ctx), /Portfolio account unreadable/);
  });
});
