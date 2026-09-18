/**
 * The review brief and its wake triggers: a fixture row per trigger, a quiet
 * day that must not wake the agent, the vocabulary rules on the brief (percent
 * and USD, never base units or "bps", JSON wake line last), a hold reason
 * that reads the same on two quiet days, and the Prometheus exposition.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deltaCostBps, deriveReview, isMonthlyReviewDay, renderPrometheus } from '../src/metrics.js';

const DAY = 86400;
/** Friday 11 Sep 2026 09:00 UTC — the review hour on a day that is nobody's first Monday. */
const NOW = Math.floor(Date.UTC(2026, 8, 11, 9, 0, 0) / 1000);
/** Monday 7 Sep 2026 — the first Monday of that month. */
const FIRST_MONDAY = Math.floor(Date.UTC(2026, 8, 7, 9, 0, 0) / 1000);
const iso = (unixSecs) => new Date(unixSecs * 1000).toISOString();

const SOL = 'pSOL@solana';
const USDT = 'pUSDT@solana';
const MSOL = 'pMSOL@solana';

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

const POOLS = () => [pool(SOL, 'pSOL'), pool(USDT, 'pUSDT', { maxExecutionLossBps: 20 }), pool(MSOL, 'pMSOL', { pythFeedId: null, maxExecutionLossBps: 30 })];

/** A live book worth $1,000: pSOL +1 % over, pUSDT 1 % under (inside the 2 % band), pMSOL 5 % under (needs inflow). */
const ROW = (extra = {}) => ({
  mint: 'WEAVRmint',
  symbol: 'WEAVR',
  state: 'live',
  priceState: 'fresh',
  priceAsOf: iso(NOW - 60),
  price: '1000000',
  tvlUsdc: '1000000000',
  totalShares: '1000000000',
  withdrawalsPending: '0',
  pendingPrice: null,
  pendingTargets: null,
  driftBandBps: 200,
  idleTargetBps: 500,
  targets: [{ poolId: SOL, weightBps: 4000 }, { poolId: USDT, weightBps: 4000 }, { poolId: MSOL, weightBps: 2000 }],
  holdings: {
    legs: [
      { poolId: SOL, symbol: 'pSOL', targetWeightBps: 4000, weightBps: 4100, valueUsdc: '410000000', shares: '400000000' },
      { poolId: USDT, symbol: 'pUSDT', targetWeightBps: 4000, weightBps: 3900, valueUsdc: '390000000', shares: '390000000' },
      { poolId: MSOL, symbol: 'pMSOL', targetWeightBps: 2000, weightBps: 1500, valueUsdc: '150000000', shares: '140000000' },
    ],
    idleWeightBps: 500,
  },
  returns: { '30d': { portfolio: 3.2, btc: 5.1 } },
  ...extra,
});

const HEALTH = () => ({ status: 'ok', processes: { keeper: { status: 'ok' } } });

const STATUS = (extra = {}) => ({
  paused: false,
  selfLocked: null,
  apply: { state: 'IDLE' },
  portfolio: { lastRebalanceAt: NOW - 12 * DAY },
  ledger: { proposalsLast30d: 1, depositsTodayUsd: 0, withdrawalsTodayUsd: 0 },
  policy: { version: 1 },
  ...extra,
});

const lastLine = (brief) => brief.slice(brief.lastIndexOf('\n') + 1);
const codesOf = (review) => review.triggers.map((trigger) => trigger.code);

