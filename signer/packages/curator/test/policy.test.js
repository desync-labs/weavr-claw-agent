/**
 * policy.js — one planted violation per refusal code (plan §4.4, README §3).
 *
 * Every fixture here is a fake: pool rows shaped like `GET /v1/pools`, a
 * portfolio row shaped like `GET /v1/portfolios/:mint`, chain accounts with
 * the `BN` / `PublicKey` values `fetchDecoded` returns. Nothing touches the
 * network. The happy path is asserted once per function so a refusal test
 * that passes because *everything* is refused cannot hide.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import {
  MIN_OUT_TOLERANCE_BPS,
  evaluateDeposit,
  evaluateInvariants,
  evaluateProposal,
  evaluateWithdraw,
  evaluateWrite,
  loadPolicy,
  toSecs,
  verbAllowed,
} from '../src/policy.js';

const { BN } = anchor;
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, 'fixtures/policy.v1.json');
const policyJson = readFileSync(FIXTURE, 'utf8');
const policy = loadPolicy(policyJson);
const fresh = () => JSON.parse(policyJson);

const DAY = 86_400;
// Friday 11 Sep 2026 09:00:00 UTC — inside the 08:00–12:00 propose window.
const NOW_MS = Date.UTC(2026, 8, 11, 9, 0, 0);
const NOW = NOW_MS / 1000;
const atUtc = (hour, minute = 0, second = 0) => Date.UTC(2026, 8, 11, hour, minute, second);

const MINT = PublicKey.unique().toBase58();
const CURATOR = PublicKey.unique().toBase58();
const TREASURY = PublicKey.unique().toBase58();
const GUARDIAN = PublicKey.unique().toBase58();

const id = (symbol) => `pool-${symbol}`;
const pool = (symbol, overrides = {}) => ({
  poolId: id(symbol),
  symbol,
  chain: 'solana',
  status: 'active',
  priceState: 'fresh',
  pendingPrice: null,
  tvlUsdc: '1000000000000',
  riskTier: 2,
  maxWeightBps: 4000,
  maxExecutionLossBps: 30,
  trailingYieldBps: 500,
  pythFeedId: `feed-${symbol}`,
  ...overrides,
});
const ALLOWLIST = policy.universe.allowlist;
const basePools = () => [
  ...ALLOWLIST.map((symbol) => pool(symbol)),
  pool('pETH'), // solana, active, priced — but not allowlisted
  pool('pWSTETH', { chain: 'ethereum' }),
  pool('pSYRUPUSDC', { pythFeedId: null }),
];
/** The base catalogue with one row changed. */
const withPool = (symbol, overrides) => basePools().map((row) => (row.symbol === symbol ? { ...row, ...overrides } : row));
const allPools = (overrides) => basePools().map((row) => ({ ...row, ...overrides }));

const HELD = [['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 2500], ['pUSDT', 2000]];
const targets = (...pairs) => pairs.map(([symbol, weightBps]) => ({ poolId: id(symbol), weightBps }));
const VALID = targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 2000], ['pUSDT', 2000], ['pINF', 500]);

const bn = (value) => new BN(String(value));
const vault = (overrides = {}) => ({
  totalShares: bn('10000000000'),
  totalIdle: bn('100000000'),
  totalWithdrawalsPending: bn(0),
  maxTotalShares: bn('2000000000000'),
  maxSharesPerUser: bn('500000000000'),
  maxTotalIdle: bn('200000000000'),
  pendingPrice: null,
  paused: false,
  price: bn('1000000'),
  lastPriceUpdateTimestamp: bn(NOW - 60),
  maxPriceStalenessSecs: bn(3600),
  depositFeeBps: 20,
  withdrawFeeBps: 20,
  ...overrides,
});
const row = (overrides = {}) => ({
  mint: MINT,
  symbol: 'WEAVR',
  state: 'active',
  priceState: 'fresh',
  pendingPrice: null,
  withdrawalsPending: '0',
  pendingTargets: null,
  holdings: {
    legs: HELD.map(([symbol, targetWeightBps]) => ({ poolId: id(symbol), symbol, targetWeightBps, weightBps: targetWeightBps, valueUsdc: '1' })),
    idleWeightBps: 0,
  },
  targets: targets(...HELD),
  positions: HELD.map(([symbol]) => id(symbol)),
  curator: CURATOR,
  rebalanceDelaySecs: 86_400,
  compositionLocked: false,
  ...overrides,
});
const account = (overrides = {}) => ({
  curator: new PublicKey(CURATOR),
  pendingCurator: null,
  compositionLocked: false,
  rebalanceDelaySecs: bn(86_400),
  lastRebalanceAt: bn(NOW - 10 * DAY),
  pendingTargets: null,
  applyNextPage: 0,
  ...overrides,
});
const snap = (overrides = {}) => ({
  at: NOW,
  slot: 1,
  portfolioRow: row(),
  portfolioAccount: account(),
  vaultAccount: vault(),
  accountantAccount: { recipient1: new PublicKey(TREASURY) },
  factoryConfig: { guardian: new PublicKey(GUARDIAN) },
  pools: basePools(),
  health: {},
  signer: { lamports: 300_000_000, usdcBaseUnits: '1000000000', shares: '5000000000' },
  ...overrides,
});
const ledger = (overrides = {}) => ({
  lastProposalAt: null,
  proposalsLast30d: 0,
  proposals: [],
  depositsTodayUsd: 0,
  withdrawalsTodayUsd: 0,
  writeAttempts: [],
  paused: false,
  selfLocked: null,
  applied: [],
  ...overrides,
});

const proposal = (overrides = {}) => evaluateProposal({
  policy,
  targets: VALID,
  why: 'rotate 5% of BTC into INF for the LST yield spread',
  snapshot: snap(),
  ledger: ledger(),
  now: NOW_MS,
  session: 'cron',
  ...overrides,
});
const codes = (result) => (result.ok ? [] : result.refusals.map((r) => r.code));

// ---------------------------------------------------------------------------

describe('loadPolicy', () => {
  it('loads the v1 document from a string or an object, drops _comment keys and deep-freezes', () => {
    const fromObject = loadPolicy(fresh());
    assert.equal(fromObject.version, 1);
    assert.deepEqual(fromObject, policy);
    assert.equal('_comment' in policy, false);
    assert.equal('_comment' in policy.universe, false);
    assert.equal('_comment' in policy.universe.categories, false);
    assert.ok(Object.isFrozen(policy.universe.allowlist));
    assert.ok(Object.isFrozen(policy.apply.escalateAfterSecs));
    assert.throws(() => { policy.shape.maxLegs = 99; }, TypeError);
    assert.equal(policy.shape.maxLegs, 8);
  });

  it('matches the ops source of truth when CURATOR_POLICY_FILE names it', (t) => {
    // The ops repo's config/curator/policy.v1.json is the document the chart
    // renders; its own suite compares it byte for byte with this fixture. From
    // here the comparison runs only when the variable names the file: a path
    // that does not exist fails, an unset variable skips and says so.
    const source = String(process.env.CURATOR_POLICY_FILE ?? '').trim();
    if (!source) {
      t.skip('CURATOR_POLICY_FILE unset; the ops repo compares its policy.v1.json with test/fixtures/policy.v1.json');
      return;
    }
    assert.ok(existsSync(source), `CURATOR_POLICY_FILE=${source} does not exist`);
    assert.deepEqual(loadPolicy(readFileSync(source, 'utf8')), policy, `${source} drifted from test/fixtures/policy.v1.json`);
  });

  it('refuses a missing key', () => {
    const doc = fresh();
    delete doc.shape.minLegs;
    assert.throws(() => loadPolicy(doc), /policy: missing key shape\.minLegs/);
    const noSection = fresh();
    delete noSection.rate;
    assert.throws(() => loadPolicy(noSection), /policy: missing section rate/);
  });

  it('refuses an unknown key or section — a typo of a cap is a cap that does not apply', () => {
    const doc = fresh();
    doc.turnover.maxTurnoverBsp = 3000;
    assert.throws(() => loadPolicy(doc), /policy: unknown key turnover\.maxTurnoverBsp/);
    const extraSection = fresh();
    extraSection.bonus = {};
    assert.throws(() => loadPolicy(extraSection), /policy: unknown section bonus/);
  });

  it('refuses a wrong type — no coercion', () => {
    const doc = fresh();
    doc.turnover.maxTurnoverBps = '3000';
    assert.throws(() => loadPolicy(doc), /policy: turnover\.maxTurnoverBps must be uint/);
    const window = fresh();
    window.cadence.proposeWindowUtc = { fromHour: 12, toHour: 8 };
    assert.throws(() => loadPolicy(window), /fromHour < toHour/);
    const escalate = fresh();
    escalate.apply.escalateAfterSecs.LEG_STALE = '1800';
    assert.throws(() => loadPolicy(escalate), /escalateAfterSecs\.LEG_STALE/);
  });

  it('refuses version !== 1 and invalid JSON', () => {
    const doc = fresh();
    doc.version = 2;
    assert.throws(() => loadPolicy(doc), /policy: version must be 1/);
    assert.throws(() => loadPolicy('{not json'), /policy: not valid JSON/);
  });

  it('refuses an allowlisted pool outside every category', () => {
    const doc = fresh();
    doc.universe.allowlist.push('pFOO');
    assert.throws(() => loadPolicy(doc), /allowlisted pFOO is in no category/);
  });

  it('refuses a pool in two categories', () => {
    const doc = fresh();
    doc.universe.categories.lst.push('pSOL');
    assert.throws(() => loadPolicy(doc), /pSOL is in two categories/);
  });

  it('refuses a category member that is not allowlisted', () => {
    const doc = fresh();
    doc.universe.categories.alt.push('pBAR');
    assert.throws(() => loadPolicy(doc), /category alt lists pBAR, which is not allowlisted/);
  });

  it('refuses contradictory verb lists', () => {
    const doc = fresh();
    doc.verbs.denied.push('propose');
    assert.throws(() => loadPolicy(doc), /verb propose is in both verbs\.agent and verbs\.denied/);
    const cron = fresh();
    cron.verbs.cronDenied.push('revive');
    assert.throws(() => loadPolicy(cron), /cronDenied revive/);
  });

  it('refuses an unknown stableCategory and a malformed launchDay', () => {
    const doc = fresh();
    doc.shape.stableCategory = 'stables';
    assert.throws(() => loadPolicy(doc), /stableCategory stables is not a category/);
    const launch = fresh();
    launch.deposit.launchDay = '11/09/2026';
    assert.throws(() => loadPolicy(launch), /launchDay must be YYYY-MM-DD/);
  });
});

describe('toSecs', () => {
  it('normalises ms and unix seconds to the same instant', () => {
    assert.equal(toSecs(NOW_MS), NOW);
    assert.equal(toSecs(NOW), NOW);
    assert.equal(toSecs(String(NOW)), NOW);
    assert.throws(() => toSecs(undefined), /`now` must be a number/);
  });
});

// ---------------------------------------------------------------------------