describe('deriveReview — a quiet day', () => {
  const review = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), {}, NOW);

  it('does not wake the agent', () => {
    assert.equal(review.wakeAgent, false);
    assert.deepEqual(review.triggers, []);
    assert.match(review.holdReason, /^HOLD: /);
  });

  it('ends the brief with the wake-gate JSON and stays under 4 KB', () => {
    assert.equal(lastLine(review.brief), '{"wakeAgent":false}');
    assert.deepEqual(JSON.parse(lastLine(review.brief)), { wakeAgent: false });
    assert.ok(review.brief.length <= 4096);
  });

  it('speaks weavr: percent and USD, no base units, no "bps"', () => {
    assert.doesNotMatch(review.brief, /bps/i);
    assert.doesNotMatch(review.brief, /base units/i);
    assert.doesNotMatch(review.brief, /410000000|1000000000/);
    assert.match(review.brief, /\$1,000\.00 across 3 assets/);
    assert.match(review.brief, /pMSOL: 15% of 20% target \(-5%\), \$150\.00, active — needs inflow, 1 review running/);
    assert.match(review.brief, /pSOL: 41% of 40% target \(\+1%\), \$410\.00, active — inside band/);
    assert.match(review.brief, /30-day return: \+3\.2% \(BTC \+5\.1%\)/);
    assert.match(review.brief, /portfolio|Portfolio/);
    assert.match(review.brief, /Triggers: none\. HOLD:/);
  });

  it('accepts the README five-argument form', () => {
    const legacy = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), NOW);
    assert.equal(legacy.wakeAgent, false);
    assert.equal(lastLine(legacy.brief), '{"wakeAgent":false}');
  });

  it('derives the per-asset and book metrics', () => {
    const { metrics } = review;
    const msol = metrics.legs.find((leg) => leg.poolId === MSOL);
    assert.equal(msol.actualPct, 15);
    assert.equal(msol.targetPct, 20);
    assert.equal(msol.driftPct, -5);
    assert.equal(msol.needsInflow, true);
    assert.equal(msol.selfHealing, false);
    const sol = metrics.legs.find((leg) => leg.poolId === SOL);
    assert.equal(sol.driftPct, 1);
    assert.equal(sol.needsInflow, false);
    assert.equal(sol.selfHealing, false);
    assert.equal(metrics.maxDriftPct, 5);
    assert.equal(metrics.bandPct, 2);
    assert.equal(metrics.idlePct, 5);
    assert.equal(metrics.idleTargetPct, 5);
    assert.equal(metrics.navUsd, 1000);
    assert.equal(metrics.navFreshAgeSecs, 60);
    assert.equal(metrics.withdrawalsPendingUsd, 0);
    assert.equal(metrics.capHeadroomPct, null);
    assert.equal(metrics.quietDays, 12);
    assert.equal(metrics.inputsComplete, true);
    assert.equal(metrics.return30dPct, 3.2);
    assert.deepEqual(metrics.driftStreak, { [SOL]: 0, [USDT]: 0, [MSOL]: 1 });
    assert.deepEqual(metrics.riskTiers, { [SOL]: 2, [USDT]: 2, [MSOL]: 2 });
    // Closing all drift: |1|×50 + |−1|×20 + |−5|×30 = 220 bps-weight × loss / 10000 → 2.2 bps.
    assert.equal(metrics.healCostBps, 2.2);
  });

  it('a keeper-trimmable overweight is self-healing; an unknown value is neither', () => {
    const row = ROW();
    row.holdings.legs[0] = { ...row.holdings.legs[0], weightBps: 4500 };
    row.holdings.legs[1] = { ...row.holdings.legs[1], weightBps: null, valueUsdc: null };
    const { metrics } = deriveReview(row, POOLS(), HEALTH(), STATUS(), {}, NOW);
    assert.equal(metrics.legs[0].selfHealing, true);
    assert.equal(metrics.legs[1].driftPct, null);
    assert.equal(metrics.legs[1].needsInflow, false);
    assert.equal(metrics.legs[1].selfHealing, false);
  });

  it('cap headroom and pending withdrawals come from vault numbers and the share price', () => {
    // 6-decimal shares at a $1.00 mark: 1e9 shares of headroom under a 2e9 cap is $1,000 and 50 %.
    const status = STATUS({ vault: { maxTotalShares: '2000000000', totalShares: '1000000000' } });
    const { metrics } = deriveReview(ROW({ withdrawalsPending: '2000000' }), POOLS(), HEALTH(), status, {}, NOW);
    assert.equal(metrics.capHeadroomPct, 50);
    assert.equal(metrics.capHeadroomUsd, 1000);
    assert.equal(metrics.withdrawalsPendingUsd, 2);
  });

  it('inputs are incomplete when a held pool lacks a yield, a TVL or a tier', () => {
    const pools = POOLS().map((row) => (row.poolId === USDT ? { ...row, trailingYieldBps: null } : row));
    const review = deriveReview(ROW(), pools, HEALTH(), STATUS(), {}, NOW);
    assert.equal(review.metrics.inputsComplete, false);
    assert.match(review.brief, /Inputs complete: no/);
    assert.match(review.holdReason, /inputs incomplete/);
  });

  it('keeps the hold reason identical across two quiet days with different numbers', () => {
    const today = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), {}, NOW);
    const row = ROW({ tvlUsdc: '1234567000', priceAsOf: iso(NOW + DAY - 300) });
    row.holdings.legs[2] = { ...row.holdings.legs[2], weightBps: 1400, valueUsdc: '140000000' };
    const tomorrow = deriveReview(row, POOLS(), HEALTH(), STATUS({ portfolio: { lastRebalanceAt: NOW - 13 * DAY } }), {}, NOW + DAY);
    assert.notEqual(today.brief, tomorrow.brief);
    assert.equal(today.holdReason, tomorrow.holdReason);
  });

  it('a pending change and a paused signer show in the hold reason', () => {
    const row = ROW({ pendingTargets: { targets: [], proposedAt: iso(NOW - 3600), effectiveAt: iso(NOW + 82800) } });
    const review = deriveReview(row, POOLS(), HEALTH(), STATUS({ paused: true }), {}, NOW);
    assert.match(review.holdReason, /signer paused; a rebalance is announced/);
    assert.match(review.brief, /Pending: rebalance announced 2026-09-11 08:00 UTC, applies 2026-09-12 08:00 UTC/);
  });

  it('caps a brief for a wide book at 4 KB with the JSON line intact', () => {
    const legs = Array.from({ length: 60 }, (_, index) => ({
      poolId: `pPOOL${index}@solana`, symbol: `pPOOL${index}`, targetWeightBps: 166, weightBps: 166, valueUsdc: '1660000', shares: '1660000',
    }));
    const pools = legs.map((leg) => pool(leg.poolId, leg.symbol));
    const review = deriveReview(ROW({ holdings: { legs, idleWeightBps: 40 } }), pools, HEALTH(), STATUS(), {}, NOW);
    assert.ok(review.brief.length <= 4096, `brief is ${review.brief.length}`);
    assert.equal(lastLine(review.brief), '{"wakeAgent":false}');
  });
});