describe('verbAllowed', () => {
  const agentCron = { session: 'cron', tokenKind: 'agent' };
  const agentChat = { session: 'chat', tokenKind: 'agent' };
  const opsChat = { session: 'chat', tokenKind: 'ops' };

  it('allows an agent verb with the agent token and with the ops token (ops is a superset)', () => {
    assert.deepEqual(verbAllowed(policy, 'propose', agentCron), { ok: true });
    assert.deepEqual(verbAllowed(policy, 'status', opsChat), { ok: true });
    assert.deepEqual(verbAllowed(policy, 'resume', opsChat), { ok: true });
  });

  it('VERB_DENIED: a denied verb, whoever asks, and any verb the policy does not name', () => {
    assert.equal(verbAllowed(policy, 'transfer-curator', opsChat).code, 'VERB_DENIED');
    assert.equal(verbAllowed(policy, 'create', agentChat).code, 'VERB_DENIED');
    assert.equal(verbAllowed(policy, 'bogus', agentChat).code, 'VERB_DENIED');
    assert.equal(verbAllowed(policy, undefined, agentChat).code, 'VERB_DENIED');
    assert.equal(verbAllowed(policy, 'status', { session: 'chat', tokenKind: 'root' }).code, 'VERB_DENIED');
  });

  it('OPS_ONLY: an ops verb with the agent token', () => {
    for (const verb of policy.verbs.ops) {
      assert.equal(verbAllowed(policy, verb, agentChat).code, 'OPS_ONLY', verb);
    }
  });

  it('WITHDRAW_CRON_BLOCKED: withdraw outside a chat session; a missing session is cron', () => {
    assert.equal(verbAllowed(policy, 'withdraw', agentCron).code, 'WITHDRAW_CRON_BLOCKED');
    assert.equal(verbAllowed(policy, 'withdraw', { tokenKind: 'agent' }).code, 'WITHDRAW_CRON_BLOCKED');
    assert.equal(verbAllowed(policy, 'withdraw', { session: 'CHAT', tokenKind: 'agent' }).code, 'WITHDRAW_CRON_BLOCKED');
    assert.deepEqual(verbAllowed(policy, 'withdraw', agentChat), { ok: true });
  });
});

describe('evaluateWrite', () => {
  const write = (overrides = {}) => evaluateWrite({
    policy,
    verb: 'propose',
    portfolio: MINT,
    allowedPortfolio: MINT,
    state: { paused: false, selfLocked: null },
    ledger: ledger(),
    lamports: 300_000_000,
    now: NOW_MS,
    ...overrides,
  });

  it('passes a clean write, with `now` in ms or seconds', () => {
    assert.deepEqual(write(), { ok: true });
    assert.deepEqual(write({ now: NOW }), { ok: true });
  });

  it('PORTFOLIO_NOT_ALLOWED: another mint, or no mint configured', () => {
    assert.equal(write({ portfolio: PublicKey.unique().toBase58() }).code, 'PORTFOLIO_NOT_ALLOWED');
    assert.equal(write({ allowedPortfolio: undefined }).code, 'PORTFOLIO_NOT_ALLOWED');
    assert.equal(write({ portfolio: new PublicKey(MINT) }).ok, true);
  });

  it('SELF_LOCKED: every write, cancel included', () => {
    const state = { paused: false, selfLocked: { at: NOW - 5, reason: 'curator drift' } };
    const refused = write({ state });
    assert.equal(refused.code, 'SELF_LOCKED');
    assert.match(refused.message, /curator drift/);
    assert.equal(write({ state, verb: 'cancel' }).code, 'SELF_LOCKED');
    assert.equal(write({ state: undefined }).code, 'SELF_LOCKED');
  });

  it('PAUSED: writes refused; cancel and the ops verbs pass', () => {
    const state = { paused: true, selfLocked: null };
    assert.equal(write({ state }).code, 'PAUSED');
    assert.equal(write({ state, verb: 'deposit' }).code, 'PAUSED');
    assert.deepEqual(write({ state, verb: 'cancel' }), { ok: true });
    assert.deepEqual(write({ state, verb: 'rotate-curator' }), { ok: true });
  });

  it('RATE_LIMITED: the 21st attempt in an hour; older attempts do not count; an absent ledger refuses', () => {
    const recent = (n, ago) => Array.from({ length: n }, (_, i) => NOW - ago - i);
    assert.equal(write({ ledger: ledger({ writeAttempts: recent(20, 10) }) }).code, 'RATE_LIMITED');
    assert.deepEqual(write({ ledger: ledger({ writeAttempts: recent(19, 10) }) }), { ok: true });
    assert.deepEqual(write({ ledger: ledger({ writeAttempts: recent(20, 4000) }) }), { ok: true });
    assert.equal(write({ ledger: { writeAttemptsLastHour: 20 } }).code, 'RATE_LIMITED');
    assert.deepEqual(write({ ledger: { writeAttemptsLastHour: 3 } }), { ok: true });
    assert.equal(write({ ledger: undefined }).code, 'RATE_LIMITED');
  });

  it('LOW_SOL: under the floor, or unknown', () => {
    assert.equal(write({ lamports: policy.rate.minSignerLamports - 1 }).code, 'LOW_SOL');
    assert.deepEqual(write({ lamports: policy.rate.minSignerLamports }), { ok: true });
    assert.equal(write({ lamports: null }).code, 'LOW_SOL');
    assert.equal(write({ lamports: bn(1) }).code, 'LOW_SOL');
  });
});

// ---------------------------------------------------------------------------

describe('evaluateProposal', () => {
  it('passes a valid proposal and reports turnover, cost, legs, categories, nextProposeAt and the intent', () => {
    const result = proposal();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.summary.turnoverBps, 500);
    assert.equal(result.summary.estimatedCostBps, 3);
    assert.deepEqual(result.summary.categories, { sol: 3000, lst: 3000, btc: 2000, alt: 0, stable: 2000 });
    assert.equal(result.summary.nextProposeAt, NOW);
    assert.equal(result.summary.legs.length, 5);
    assert.deepEqual(result.summary.legs[2], { poolId: id('pCBBTC'), symbol: 'pCBBTC', fromBps: 2500, toBps: 2000, deltaBps: -500, maxExecutionLossBps: 30 });
    assert.deepEqual(result.summary.legs[4], { poolId: id('pINF'), symbol: 'pINF', fromBps: 0, toBps: 500, deltaBps: 500, maxExecutionLossBps: 30 });
    assert.deepEqual(result.intent.targets, VALID);
    assert.notEqual(result.intent.targets, VALID);
    assert.equal(result.intent.turnoverBps, 500);
    assert.equal(result.intent.estimatedCostBps, 3);
    assert.match(result.intent.why, /INF/);
  });

  it('lists every violation and reports the first as the code', () => {
    // pSOL over the leg cap, sum wrong, and no reason.
    const result = proposal({ targets: targets(['pSOL', 4500], ['pJITOSOL', 2500], ['pCBBTC', 2000], ['pUSDT', 2000]), why: '' });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['LEG_WEIGHT_CAP', 'WEIGHTS_SUM', 'WHY_REQUIRED']);
    assert.equal(result.code, 'LEG_WEIGHT_CAP');
    assert.equal(result.message, result.refusals[0].message);
    assert.ok(result.summary.legs.length > 0, 'the summary is still computed');
  });

  it('BAD_REQUEST: malformed targets never reach the rules', () => {
    assert.equal(proposal({ targets: [] }).code, 'BAD_REQUEST');
    assert.equal(proposal({ targets: [...VALID, { poolId: id('pSOL'), weightBps: 1 }] }).code, 'BAD_REQUEST');
    assert.equal(proposal({ targets: [{ poolId: id('pSOL'), weightBps: 12.5 }] }).code, 'BAD_REQUEST');
    assert.equal(proposal({ targets: [{ weightBps: 10_000 }] }).code, 'BAD_REQUEST');
  });

  // Universe.
  it('CHAIN_DENIED: a target on a chain outside the policy', () => {
    const result = proposal({ snapshot: snap({ pools: withPool('pUSDT', { chain: 'ethereum' }) }) });
    assert.ok(codes(result).includes('CHAIN_DENIED'), codes(result));
    assert.match(result.refusals.find((r) => r.code === 'CHAIN_DENIED').message, /pUSDT is on ethereum/);
  });

  it('POOL_NOT_ACTIVE: a target whose status is not active', () => {
    const result = proposal({ snapshot: snap({ pools: withPool('pINF', { status: 'paused' }) }) });
    assert.deepEqual(codes(result), ['POOL_NOT_ACTIVE']);
  });

  it('POOL_DENIED: not allowlisted, riskTier over the cap or unknown, no pythFeedId, not in the catalogue', () => {
    const swap = (symbol) => targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 2000], ['pUSDT', 2000], [symbol, 500]);
    const notListed = proposal({ targets: swap('pETH') });
    assert.deepEqual(codes(notListed), ['POOL_DENIED']);
    assert.match(notListed.message, /pETH is not on the allowlist/);
    assert.match(proposal({ snapshot: snap({ pools: withPool('pINF', { riskTier: 5 }) }) }).message, /riskTier 5 exceeds 4/);
    assert.match(proposal({ snapshot: snap({ pools: withPool('pINF', { riskTier: null }) }) }).message, /riskTier unknown/);
    assert.match(proposal({ snapshot: snap({ pools: withPool('pINF', { pythFeedId: null }) }) }).message, /no pythFeedId/);
    assert.match(proposal({ targets: swap('pNOPE') }).message, /pool-pNOPE is not in the catalogue/);
    assert.equal(proposal({ targets: swap('pNOPE') }).code, 'POOL_DENIED');
  });

  it('POOL_COST_TOO_HIGH: maxExecutionLossBps over the universe cap, or unknown', () => {
    assert.deepEqual(codes(proposal({ snapshot: snap({ pools: withPool('pINF', { maxExecutionLossBps: 150 }) }) })), ['POOL_COST_TOO_HIGH']);
    assert.ok(codes(proposal({ snapshot: snap({ pools: withPool('pINF', { maxExecutionLossBps: null }) }) })).includes('POOL_COST_TOO_HIGH'));
  });

  // Shape.
  it('MIN_LEGS: fewer than three legs', () => {
    const result = proposal({ targets: targets(['pSOL', 4000], ['pUSDT', 4000]) });
    assert.equal(result.code, 'MIN_LEGS');
  });

  it('MAX_LEGS: more than eight legs', () => {
    const nine = targets(['pSOL', 1112], ['pJITOSOL', 1111], ['pMSOL', 1111], ['pBSOL', 1111], ['pINF', 1111], ['pCBBTC', 1111], ['pHYPE', 1111], ['pUSDT', 1111], ['pUSDS', 1111]);
    assert.equal(nine.reduce((s, t) => s + t.weightBps, 0), 10_000);
    assert.ok(codes(proposal({ targets: nine })).includes('MAX_LEGS'));
  });

  it('PAGE_LIMIT: held ∪ new over one apply page even when the proposal itself has ≤ 8 legs', () => {
    const six = targets(['pSOL', 2000], ['pMSOL', 2000], ['pBSOL', 2000], ['pINF', 1000], ['pUSDS', 1500], ['pUSD1', 1500]);
    const result = proposal({ targets: six });
    const found = codes(result);
    assert.ok(found.includes('PAGE_LIMIT'), found);
    assert.ok(!found.includes('MAX_LEGS'), found);
    assert.match(result.refusals.find((r) => r.code === 'PAGE_LIMIT').message, /held ∪ new is 9 pools/);
  });

  it('LEG_WEIGHT_CAP: over 40%, under 5%, or over the pool\'s own maxWeightBps', () => {
    const over = proposal({ targets: targets(['pSOL', 4500], ['pJITOSOL', 2000], ['pCBBTC', 1500], ['pUSDT', 2000]) });
    assert.deepEqual(codes(over), ['LEG_WEIGHT_CAP']);
    assert.match(over.message, /pSOL at 4500 bps is over its 4000 bps cap/);
    const under = proposal({ targets: targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 2100], ['pUSDT', 2000], ['pINF', 400]) });
    assert.deepEqual(codes(under), ['LEG_WEIGHT_CAP']);
    assert.match(under.message, /pINF at 400 bps is under the 500 bps leg minimum/);
    const poolCap = proposal({ snapshot: snap({ pools: withPool('pSOL', { maxWeightBps: 2000 }) }) });
    assert.deepEqual(codes(poolCap), ['LEG_WEIGHT_CAP']);
    assert.match(poolCap.message, /pSOL at 3000 bps is over its 2000 bps cap/);
  });

  it('STABLE_BAND: stablecoins under 10% or over 40% combined', () => {
    const low = proposal({ targets: targets(['pSOL', 3500], ['pJITOSOL', 3000], ['pCBBTC', 3000], ['pUSDT', 500]) });
    assert.deepEqual(codes(low), ['STABLE_BAND']);
    assert.match(low.message, /stable at 500 bps is under the 1000 bps floor/);
    const high = proposal({ targets: targets(['pSOL', 2000], ['pJITOSOL', 1500], ['pCBBTC', 2000], ['pUSDT', 4000], ['pUSDS', 500]) });
    assert.deepEqual(codes(high), ['STABLE_BAND']);
    assert.match(high.message, /stable at 4500 bps is over the 4000 bps ceiling/);
  });

  it('CATEGORY_CAP: any category over 60%', () => {
    const result = proposal({ targets: targets(['pSOL', 2500], ['pJITOSOL', 3500], ['pMSOL', 3000], ['pUSDT', 1000]) });
    assert.ok(codes(result).includes('CATEGORY_CAP'), codes(result));
    assert.match(result.refusals.find((r) => r.code === 'CATEGORY_CAP').message, /lst at 6500 bps is over the 6000 bps category cap/);
  });

  it('WEIGHTS_SUM: anything but exactly 10000', () => {
    const result = proposal({ targets: targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 1990], ['pUSDT', 2000], ['pINF', 500]) });
    assert.deepEqual(codes(result), ['WEIGHTS_SUM']);
    assert.match(result.message, /sum to 9990 bps, not 10000/);
    assert.equal(proposal({ targets: targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 2010], ['pUSDT', 2000], ['pINF', 500]) }).code, 'WEIGHTS_SUM');
  });

  // Turnover and cost.
  it('TURNOVER_CAP: Σ|Δw|/2 over 30% against the current target weights', () => {
    const big = targets(['pSOL', 500], ['pJITOSOL', 500], ['pCBBTC', 500], ['pUSDT', 4000], ['pMSOL', 4000], ['pINF', 500]);
    const result = proposal({ targets: big });
    assert.ok(codes(result).includes('TURNOVER_CAP'), codes(result));
    assert.equal(result.summary.turnoverBps, 6500);
    assert.match(result.refusals.find((r) => r.code === 'TURNOVER_CAP').message, /turnover 6500 bps exceeds the 3000 bps cap/);
  });

  it('COST_CAP: Σ|Δw_i| × maxExecutionLossBps_i / 10000 over 25 bps, with turnover inside its cap', () => {
    const move = targets(['pSOL', 3000], ['pJITOSOL', 2500], ['pCBBTC', 1000], ['pUSDT', 2000], ['pINF', 1500]);
    const result = proposal({ targets: move, snapshot: snap({ pools: allPools({ maxExecutionLossBps: 100 }) }) });
    assert.deepEqual(codes(result), ['COST_CAP']);
    assert.equal(result.summary.turnoverBps, 1500);
    assert.equal(result.summary.estimatedCostBps, 30);
    assert.match(result.message, /estimated cost 30\.00 bps exceeds the 25 bps cap/);
    // The same move at 30 bps pools costs 9 bps and passes.
    assert.equal(proposal({ targets: move }).ok, true);
  });

  it('charges a removed leg at its own loss cap and lists it with toBps 0', () => {
    const exit = targets(['pSOL', 3500], ['pJITOSOL', 3500], ['pUSDT', 3000]);
    const result = proposal({ targets: exit, snapshot: snap({ pools: withPool('pCBBTC', { maxExecutionLossBps: 60 }) }) });
    assert.equal(result.ok, true, JSON.stringify(codes(result)));
    // |Δ| = 500 + 1000 + 1000 at 30 bps, plus 2500 at 60 bps = 22.5 bps.
    assert.equal(result.summary.estimatedCostBps, (2500 * 30 + 2500 * 60) / 10_000);
    assert.equal(result.summary.turnoverBps, 2500);
    const removed = result.summary.legs.find((leg) => leg.poolId === id('pCBBTC'));
    assert.deepEqual(removed, { poolId: id('pCBBTC'), symbol: 'pCBBTC', fromBps: 2500, toBps: 0, deltaBps: -2500, maxExecutionLossBps: 60 });
    // At 100 bps the same exit costs 32.5 bps and is refused: the removed leg is charged, not ignored.
    assert.deepEqual(codes(proposal({ targets: exit, snapshot: snap({ pools: withPool('pCBBTC', { maxExecutionLossBps: 100 }) }) })), ['COST_CAP']);
  });

  // Cadence.
  it('PROPOSAL_TOO_SOON: under 7 days since on-chain last_rebalance_at; nextProposeAt says when', () => {
    const result = proposal({ snapshot: snap({ portfolioAccount: account({ lastRebalanceAt: bn(NOW - 3 * DAY) }) }) });
    assert.deepEqual(codes(result), ['PROPOSAL_TOO_SOON']);
    assert.equal(result.summary.nextProposeAt, NOW + 4 * DAY);
    // A book that has never rebalanced (0) is not "too soon".
    assert.equal(proposal({ snapshot: snap({ portfolioAccount: account({ lastRebalanceAt: bn(0) }) }) }).ok, true);
    // Exactly 7 days passes; one second less does not.
    assert.equal(proposal({ snapshot: snap({ portfolioAccount: account({ lastRebalanceAt: bn(NOW - 7 * DAY) }) }) }).ok, true);
    assert.equal(proposal({ snapshot: snap({ portfolioAccount: account({ lastRebalanceAt: bn(NOW - 7 * DAY + 1) }) }) }).code, 'PROPOSAL_TOO_SOON');
    // An unreadable account refuses rather than passing.
    assert.equal(proposal({ snapshot: snap({ portfolioAccount: null }) }).code, 'PROPOSAL_TOO_SOON');
  });

  it('PROPOSAL_QUOTA: two proposals already in the 30-day window, from the list or the rolled-up count', () => {
    const listed = proposal({ ledger: ledger({ proposals: [{ at: NOW - 5 * DAY }, { at: NOW - 20 * DAY }] }) });
    assert.deepEqual(codes(listed), ['PROPOSAL_QUOTA']);
    assert.equal(listed.summary.nextProposeAt, NOW + 10 * DAY);
    assert.deepEqual(codes(proposal({ ledger: ledger({ proposals: [{ at: NOW - 5 * DAY }, { at: NOW - 31 * DAY }] }) })), []);
    assert.deepEqual(codes(proposal({ ledger: { proposalsLast30d: 2, writeAttempts: [] } })), ['PROPOSAL_QUOTA']);
    assert.deepEqual(codes(proposal({ ledger: ledger({ proposals: [], proposalsLast30d: 2 }) })), ['PROPOSAL_QUOTA']);
    assert.equal(proposal({ ledger: undefined }).code, 'PROPOSAL_QUOTA');
  });

  it('TARGETS_PENDING: a change already announced, seen on the row or on chain', () => {
    const pending = { targets: targets(...HELD), proposedAt: '2026-09-10T09:00:00.000Z', effectiveAt: '2026-09-11T09:00:00.000Z' };
    const fromRow = proposal({ snapshot: snap({ portfolioRow: row({ pendingTargets: pending }) }) });
    assert.deepEqual(codes(fromRow), ['TARGETS_PENDING']);
    assert.match(fromRow.message, /effective 2026-09-11T09:00:00.000Z/);
    const onChain = proposal({ snapshot: snap({ portfolioAccount: account({ pendingTargets: { proposedAt: bn(NOW - DAY), effectiveAt: bn(NOW) } }) }) });
    assert.deepEqual(codes(onChain), ['TARGETS_PENDING']);
  });

  it('INPUTS_INCOMPLETE: a targeted pool missing trailingYieldBps, tvlUsdc or riskTier; a risk exit is exempt', () => {
    const missingYield = proposal({ snapshot: snap({ pools: withPool('pINF', { trailingYieldBps: null }) }) });
    assert.deepEqual(codes(missingYield), ['INPUTS_INCOMPLETE']);
    assert.match(missingYield.message, /pINF is missing trailingYieldBps/);
    assert.deepEqual(codes(proposal({ snapshot: snap({ pools: withPool('pUSDT', { tvlUsdc: null }) }) })), ['INPUTS_INCOMPLETE']);
    // Dropping pCBBTC and adding nothing is a risk exit: pSOL's missing yield does not block it.
    const exit = targets(['pSOL', 3500], ['pJITOSOL', 3500], ['pUSDT', 3000]);
    const exitResult = proposal({ targets: exit, snapshot: snap({ pools: withPool('pSOL', { trailingYieldBps: null }) }) });
    assert.equal(exitResult.ok, true, JSON.stringify(codes(exitResult)));
    // The same drop plus a new pool is a rebalance, and the inputs rule applies.
    const notExit = targets(['pSOL', 3000], ['pJITOSOL', 3500], ['pUSDT', 3000], ['pINF', 500]);
    assert.deepEqual(codes(proposal({ targets: notExit, snapshot: snap({ pools: withPool('pSOL', { trailingYieldBps: null }) }) })), ['INPUTS_INCOMPLETE']);
    // With the exemption switched off the exit is blocked too.
    const strict = loadPolicy({ ...fresh(), cadence: { ...fresh().cadence, riskExitExemptFromInputs: false } });
    assert.deepEqual(codes(proposal({ policy: strict, targets: exit, snapshot: snap({ pools: withPool('pSOL', { trailingYieldBps: null }) }) })), ['INPUTS_INCOMPLETE']);
  });

  it('INPUTS_INCOMPLETE: no catalogue, or no holdings — unknown is never fine', () => {
    assert.deepEqual(codes(proposal({ snapshot: snap({ pools: null }) })), ['INPUTS_INCOMPLETE']);
    const noHoldings = proposal({ snapshot: snap({ portfolioRow: row({ holdings: null, targets: undefined, positions: undefined }) }) });
    assert.ok(codes(noHoldings).includes('INPUTS_INCOMPLETE'), codes(noHoldings));
    assert.equal(noHoldings.summary.turnoverBps, null);
    // The row's own targets/positions are enough when the custody read failed.
    assert.equal(proposal({ snapshot: snap({ portfolioRow: row({ holdings: null }) }) }).ok, true);
  });

  it('OUTSIDE_WINDOW: outside 08:00–12:00 UTC, boundaries included; nextProposeAt is the next opening', () => {
    const afternoon = proposal({ now: atUtc(13) });
    assert.deepEqual(codes(afternoon), ['OUTSIDE_WINDOW']);
    assert.equal(afternoon.summary.nextProposeAt, Date.UTC(2026, 8, 12, 8) / 1000);
    assert.deepEqual(codes(proposal({ now: atUtc(12, 0, 0) })), ['OUTSIDE_WINDOW']);
    assert.equal(proposal({ now: atUtc(11, 59, 59) }).ok, true);
    assert.equal(proposal({ now: atUtc(8, 0, 0) }).ok, true);
    const early = proposal({ now: atUtc(7, 59, 59) });
    assert.deepEqual(codes(early), ['OUTSIDE_WINDOW']);
    assert.equal(early.summary.nextProposeAt, atUtc(8) / 1000);
    // Chat sessions get the same answer: the window is about effectiveAt, not presence.
    assert.deepEqual(codes(proposal({ now: atUtc(13), session: 'chat' })), ['OUTSIDE_WINDOW']);
  });

  // Reason.
  it('WHY_REQUIRED: missing, blank or over 500 chars; `simulate` skips only this rule', () => {
    assert.deepEqual(codes(proposal({ why: undefined })), ['WHY_REQUIRED']);
    assert.deepEqual(codes(proposal({ why: '   ' })), ['WHY_REQUIRED']);
    const long = proposal({ why: 'x'.repeat(501) });
    assert.deepEqual(codes(long), ['WHY_REQUIRED']);
    assert.match(long.message, /501 chars, over the 500 cap/);
    assert.equal(proposal({ why: 'x'.repeat(500) }).ok, true);
    assert.equal(proposal({ why: undefined, simulate: true }).ok, true);
    assert.deepEqual(codes(proposal({ why: undefined, simulate: true, now: atUtc(13) })), ['OUTSIDE_WINDOW']);
  });
});