describe('deriveReview — triggers', () => {
  it('MONTHLY_REVIEW on the first Monday only', () => {
    assert.equal(isMonthlyReviewDay(FIRST_MONDAY), true);
    assert.equal(isMonthlyReviewDay(FIRST_MONDAY + 7 * DAY), false);
    assert.equal(isMonthlyReviewDay(NOW), false);
    const review = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), {}, FIRST_MONDAY);
    assert.deepEqual(codesOf(review), ['MONTHLY_REVIEW']);
    assert.equal(review.wakeAgent, true);
    assert.equal(lastLine(review.brief), '{"wakeAgent":true}');
    assert.equal(review.holdReason, '');
    assert.match(review.brief, /Triggers: MONTHLY_REVIEW/);
    const secondMonday = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), {}, FIRST_MONDAY + 7 * DAY);
    assert.equal(secondMonday.wakeAgent, false);
  });

  it('LEG_NEEDS_INFLOW needs all three: ≥ 3 reviews under target, no deposit for 7 d, budget spent', () => {
    const notepad = { drift_streak: JSON.stringify({ [MSOL]: 2 }), last_inflow_at: String(NOW - 8 * DAY), topup_budget_spent: '1' };
    const review = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), notepad, NOW);
    assert.deepEqual(codesOf(review), ['LEG_NEEDS_INFLOW']);
    assert.match(review.triggers[0].detail, /pMSOL -5% under target for 3 reviews, no deposit for 8 d, top-up budget spent/);
    assert.deepEqual(review.metrics.driftStreak, { [SOL]: 0, [USDT]: 0, [MSOL]: 3 });

    const shortStreak = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { ...notepad, drift_streak: JSON.stringify({ [MSOL]: 1 }) }, NOW);
    assert.equal(shortStreak.wakeAgent, false);
    const recentInflow = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { ...notepad, last_inflow_at: iso(NOW - 2 * DAY) }, NOW);
    assert.equal(recentInflow.wakeAgent, false);
    const budgetLeft = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { ...notepad, topup_budget_spent: '0' }, NOW);
    assert.equal(budgetLeft.wakeAgent, false);
  });

  it('LEG_NEEDS_INFLOW: an inflow date unknown counts as none, and a streak resets when the asset heals', () => {
    const notepad = { drift_streak: JSON.stringify({ [MSOL]: 5 }), topup_budget_spent: 'true' };
    assert.deepEqual(codesOf(deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), notepad, NOW)), ['LEG_NEEDS_INFLOW']);
    const healed = ROW();
    healed.holdings.legs[2] = { ...healed.holdings.legs[2], weightBps: 1950, valueUsdc: '195000000' };
    const review = deriveReview(healed, POOLS(), HEALTH(), STATUS(), notepad, NOW);
    assert.equal(review.wakeAgent, false);
    assert.equal(review.metrics.driftStreak[MSOL], 0);
  });

  it('HELD_POOL_NOT_ACTIVE: a held pool paused, or missing from the catalogue', () => {
    const paused = POOLS().map((row) => (row.poolId === SOL ? { ...row, status: 'paused' } : row));
    const review = deriveReview(ROW(), paused, HEALTH(), STATUS(), {}, NOW);
    assert.deepEqual(codesOf(review), ['HELD_POOL_NOT_ACTIVE']);
    assert.match(review.triggers[0].detail, /pSOL is paused/);
    const missing = deriveReview(ROW(), POOLS().filter((row) => row.poolId !== USDT), HEALTH(), STATUS(), {}, NOW);
    assert.deepEqual(codesOf(missing), ['HELD_POOL_NOT_ACTIVE']);
    assert.match(missing.triggers[0].detail, /pUSDT is missing from the catalogue/);
  });

  it('PUBLISHER_PARK: a held mark parked longer than 6 h, or the book mark itself', () => {
    const parked = (hours) => POOLS().map((row) => (row.poolId === MSOL ? { ...row, priceState: 'pending_acceptance', pendingPrice: { proposedPrice: '1', previousPrice: '1', proposedAt: iso(NOW - hours * 3600) } } : row));
    const review = deriveReview(ROW(), parked(7), HEALTH(), STATUS(), {}, NOW);
    assert.deepEqual(codesOf(review), ['PUBLISHER_PARK']);
    assert.match(review.triggers[0].detail, /pMSOL mark parked 7 h \(publisher-marked/);
    assert.equal(deriveReview(ROW(), parked(1), HEALTH(), STATUS(), {}, NOW).wakeAgent, false);
    const book = deriveReview(ROW({ priceState: 'pending_acceptance', pendingPrice: { proposedAt: iso(NOW - 9 * 3600) } }), POOLS(), HEALTH(), STATUS(), {}, NOW);
    assert.deepEqual(codesOf(book), ['PUBLISHER_PARK']);
    assert.match(book.triggers[0].detail, /portfolio's own mark is parked 9 h/);
  });

  it('DRAWDOWN_30D: a 30-day return under −35 %', () => {
    const review = deriveReview(ROW({ returns: { '30d': { portfolio: -40.5, btc: -20 } } }), POOLS(), HEALTH(), STATUS(), {}, NOW);
    assert.deepEqual(codesOf(review), ['DRAWDOWN_30D']);
    assert.match(review.triggers[0].detail, /-40\.5% is under -35%/);
    assert.equal(deriveReview(ROW({ returns: { '30d': { portfolio: -10 } } }), POOLS(), HEALTH(), STATUS(), {}, NOW).wakeAgent, false);
    assert.equal(deriveReview(ROW({ returns: { '30d': null } }), POOLS(), HEALTH(), STATUS(), {}, NOW).wakeAgent, false);
  });

  it('RISK_TIER_RAISED: a held pool tier above the one the notepad stored', () => {
    const notepad = { risk_tiers: JSON.stringify({ [SOL]: 1, [USDT]: 2 }) };
    const review = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), notepad, NOW);
    assert.deepEqual(codesOf(review), ['RISK_TIER_RAISED']);
    assert.match(review.triggers[0].detail, /pSOL risk tier 1 → 2/);
    assert.equal(deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { risk_tiers: JSON.stringify({ [SOL]: 2 }) }, NOW).wakeAgent, false);
    assert.equal(deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { risk_tiers: JSON.stringify({ [SOL]: 3 }) }, NOW).wakeAgent, false);
  });

  it('OPERATOR_REQUEST: a notepad or status flag', () => {
    const fromNotepad = deriveReview(ROW(), POOLS(), HEALTH(), STATUS(), { operator_request: 'look at pUSDT yield' }, NOW);
    assert.deepEqual(codesOf(fromNotepad), ['OPERATOR_REQUEST']);
    assert.equal(fromNotepad.triggers[0].detail, 'look at pUSDT yield');
    const fromStatus = deriveReview(ROW(), POOLS(), HEALTH(), STATUS({ operatorRequest: 'review now' }), {}, NOW);
    assert.deepEqual(codesOf(fromStatus), ['OPERATOR_REQUEST']);
  });

  it('several triggers fire together and every one reaches the brief', () => {
    const pools = POOLS().map((row) => (row.poolId === SOL ? { ...row, status: 'retired' } : row));
    const review = deriveReview(ROW({ returns: { '30d': { portfolio: -50 } } }), pools, HEALTH(), STATUS(), { operator_request: 'x' }, FIRST_MONDAY);
    assert.deepEqual(codesOf(review), ['MONTHLY_REVIEW', 'HELD_POOL_NOT_ACTIVE', 'DRAWDOWN_30D', 'OPERATOR_REQUEST']);
    for (const code of codesOf(review)) assert.match(review.brief, new RegExp(code));
    assert.equal(lastLine(review.brief), '{"wakeAgent":true}');
  });

  it('thresholds come from status.policy.review when the verb passes them', () => {
    const status = STATUS({ policy: { version: 1, review: { drawdown30dPct: -2 } } });
    assert.deepEqual(codesOf(deriveReview(ROW({ returns: { '30d': { portfolio: -3 } } }), POOLS(), HEALTH(), status, {}, NOW)), ['DRAWDOWN_30D']);
  });
});