// ---------------------------------------------------------------------------

describe('evaluateDeposit', () => {
  const deposit = (overrides = {}) => evaluateDeposit({ policy, amountUsd: 100, snapshot: snap(), ledger: ledger(), now: NOW_MS, ...overrides });

  it('passes and quotes base units, a fee-and-tolerance share floor and the headroom', () => {
    const result = deposit();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.summary, {
      amountBaseUnits: '100000000',
      minShares: String(100_000_000 * (10_000 - 20 - MIN_OUT_TOLERANCE_BPS) / 10_000),
      headroomBaseUnits: '199900000000',
    });
    // Price 2.0 halves the shares.
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ price: bn('2000000') }) }) }).summary.minShares, '49650000');
  });

  it('BAD_REQUEST: a non-positive or non-numeric amount', () => {
    assert.equal(deposit({ amountUsd: 0 }).code, 'BAD_REQUEST');
    assert.equal(deposit({ amountUsd: 'ten' }).code, 'BAD_REQUEST');
  });

  it('DEPOSIT_DAILY_CAP: today\'s total plus this amount over $1,000; $2,500 on launch day; unknown ledger refuses', () => {
    const result = deposit({ amountUsd: 500, ledger: ledger({ depositsTodayUsd: 600 }) });
    assert.equal(result.code, 'DEPOSIT_DAILY_CAP');
    assert.match(result.message, /\$500 on top of \$600 today exceeds the \$1000 daily cap/);
    assert.equal(deposit({ amountUsd: 400, ledger: ledger({ depositsTodayUsd: 600 }) }).ok, true);
    const launch = loadPolicy({ ...fresh(), deposit: { ...fresh().deposit, launchDay: '2026-09-11' } });
    assert.equal(deposit({ policy: launch, amountUsd: 500, ledger: ledger({ depositsTodayUsd: 600 }) }).ok, true);
    assert.equal(deposit({ policy: launch, amountUsd: 2000, ledger: ledger({ depositsTodayUsd: 600 }) }).code, 'DEPOSIT_DAILY_CAP');
    assert.equal(deposit({ policy: launch, amountUsd: 500, ledger: ledger({ depositsTodayUsd: 600 }), now: NOW_MS + DAY * 1000 }).code, 'DEPOSIT_DAILY_CAP');
    assert.equal(deposit({ ledger: undefined }).code, 'DEPOSIT_DAILY_CAP');
  });

  it('BOOK_NOT_FRESH: a stale, pending or unknown book price, or a zero vault price', () => {
    assert.equal(deposit({ snapshot: snap({ portfolioRow: row({ priceState: 'stale' }) }) }).code, 'BOOK_NOT_FRESH');
    assert.equal(deposit({ snapshot: snap({ portfolioRow: row({ priceState: 'pending_acceptance' }) }) }).code, 'BOOK_NOT_FRESH');
    assert.equal(deposit({ snapshot: snap({ portfolioRow: null }) }).code, 'BOOK_NOT_FRESH');
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ price: bn(0) }) }) }).code, 'BOOK_NOT_FRESH');
  });

  it('CAP_HEADROOM: total shares, idle, or per-user headroom short; unknown vault or signer balance refuses', () => {
    const shortTotal = deposit({ snapshot: snap({ vaultAccount: vault({ maxTotalShares: bn('10050000000') }) }) });
    assert.equal(shortTotal.code, 'CAP_HEADROOM');
    assert.match(shortTotal.message, /100000000 base units exceed the vault headroom of 50000000/);
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ maxTotalIdle: bn('150000000') }) }) }).code, 'CAP_HEADROOM');
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ maxSharesPerUser: bn('5050000000') }) }) }).code, 'CAP_HEADROOM');
    // Exactly at the headroom passes.
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ maxTotalIdle: bn('200000000') }) }) }).ok, true);
    assert.equal(deposit({ snapshot: snap({ vaultAccount: null }) }).code, 'CAP_HEADROOM');
    assert.equal(deposit({ snapshot: snap({ vaultAccount: vault({ maxTotalIdle: undefined }) }) }).code, 'CAP_HEADROOM');
    assert.equal(deposit({ snapshot: snap({ signer: { lamports: 1, usdcBaseUnits: '1', shares: null } }) }).code, 'CAP_HEADROOM');
  });
});

describe('evaluateWithdraw', () => {
  const withdraw = (overrides = {}) => evaluateWithdraw({ policy, amountUsd: 100, session: 'chat', snapshot: snap(), ledger: ledger(), now: NOW_MS, ...overrides });

  it('passes in a chat session and quotes shares and a fee-and-tolerance floor', () => {
    const result = withdraw();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.summary, { shares: '100000000', minAmountOut: String(100_000_000 * (10_000 - 20 - MIN_OUT_TOLERANCE_BPS) / 10_000) });
    assert.equal(withdraw({ snapshot: snap({ vaultAccount: vault({ price: bn('2000000') }) }) }).summary.shares, '50000000');
  });

  it('WITHDRAW_CRON_BLOCKED: cron or missing session, before any other rule', () => {
    assert.equal(withdraw({ session: 'cron' }).code, 'WITHDRAW_CRON_BLOCKED');
    assert.equal(withdraw({ session: undefined }).code, 'WITHDRAW_CRON_BLOCKED');
    assert.equal(withdraw({ session: 'cron', amountUsd: -1 }).code, 'WITHDRAW_CRON_BLOCKED');
  });

  it('WITHDRAW_DAILY_CAP: today\'s total plus this amount over $500; unknown ledger refuses', () => {
    const result = withdraw({ amountUsd: 200, ledger: ledger({ withdrawalsTodayUsd: 400 }) });
    assert.equal(result.code, 'WITHDRAW_DAILY_CAP');
    assert.match(result.message, /\$200 on top of \$400 today exceeds the \$500 daily cap/);
    assert.equal(withdraw({ amountUsd: 100, ledger: ledger({ withdrawalsTodayUsd: 400 }) }).ok, true);
    assert.equal(withdraw({ ledger: undefined }).code, 'WITHDRAW_DAILY_CAP');
  });

  it('BOOK_NOT_FRESH: a non-fresh book, an unknown row or an unreadable vault', () => {
    assert.equal(withdraw({ snapshot: snap({ portfolioRow: row({ priceState: 'stale' }) }) }).code, 'BOOK_NOT_FRESH');
    assert.equal(withdraw({ snapshot: snap({ portfolioRow: null }) }).code, 'BOOK_NOT_FRESH');
    assert.equal(withdraw({ snapshot: snap({ vaultAccount: null }) }).code, 'BOOK_NOT_FRESH');
  });

  it('INSUFFICIENT_SHARES: the signer holds fewer shares than the amount needs, or the balance is unknown', () => {
    const short = withdraw({ amountUsd: 200, snapshot: snap({ signer: { lamports: 1, usdcBaseUnits: '0', shares: '100000000' } }) });
    assert.equal(short.code, 'INSUFFICIENT_SHARES');
    assert.match(short.message, /200000000 shares needed, signer holds 100000000/);
    assert.equal(withdraw({ amountUsd: 100, snapshot: snap({ signer: { lamports: 1, usdcBaseUnits: '0', shares: '100000000' } }) }).ok, true);
    assert.equal(withdraw({ snapshot: snap({ signer: { lamports: 1, usdcBaseUnits: '0', shares: null } }) }).code, 'INSUFFICIENT_SHARES');
  });
});