describe('deltaCostBps', () => {
  it('sums |Δw| × maxExecutionLossBps / 10000 over the union of current and candidate', () => {
    // pSOL 4000→5000 ×50, pUSDT 4000→3000 ×20, pMSOL 2000→0 ×30, pJITOSOL 0→2000 ×(fallback 100)
    const candidate = [{ poolId: SOL, weightBps: 5000 }, { poolId: USDT, weightBps: 3000 }, { poolId: 'pJITOSOL@solana', weightBps: 2000 }];
    assert.equal(deltaCostBps(ROW(), POOLS(), candidate), 5 + 2 + 6 + 20);
    assert.equal(deltaCostBps(ROW(), POOLS(), ROW().targets), 0);
    assert.equal(deltaCostBps({}, POOLS(), candidate), null);
  });
});

describe('renderPrometheus', () => {
  it('exposes every gauge, the apply state as a 1-of-N label, booleans as 0/1 and unknowns as 0', () => {
    const text = renderPrometheus({
      lastTickTs: 1_800_000_000,
      hermesHeartbeatTs: null,
      pendingEffectiveAt: 1_800_086_400,
      applyState: 'WAIT_NOTICE',
      bookPriceFresh: true,
      signerLamports: 250_000_000,
      selfLocked: false,
      paused: true,
      writeAttempts1h: 3,
    });
    assert.match(text, /^# TYPE curator_last_tick_ts gauge$/m);
    assert.match(text, /^curator_last_tick_ts 1800000000$/m);
    assert.match(text, /^curator_hermes_heartbeat_ts 0$/m);
    assert.match(text, /^curator_pending_effective_at 1800086400$/m);
    assert.match(text, /^curator_apply_state\{state="WAIT_NOTICE"\} 1$/m);
    assert.match(text, /^curator_apply_state\{state="IDLE"\} 0$/m);
    assert.match(text, /^curator_book_price_fresh 1$/m);
    assert.match(text, /^curator_signer_lamports 250000000$/m);
    assert.match(text, /^curator_self_locked 0$/m);
    assert.match(text, /^curator_paused 1$/m);
    assert.match(text, /^curator_write_attempts_1h 3$/m);
    assert.ok(text.endsWith('\n'));
    for (const name of ['curator_last_tick_ts', 'curator_hermes_heartbeat_ts', 'curator_pending_effective_at', 'curator_apply_state', 'curator_book_price_fresh', 'curator_signer_lamports', 'curator_self_locked', 'curator_paused', 'curator_write_attempts_1h']) {
      assert.match(text, new RegExp(`^# HELP ${name} `, 'm'));
    }
  });

  it('renders with no gauges at all', () => {
    const text = renderPrometheus();
    assert.match(text, /^curator_apply_state\{state="IDLE"\} 0$/m);
    assert.match(text, /^curator_paused 0$/m);
  });
});