// ---------------------------------------------------------------------------

describe('evaluateInvariants', () => {
  const config = { expectedCurator: CURATOR, treasury: TREASURY, guardian: GUARDIAN };
  const chain = (overrides = {}) => ({
    curator: new PublicKey(CURATOR),
    pendingCurator: null,
    rebalanceDelaySecs: bn(86_400),
    recipient1: new PublicKey(TREASURY),
    guardian: GUARDIAN,
    compositionLocked: false,
    ...overrides,
  });
  const check = (overrides) => evaluateInvariants({ policy, chain: chain(overrides), config });
  const driftOf = (result) => result.drift.map((d) => d.invariant);

  it('passes when every fact matches, PublicKey or base58, BN or number', () => {
    assert.deepEqual(check(), { ok: true, drift: [] });
    assert.deepEqual(check({ curator: CURATOR, rebalanceDelaySecs: 86_400 }), { ok: true, drift: [] });
  });

  it('INVARIANT_DRIFT: each invariant planted', () => {
    const other = PublicKey.unique();
    const curator = check({ curator: other });
    assert.equal(curator.code, 'INVARIANT_DRIFT');
    assert.deepEqual(curator.drift, [{ invariant: 'portfolio.curator', expected: CURATOR, actual: other.toBase58() }]);
    assert.deepEqual(driftOf(check({ pendingCurator: other })), ['portfolio.pending_curator']);
    assert.deepEqual(driftOf(check({ rebalanceDelaySecs: bn(3600) })), ['portfolio.rebalance_delay_secs']);
    assert.deepEqual(driftOf(check({ recipient1: other })), ['accountant.recipient1']);
    assert.deepEqual(driftOf(check({ guardian: other.toBase58() })), ['factory.guardian']);
    assert.deepEqual(driftOf(check({ compositionLocked: true })), ['portfolio.composition_locked']);
  });

  it('treats an unreadable fact as drift, never as fine — except pendingCurator, whose null is None', () => {
    const unknown = check({ curator: undefined, rebalanceDelaySecs: undefined, compositionLocked: undefined });
    assert.deepEqual(driftOf(unknown), ['portfolio.curator', 'portfolio.rebalance_delay_secs', 'portfolio.composition_locked']);
    assert.ok(unknown.drift.every((d) => d.actual === 'unknown'));
    const nothing = evaluateInvariants({ policy, chain: null, config });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.drift.length, 5);
    assert.match(nothing.message, /invariant drift: portfolio\.curator/);
  });
});
