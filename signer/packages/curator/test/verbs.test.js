/**
 * The write pipeline on planted violations: a refused policy, a refused
 * decode, a cron withdraw, a self-lock and a pause each stop the line before
 * a signature exists; a send failure is named and its "build it again" prose
 * dropped; every outcome is journaled with its code. Fakes only.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';
import { fakeCtx, fakeSnapshot, meta, NEW_TARGETS, LEGS, LEGS_AFTER, POOLS, POLICY, WALLET, MINT, T0, T0_MS, KEYS } from './fakes.js';
import * as verbs from '../src/verbs.js';
import { OPS_VERBS } from '../src/verbs.js';
import { ROUTES } from '../src/server.js';
import { deriveReview as realDeriveReview } from '../src/metrics.js';
import { Journal, canonicalSha256 } from '../src/journal.js';
import { utcDay } from '../src/policy.js';
import { Refusal } from '../src/errors.js';

const { BN } = anchor;

/** The Pool PDAs the decoder compares a proposal against; `GET /v1/pools` carries them as `addresses.pool`. */
const POOL_KEYS = Object.freeze(Object.fromEntries(['pSOL', 'pJITOSOL', 'pCBBTC', 'pUSDT', 'pMSOL'].map((id) => [id, Keypair.generate().publicKey.toBase58()])));
/** The shared fake pools carry no `addresses`; a propose without the keys refuses INPUTS_INCOMPLETE, so every ctx here gets them. */
const withPoolKeys = (snapshot) => ({ ...snapshot, pools: (snapshot.pools ?? []).map((pool) => ({ ...pool, addresses: { pool: POOL_KEYS[pool.poolId] ?? null } })) });

const ctxs = [];
const mk = (over = {}) => { const ctx = fakeCtx({ ...over, snapshot: withPoolKeys(over.snapshot ?? fakeSnapshot()) }); ctxs.push(ctx); return ctx; };
after(() => ctxs.forEach((ctx) => ctx.cleanup()));

async function rejectsWith(promise, code) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof Refusal, `expected a Refusal, got ${error?.stack ?? error}`);
  assert.equal(error.code, code);
  return error;
}
const records = (ctx) => ctx.journal.records();
const WRITE_ARGS = {
  propose: { targets: NEW_TARGETS, why: 'rotate' },
  apply: {},
  cancel: { why: 'stop' },
  deposit: { amountUsd: 10 },
  withdraw: { amountUsd: 10 },
  'refresh-nav': {},
  'rotate-curator': { newCurator: KEYS.governance.toBase58(), why: 'rotate' },
  'set-delay': { rebalanceDelaySecs: 86400, why: 'reset' },
  'set-metadata': { uri: 'https://www.weavr.sh/metadata/WEAVR', why: 'set' },
};

test('propose runs policy → build → verify → sign → send → journal in that order and arms the machine', async () => {
  const ctx = mk();
  const out = await verbs.propose(ctx, { targets: NEW_TARGETS, why: 'rotate into LST' }, meta());
  assert.equal(out.ok, true);
  assert.equal(out.verb, 'propose');
  assert.equal(out.deploymentId, 'dep-1');
  assert.deepEqual(out.signatures, ['sig-1']);
  assert.equal(out.effectiveAt, T0 + 86400);
  assert.ok(out.journalId);
  assert.deepEqual(ctx.trace, ['verbAllowed', 'readSnapshot', 'evaluateWrite', 'evaluateProposal', 'proposeGates', 'buildPropose', 'verifyBuilt', 'sign', 'send']);
  assert.deepEqual(ctx.client.calls[0], { name: 'buildPropose', mint: MINT, body: { curator: WALLET, targets: NEW_TARGETS } });
  assert.equal(ctx.state.apply.state, 'ARMED');
  assert.deepEqual(ctx.state.apply.targets, NEW_TARGETS);
  assert.equal(ctx.state.apply.deploymentId, 'dep-1');
  const verb = records(ctx).find((r) => r.kind === 'verb');
  assert.equal(verb.verb, 'propose');
  assert.equal(verb.caller, 'test');
  assert.equal(verb.session, 'chat');
  assert.deepEqual(verb.args.targets, NEW_TARGETS);
  assert.equal(verb.args.why, 'rotate into LST');
  assert.deepEqual(verb.signatures, ['sig-1']);
  assert.ok(!JSON.stringify(records(ctx)).includes('AQIDBA=='), 'no transaction body in the journal');
  assert.equal(ctx.state.ledger.proposalsLast30d, 1);
  assert.equal(ctx.state.ledger.writeAttempts.length, 1);
});

test('verifyBuilt hands the decoder the intent: payer = signer, portfolio = the row\'s Portfolio PDA (never the mint), vault = the row\'s vaultKey, Pool keys, targets = the proposal, the chain allowlists', async () => {
  let expect = null;
  const ctx = mk({ depsOverrides: { verifyBuilt: (input) => { expect = input.expect; return { ok: true, summary: {} }; } } });
  await verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta());
  assert.equal(expect.payer, WALLET);
  assert.equal(expect.portfolio, KEYS.portfolio.toBase58());
  assert.notEqual(expect.portfolio, MINT, 'the shares mint is no instruction account; handing it over refuses every write WRONG_PORTFOLIO');
  assert.equal(expect.vault, KEYS.vault.toBase58());
  assert.deepEqual(expect.poolKeys, POOL_KEYS);
  assert.deepEqual(expect.targets, NEW_TARGETS);
  assert.equal(expect.allowedPrograms, ctx.chain.programs);
  assert.equal(expect.lookupTables, ctx.chain.lookupTables);
});

test('expectFor refuses UPSTREAM without the row\'s portfolio/vaultKey and INPUTS_INCOMPLETE for a targeted pool without a key; nothing is built', async () => {
  const noRow = mk();
  noRow.deps.setSnapshot({ ...withPoolKeys(fakeSnapshot()), portfolioRow: null });
  const upstream = await rejectsWith(verbs.refreshNav(noRow, {}, meta()), 'UPSTREAM');
  assert.equal(upstream.status, 502);
  const noVault = mk();
  noVault.deps.setSnapshot({ ...withPoolKeys(fakeSnapshot()), portfolioRow: { ...fakeSnapshot().portfolioRow, vaultKey: undefined } });
  await rejectsWith(verbs.deposit(noVault, { amountUsd: 10 }, meta()), 'UPSTREAM');
  assert.equal(noRow.client.calls.length + noVault.client.calls.length, 0, 'refused before the build');
  const partial = withPoolKeys(fakeSnapshot());
  partial.pools = partial.pools.map((pool) => (pool.poolId === 'pJITOSOL' ? { ...pool, addresses: { pool: null } } : pool));
  const noKey = mk();
  noKey.deps.setSnapshot(partial);
  const error = await rejectsWith(verbs.propose(noKey, { targets: NEW_TARGETS, why: 'x' }, meta()), 'INPUTS_INCOMPLETE');
  assert.deepEqual(error.detail.missing, ['pJITOSOL']);
  assert.ok(!noKey.trace.includes('buildPropose') && !noKey.trace.includes('verifyBuilt'));
  assert.equal(records(noKey).find((r) => r.kind === 'refusal').code, 'INPUTS_INCOMPLETE');
  // apply compares no targets, so a catalogue row without keys does not hold an apply.
  const applyOk = await verbs.applySend(noKey, meta({ session: 'cron' }));
  assert.equal(applyOk.state, 'SENT');
});

test('the decoder is told every fixed argument: deposit amount/minShares, withdraw shares/minAmountOut, the nominee, the delay, the uri', async () => {
  const seen = [];
  const ctx = mk({ depsOverrides: { verifyBuilt: (input) => { seen.push([input.verb, input.expect]); return { ok: true, summary: {} }; } } });
  await verbs.deposit(ctx, { amountUsd: 250 }, meta());
  await verbs.withdraw(ctx, { amountUsd: 10 }, meta({ session: 'chat' }));
  await verbs.rotateCurator(ctx, { newCurator: KEYS.governance.toBase58(), why: 'x' }, meta({ tokenKind: 'ops' }));
  await verbs.setDelay(ctx, { rebalanceDelaySecs: 3600, why: 'x' }, meta({ tokenKind: 'ops' }));
  await verbs.setMetadata(ctx, { uri: 'https://www.weavr.sh/metadata/WEAVR', why: 'x' }, meta({ tokenKind: 'ops' }));
  const byVerb = Object.fromEntries(seen);
  assert.equal(byVerb.deposit.amount, '250000000');
  assert.equal(byVerb.deposit.minShares, '0');
  assert.equal(byVerb.withdraw.shares, '1000000');
  assert.equal(byVerb.withdraw.minAmountOut, '0');
  assert.equal(byVerb['rotate-curator'].newCurator, KEYS.governance.toBase58());
  assert.equal(byVerb['set-delay'].rebalanceDelaySecs, 3600);
  assert.equal(byVerb['set-metadata'].uri, 'https://www.weavr.sh/metadata/WEAVR');
  for (const [verb, expect] of seen) {
    assert.equal(expect.vault, KEYS.vault.toBase58(), verb);
    assert.equal(expect.portfolio, KEYS.portfolio.toBase58(), verb);
    assert.equal(expect.targets, undefined, `${verb} carries no target set`);
  }
});

test('a refused policy never reaches build, sign or send; the refusal is journaled with its code and counted as an attempt', async () => {
  const ctx = mk({ depsOverrides: {
    evaluateProposal: () => ({ ok: false, code: 'TURNOVER_CAP', message: 'turnover 3500 bps over the 3000 cap', refusals: [{ code: 'TURNOVER_CAP', message: 'x' }, { code: 'COST_CAP', message: 'y' }], summary: { turnoverBps: 3500 } }),
  } });
  const error = await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'too much' }, meta()), 'TURNOVER_CAP');
  assert.equal(error.detail.refusals.length, 2);
  assert.equal(error.journaled, true);
  assert.ok(!ctx.trace.includes('buildPropose') && !ctx.trace.includes('sign') && !ctx.trace.includes('send'));
  const refusal = records(ctx).find((r) => r.kind === 'refusal');
  assert.equal(refusal.code, 'TURNOVER_CAP');
  assert.equal(refusal.verb, 'propose');
  assert.equal(ctx.state.ledger.writeAttempts.length, 1);
  assert.equal(ctx.state.apply.state, 'IDLE');
});

test('a chain-state blocker from proposeGates refuses with the blocker code before any build', async () => {
  const ctx = mk({ depsOverrides: { proposeGates: () => ({ ok: false, blockers: [{ code: 'TARGETS_PENDING', action: 'blocked', message: 'a change is pending' }] }) } });
  await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'TARGETS_PENDING');
  assert.ok(!ctx.trace.includes('buildPropose'));
});

test('a payload the decoder refuses is never signed', async () => {
  const ctx = mk({ depsOverrides: { verifyBuilt: () => ({ ok: false, code: 'WRONG_PAYER', message: 'fee payer is not the curator' }) } });
  const error = await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'WRONG_PAYER');
  assert.equal(error.status, 502);
  assert.ok(ctx.trace.includes('buildPropose'));
  assert.ok(!ctx.trace.includes('sign') && !ctx.trace.includes('send'));
  assert.equal(ctx.signer.calls.length, 0);
});

test('a decoder that throws (a stub, a bug) is a refusal, never a pass', async () => {
  const ctx = mk({ depsOverrides: { verifyBuilt: () => { throw new Error('not implemented'); } } });
  await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'UNKNOWN_INSTRUCTION');
  assert.equal(ctx.signer.calls.length, 0);
});

test('propose and cancel require a reason (WHY_REQUIRED) and bound it', async () => {
  const ctx = mk();
  await rejectsWith(verbs.cancel(ctx, {}, meta()), 'WHY_REQUIRED');
  await rejectsWith(verbs.cancel(ctx, { why: '   ' }, meta()), 'WHY_REQUIRED');
  await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x'.repeat(501) }, meta()), 'WHY_REQUIRED');
  assert.ok(!ctx.trace.includes('buildCancel') && !ctx.trace.includes('buildPropose'));
  assert.equal(records(ctx).filter((r) => r.kind === 'refusal' && r.code === 'WHY_REQUIRED').length, 3);
});

test('cancel builds cancel_targets with the signer, disarms the machine and is allowed while paused', async () => {
  const ctx = mk({ paused: true });
  ctx.state.apply = { ...verbs.initialApplyState(), state: 'PREFLIGHT', targets: NEW_TARGETS, effectiveAt: T0 + 10 };
  const out = await verbs.cancel(ctx, { why: 'bad inputs' }, meta());
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.client.calls[0], { name: 'buildCancel', mint: MINT, body: { signer: WALLET } });
  assert.equal(ctx.state.apply.state, 'IDLE');
  assert.equal(ctx.state.apply.targets, null);
});

test('withdraw in a cron session is refused WITHDRAW_CRON_BLOCKED before a snapshot is read', async () => {
  const ctx = mk();
  const error = await rejectsWith(verbs.withdraw(ctx, { amountUsd: 10 }, meta({ session: 'cron' })), 'WITHDRAW_CRON_BLOCKED');
  assert.equal(error.status, 403);
  assert.deepEqual(ctx.trace, ['verbAllowed']);
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal(records(ctx).find((r) => r.kind === 'refusal').code, 'WITHDRAW_CRON_BLOCKED');
});

test('withdraw in chat builds withdraw_request for the signer with the evaluated shares', async () => {
  const ctx = mk();
  const out = await verbs.withdraw(ctx, { amountUsd: 10 }, meta({ session: 'chat' }));
  assert.equal(out.verb, 'withdraw');
  assert.equal(out.shares, '1000000');
  assert.deepEqual(ctx.client.calls[0].body, { user: WALLET, shares: '1000000', minAmountOut: '0' });
  assert.equal(ctx.state.ledger.withdrawalsTodayUsd, 10);
});

test('deposit builds with the evaluated base units and the day total comes back from the journal', async () => {
  const ctx = mk();
  const out = await verbs.deposit(ctx, { amountUsd: 250 }, meta());
  assert.equal(out.amountBaseUnits, '250000000');
  assert.deepEqual(ctx.client.calls[0].body, { user: WALLET, amount: '250000000', minShares: '0' });
  assert.equal(ctx.state.ledger.depositsTodayUsd, 250);
  await rejectsWith(verbs.deposit(ctx, { amountUsd: -1 }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.deposit(ctx, { amountUsd: 'ten' }, meta()), 'BAD_REQUEST');
});

test('a deposit the policy refuses (CAP_HEADROOM) is never built', async () => {
  const ctx = mk({ depsOverrides: { evaluateDeposit: () => ({ ok: false, code: 'CAP_HEADROOM', message: 'over headroom' }) } });
  await rejectsWith(verbs.deposit(ctx, { amountUsd: 5000 }, meta()), 'CAP_HEADROOM');
  assert.ok(!ctx.trace.includes('buildDeposit'));
});

test('a send failure is named by program error and the api fix prose is dropped', async () => {
  const ctx = mk({ depsOverrides: {
    nameProgramError: (text, hints) => (text.includes('0x1772') ? { code: 6002, name: 'RebalanceTooSoon', program: hints.program } : null),
  } });
  ctx.client.fail.send = new Refusal('SEND_FAILED', 'api POST /v1/transactions/send refused: rejected', {
    code: 'SEND_FAILED',
    message: 'signed[0] was rejected: custom program error: 0x1772. Build it again, hand the new walletPayload to the wallet, then send_signed with what it returns.',
    fix: 'Build it again, hand the new walletPayload to the wallet, then send_signed with what it returns.',
  });
  const error = await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'SEND_FAILED');
  assert.ok(error.message.startsWith('RebalanceTooSoon (portfolio_factory 6002)'), error.message);
  assert.ok(!error.message.includes('Build it again'));
  assert.equal(error.detail.fix, undefined);
  assert.equal(error.detail.programError.name, 'RebalanceTooSoon');
  assert.equal(error.detail.expired, false);
  assert.equal(records(ctx).find((r) => r.kind === 'refusal').code, 'SEND_FAILED');
  assert.equal(ctx.state.apply.state, 'IDLE', 'a failed propose does not arm the machine');
});

test('an expired send is SEND_FAILED with detail.expired so the loop may rebuild', async () => {
  const ctx = mk();
  ctx.client.sendResult = { ok: false, status: 'expired', signatures: [], error: { code: 'SEND_EXPIRED', message: 'the api reports the send as expired' } };
  const error = await rejectsWith(verbs.refreshNav(ctx, {}, meta()), 'SEND_FAILED');
  assert.equal(error.detail.expired, true);
});

test('an api build refusal keeps the codes the loop reacts to: NO_PENDING_CHANGE and MISSING_CUSTODY', async () => {
  const ctx = mk();
  ctx.client.fail.buildApply = new Refusal('BUILD_REFUSED', 'api refused', { code: 'NO_PENDING_CHANGE', message: 'nothing pending' });
  await rejectsWith(verbs.applySend(ctx, meta({ session: 'cron' })), 'NO_PENDING_CHANGE');
  ctx.client.fail.buildApply = new Refusal('BUILD_REFUSED', 'api refused', { code: 'BUILD_FAILED', message: 'MissingCustodyForNewPool: pJITOSOL' });
  await rejectsWith(verbs.applySend(ctx, meta({ session: 'cron' })), 'MISSING_CUSTODY');
  ctx.client.fail.buildApply = new Refusal('UPSTREAM', 'api unreachable');
  await rejectsWith(verbs.applySend(ctx, meta({ session: 'cron' })), 'UPSTREAM');
  assert.equal(ctx.signer.calls.length, 0);
});

test('the attempt is counted before the build: a build that fails still lands in the ledger', async () => {
  const ctx = mk();
  ctx.client.fail.buildPropose = new Refusal('UPSTREAM', 'api POST /v1/portfolios/x/rebalance unreachable (ECONNREFUSED)');
  await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'UPSTREAM');
  assert.equal(ctx.state.ledger.writeAttempts.length, 1);
  assert.equal(ctx.state.ledger.writeAttemptsLastHour, 1);
});

test('apply: a blocked pre-flight answers the blockers with the blocker status and never builds', async () => {
  const ctx = mk({ depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'VAULT_PAUSED', action: 'blocked', message: 'the vault is paused' }] }) } });
  ctx.state.apply = { ...verbs.initialApplyState(), state: 'PREFLIGHT', targets: NEW_TARGETS, effectiveAt: T0 - 10 };
  const out = await verbs.apply(ctx, {}, meta());
  assert.equal(out.ok, false);
  assert.equal(out.httpStatus, 409);
  assert.equal(out.blockers[0].code, 'VAULT_PAUSED');
  assert.ok(!ctx.trace.includes('buildApply') && !ctx.trace.includes('sign'));
  assert.equal(records(ctx).find((r) => r.kind === 'refusal').code, 'VAULT_PAUSED');
});

test('apply: gates pass → apply_targets built with the caller, signed, sent, machine CONFIRM', async () => {
  const ctx = mk();
  ctx.state.apply = { ...verbs.initialApplyState(), state: 'PREFLIGHT', targets: NEW_TARGETS, effectiveAt: T0 - 10, deploymentId: 'dep-1' };
  const out = await verbs.apply(ctx, {}, meta());
  assert.equal(out.state, 'SENT');
  assert.deepEqual(out.signatures, ['sig-1']);
  assert.deepEqual(ctx.client.calls[0], { name: 'buildApply', mint: MINT, body: { caller: WALLET } });
  assert.equal(ctx.state.apply.state, 'CONFIRM');
  assert.equal(ctx.state.apply.attempts, 1);
  assert.deepEqual(ctx.state.apply.signatures, ['sig-1']);
  const applyRecord = records(ctx).find((r) => r.kind === 'apply');
  assert.equal(applyRecord.to, 'CONFIRM');
});

test('apply: NO_PENDING_CHANGE after arming with the proposal already on chain → DONE without a send', async () => {
  const ctx = mk({
    snapshot: fakeSnapshot({ legs: LEGS_AFTER, lastRebalanceAt: T0 - 5 }),
    depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'NO_PENDING_CHANGE', action: 'done', message: 'nothing pending' }] }) },
  });
  ctx.state.apply = { ...verbs.initialApplyState(), state: 'PREFLIGHT', targets: NEW_TARGETS, effectiveAt: T0 - 10, proposedAt: T0 - 86400 };
  const out = await verbs.apply(ctx, {}, meta());
  assert.equal(out.ok, true);
  assert.equal(out.state, 'DONE');
  assert.equal(ctx.state.apply.state, 'DONE');
  assert.ok(!ctx.trace.includes('buildApply'));
});

test('apply: NO_PENDING_CHANGE with different targets on chain after a newer apply → ESCALATED APPLIED_MISMATCH', async () => {
  const ctx = mk({
    snapshot: fakeSnapshot({ lastRebalanceAt: T0 - 5 }),
    depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'NO_PENDING_CHANGE', action: 'done', message: 'nothing pending' }] }) },
  });
  ctx.state.apply = { ...verbs.initialApplyState(), state: 'PREFLIGHT', targets: NEW_TARGETS, effectiveAt: T0 - 10, proposedAt: T0 - 86400 };
  const out = await verbs.apply(ctx, {}, meta());
  assert.equal(out.ok, false);
  assert.equal(out.state, 'ESCALATED');
  assert.equal(out.blockers[0].code, 'APPLIED_MISMATCH');
  assert.ok(ctx.state.alerts.has('apply:APPLIED_MISMATCH'));
});

test('apply with nothing armed and nothing pending → NO_PENDING_CHANGE', async () => {
  const ctx = mk({ depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'NO_PENDING_CHANGE', action: 'done', message: 'nothing pending' }] }) } });
  const error = await rejectsWith(verbs.apply(ctx, {}, meta()), 'NO_PENDING_CHANGE');
  assert.equal(error.status, 409);
});

test('self-locked: every write verb is refused SELF_LOCKED with nothing built or signed, cancel included', async () => {
  const ctx = mk({ selfLocked: { at: T0 - 60, reason: 'INVARIANT_DRIFT', drift: [] } });
  for (const verb of verbs.WRITE_VERBS) {
    const error = await rejectsWith(verbs.VERBS[verb](ctx, WRITE_ARGS[verb], meta({ tokenKind: 'ops' })), 'SELF_LOCKED');
    assert.equal(error.status, 409);
  }
  assert.equal(ctx.client.calls.length, 0);
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal(records(ctx).filter((r) => r.kind === 'refusal' && r.code === 'SELF_LOCKED').length, verbs.WRITE_VERBS.size);
});

test('paused: the agent write verbs are refused PAUSED; cancel and the ops-token verbs still run (kill-ladder steps 1 and 5), and nothing resumes the signer', async () => {
  const ctx = mk({ paused: true });
  for (const verb of ['propose', 'apply', 'deposit', 'withdraw', 'refresh-nav']) {
    const error = await rejectsWith(verbs.VERBS[verb](ctx, WRITE_ARGS[verb], meta({ tokenKind: 'ops' })), 'PAUSED');
    assert.equal(error.status, 409, verb);
  }
  // An ops verb reached with the agent token is not an ops verb: the hard check does not take the route's word for it.
  await rejectsWith(verbs.rotateCurator(ctx, WRITE_ARGS['rotate-curator'], meta({ tokenKind: 'agent' })), 'PAUSED');
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal((await verbs.cancel(ctx, { why: 'stop' }, meta())).ok, true);
  for (const verb of ['rotate-curator', 'set-delay', 'set-metadata']) {
    const out = await verbs.VERBS[verb](ctx, WRITE_ARGS[verb], meta({ tokenKind: 'ops' }));
    assert.equal(out.ok, true, verb);
  }
  assert.equal(ctx.state.paused, true, 'a rotation mid-incident never re-arms the agent');
  assert.equal(records(ctx).filter((r) => r.kind === 'refusal' && r.code === 'PAUSED').length, 6);
});

test('a policy verbAllowed refusal is honoured as-is (VERB_DENIED) and never built', async () => {
  const ctx = mk({ depsOverrides: { verbAllowed: () => ({ ok: false, code: 'VERB_DENIED', message: 'never' }) } });
  await rejectsWith(verbs.refreshNav(ctx, {}, meta()), 'VERB_DENIED');
  assert.equal(ctx.client.calls.length, 0);
});

test('evaluateWrite refusals (RATE_LIMITED, LOW_SOL) stop the line after the snapshot and before the verb policy', async () => {
  const ctx = mk({ depsOverrides: { evaluateWrite: () => ({ ok: false, code: 'RATE_LIMITED', message: '20 attempts in the last hour' }) } });
  const error = await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'RATE_LIMITED');
  assert.equal(error.status, 429);
  assert.ok(!ctx.trace.includes('evaluateProposal') && !ctx.trace.includes('buildPropose'));
});

test('PORTFOLIO_NOT_ALLOWED when the args name another mint', async () => {
  const ctx = mk();
  const error = await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x', mint: KEYS.governance.toBase58() }, meta()), 'PORTFOLIO_NOT_ALLOWED');
  assert.equal(error.status, 403);
  assert.equal(ctx.client.calls.length, 0);
});

test('malformed targets are BAD_REQUEST before anything runs', async () => {
  const ctx = mk();
  await rejectsWith(verbs.propose(ctx, { targets: [], why: 'x' }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.propose(ctx, { targets: [{ poolId: 'pSOL', weightBps: 10001 }], why: 'x' }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.propose(ctx, { targets: [{ poolId: 7, weightBps: 100 }], why: 'x' }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.simulate(ctx, { targets: 'pSOL' }, meta()), 'BAD_REQUEST');
  assert.deepEqual(ctx.trace, []);
});

test('alerts are delivered once, re-delivered after 6 h, and a cleared one is delivered as resolved once', async () => {
  const ctx = mk();
  assert.equal(verbs.raiseAlert(ctx, 'sol', 'LOW_SOL', 'signer holds 1 lamport'), true);
  let out = await verbs.alerts(ctx, {}, meta());
  assert.equal(out.since, null);
  assert.deepEqual(out.alerts.map((a) => [a.key, a.code]), [['sol', 'LOW_SOL']]);
  out = await verbs.alerts(ctx, {}, meta());
  assert.deepEqual(out.alerts, []);
  assert.equal(out.since, T0);
  assert.equal(verbs.raiseAlert(ctx, 'sol', 'LOW_SOL', 'still low'), false, 'a standing alert is silent');
  ctx.clock.advance(6 * 3600);
  assert.equal(verbs.raiseAlert(ctx, 'sol', 'LOW_SOL', 'still low'), true, 're-alerted after 6 h');
  out = await verbs.alerts(ctx, {}, meta());
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].count, 2);
  assert.equal(verbs.clearAlert(ctx, 'sol'), true);
  out = await verbs.alerts(ctx, {}, meta());
  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].resolved, true);
  assert.ok(out.alerts[0].message.startsWith('resolved:'));
  out = await verbs.alerts(ctx, {}, meta());
  assert.deepEqual(out.alerts, []);
  assert.equal(ctx.state.alerts.size, 0);
  // raised and cleared between two polls: never delivered, no resolved line
  verbs.raiseAlert(ctx, 'x', 'BOOK_NOT_FRESH', 'flap');
  verbs.clearAlert(ctx, 'x');
  out = await verbs.alerts(ctx, {}, meta());
  assert.deepEqual(out.alerts, []);
  assert.equal(records(ctx).filter((r) => r.kind === 'alert').length, 4);
});

test('unlock refuses INVARIANT_DRIFT while the drift is present and clears the lock once it is gone', async () => {
  let drift = [{ invariant: 'portfolio.curator', expected: WALLET, actual: KEYS.governance.toBase58() }];
  const ctx = mk({ selfLocked: { at: T0 - 60, reason: 'INVARIANT_DRIFT', drift }, depsOverrides: { checkInvariants: () => (drift.length ? { ok: false, drift } : { ok: true }) } });
  verbs.raiseAlert(ctx, 'invariants', 'INVARIANT_DRIFT', 'drift');
  await verbs.alerts(ctx, {}, meta());
  await rejectsWith(verbs.unlock(ctx, {}, meta({ tokenKind: 'ops' })), 'WHY_REQUIRED');
  const error = await rejectsWith(verbs.unlock(ctx, { why: 'fixed' }, meta({ tokenKind: 'ops' })), 'INVARIANT_DRIFT');
  assert.equal(error.status, 503);
  assert.equal(error.detail.drift.length, 1);
  assert.ok(ctx.state.selfLocked);
  drift = [];
  const out = await verbs.unlock(ctx, { why: 'curator restored' }, meta({ tokenKind: 'ops' }));
  assert.deepEqual(out, { ok: true, selfLocked: null });
  assert.equal(ctx.state.selfLocked, null);
  assert.equal(ctx.state.alerts.get('invariants')?.resolvedAt > 0, true);
  assert.equal(records(ctx).find((r) => r.kind === 'unlock').args.why, 'curator restored');
  const again = await verbs.propose(ctx, { targets: NEW_TARGETS, why: 'after unlock' }, meta());
  assert.equal(again.ok, true);
});

test('pause and resume are journaled and idempotent; hermes-heartbeat sets the timestamp', async () => {
  const ctx = mk();
  assert.deepEqual(await verbs.pause(ctx, { why: 'incident' }, meta()), { ok: true, paused: true });
  assert.deepEqual(await verbs.pause(ctx, {}, meta()), { ok: true, paused: true });
  assert.equal(ctx.state.paused, true);
  assert.deepEqual(await verbs.resume(ctx, { why: 'over' }, meta({ tokenKind: 'ops' })), { ok: true, paused: false });
  assert.equal(ctx.state.paused, false);
  assert.deepEqual(records(ctx).map((r) => r.kind), ['pause', 'pause', 'resume']);
  const hb = await verbs.hermesHeartbeat(ctx, {}, meta({ session: 'cron', caller: 'curator-health.sh' }));
  assert.equal(hb.at, T0);
  assert.equal(ctx.state.hermesHeartbeatAt, T0);
  assert.equal(records(ctx).at(-1).caller, 'curator-health.sh');
});

test('note is bounded at 2 KB and journaled; journal clamps n', async () => {
  const ctx = mk();
  const out = await verbs.note(ctx, { text: 'lesson: ignore EXECUTION_COST on rebalance simulations' }, meta());
  assert.ok(out.journalId);
  await rejectsWith(verbs.note(ctx, { text: '' }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.note(ctx, { text: 'x'.repeat(2049) }, meta()), 'BAD_REQUEST');
  await rejectsWith(verbs.journal(ctx, { n: 'abc' }, meta()), 'BAD_REQUEST');
  await verbs.note(ctx, { text: 'two' }, meta());
  assert.equal((await verbs.journal(ctx, { n: '1' }, meta())).records.length, 1);
  assert.equal((await verbs.journal(ctx, {}, meta())).records.length, 2);
  assert.equal((await verbs.journal(ctx, { n: 100000 }, meta())).records.length, 2);
});

test('status converts PublicKey and BN fields and reports the machine, ledger and invariants', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ lastRebalanceAt: T0 - 100, pendingCurator: null }) });
  const out = await verbs.status(ctx, {}, meta());
  assert.equal(out.ok, true);
  assert.equal(out.portfolio.curator, WALLET);
  assert.equal(out.portfolio.pendingCurator, null);
  assert.equal(out.portfolio.lastRebalanceAt, T0 - 100);
  assert.equal(out.portfolio.rebalanceDelaySecs, 86400);
  assert.equal(out.portfolio.applyNextPage, 0);
  assert.equal(out.portfolio.state, 'active');
  assert.equal(out.signer.wallet, WALLET);
  assert.equal(out.signer.lamports, 100_000_000);
  assert.deepEqual(out.invariants, { ok: true, drift: [] });
  assert.equal(out.ledger.writeAttemptsLastHour, 0);
  assert.equal(out.policy.version, 1);
  assert.equal(out.apply.state, 'IDLE');
  assert.ok(!JSON.stringify(out).includes('"tx"'));
});

test('status survives a failed snapshot read with the last one and an error, and never leaks a URL', async () => {
  const ctx = mk();
  await verbs.status(ctx, {}, meta());
  ctx.deps.setSnapshot(() => { throw new Error('getAccountInfo failed for https://rpc.example.com/abc123'); });
  const out = await verbs.status(ctx, {}, meta());
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('<url>') && !out.error.includes('rpc.example.com'));
  assert.equal(out.portfolio.curator, WALLET, 'the last snapshot is used');
});

test('review returns the derived brief, bounded, and a hold when status is unavailable', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: () => ({ brief: 'x'.repeat(5000), triggers: [{ code: 'MONTHLY_REVIEW', detail: 'first monday' }], wakeAgent: true, holdReason: '' }) } });
  const out = await verbs.review(ctx, {}, meta());
  assert.equal(out.brief.length, 4096);
  assert.equal(out.wakeAgent, true);
  assert.equal(out.triggers[0].code, 'MONTHLY_REVIEW');
  ctx.deps.setSnapshot(() => { throw new Error('down'); });
  ctx.state.lastSnapshot = null;
  const hold = await verbs.review(ctx, {}, meta());
  assert.equal(hold.wakeAgent, false);
  assert.equal(hold.holdReason, 'STATUS_UNAVAILABLE');
});

test('simulate lists every policy refusal plus the chain blockers, filters WHY_REQUIRED without a why, builds nothing', async () => {
  const ctx = mk({ depsOverrides: {
    evaluateProposal: () => ({ ok: false, code: 'WHY_REQUIRED', message: 'why', refusals: [{ code: 'WHY_REQUIRED', message: 'why' }, { code: 'LEG_WEIGHT_CAP', message: 'pSOL 45% > 40%' }], summary: { turnoverBps: 1200 } }),
    proposeGates: () => ({ ok: false, blockers: [{ code: 'APPLY_IN_FLIGHT', action: 'blocked', message: 'page 2 of 3' }] }),
  } });
  const out = await verbs.simulate(ctx, { targets: NEW_TARGETS }, meta());
  assert.equal(out.ok, false);
  assert.deepEqual(out.refusals.map((r) => r.code), ['LEG_WEIGHT_CAP', 'APPLY_IN_FLIGHT']);
  assert.equal(out.summary.turnoverBps, 1200);
  assert.equal(ctx.client.calls.length, 0);
  assert.equal(records(ctx).length, 0, 'a simulation is not a write and is not journaled');
});

test('rotate-curator signs propose_curator and answers the accept steps for the key that is not on this box', async () => {
  const ctx = mk();
  const newCurator = KEYS.governance.toBase58();
  await rejectsWith(verbs.rotateCurator(ctx, { newCurator: 'not-a-key', why: 'x' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  await rejectsWith(verbs.rotateCurator(ctx, { newCurator: WALLET, why: 'x' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  const out = await verbs.rotateCurator(ctx, { newCurator, why: 'key rotation drill' }, meta({ tokenKind: 'ops' }));
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.client.calls.at(-2).body, { signer: WALLET, newCurator });
  assert.equal(out.next.step, 'accept_curator');
  assert.equal(out.next.build.path, `/v1/portfolios/${MINT}/curator/accept`);
  assert.deepEqual(out.next.build.body, { signer: newCurator });
  assert.equal(records(ctx).find((r) => r.kind === 'verb').verb, 'rotateCurator');
});

test('set-delay validates, builds with the curator and warns when the delay leaves the invariant', async () => {
  const ctx = mk();
  await rejectsWith(verbs.setDelay(ctx, { rebalanceDelaySecs: -1, why: 'x' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  await rejectsWith(verbs.setDelay(ctx, { rebalanceDelaySecs: 3600 }, meta({ tokenKind: 'ops' })), 'WHY_REQUIRED');
  const out = await verbs.setDelay(ctx, { rebalanceDelaySecs: 3600, why: 'dust rehearsal' }, meta({ tokenKind: 'ops' }));
  assert.deepEqual(ctx.client.calls.at(-2).body, { curator: WALLET, rebalanceDelaySecs: 3600 });
  assert.ok(out.warning.includes('86400'));
  const back = await verbs.setDelay(ctx, { rebalanceDelaySecs: 86400, why: 'back' }, meta({ tokenKind: 'ops' }));
  assert.equal(back.warning, undefined);
});

test('set-metadata validates the uri and builds with the signer', async () => {
  const ctx = mk();
  await rejectsWith(verbs.setMetadata(ctx, { uri: '', why: 'x' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  await rejectsWith(verbs.setMetadata(ctx, { uri: 'x'.repeat(129), why: 'x' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  const out = await verbs.setMetadata(ctx, { uri: 'https://www.weavr.sh/metadata/WEAVR', why: 'site move' }, meta({ tokenKind: 'ops' }));
  assert.equal(out.ok, true);
  assert.deepEqual(ctx.client.calls.at(-2).body, { signer: WALLET, uri: 'https://www.weavr.sh/metadata/WEAVR' });
});

test('refresh-nav builds with the payer and reports the page count', async () => {
  const ctx = mk();
  const out = await verbs.refreshNav(ctx, {}, meta({ session: 'cron' }));
  assert.equal(out.pages, 1);
  assert.deepEqual(ctx.client.calls[0].body, { payer: WALLET });
  assert.equal(records(ctx).find((r) => r.kind === 'verb').verb, 'refreshNav');
});

test('targetsEqual ignores order and zero weights; plain/num convert chain types', () => {
  assert.equal(verbs.targetsEqual([{ poolId: 'a', weightBps: 1 }, { poolId: 'b', weightBps: 2 }], [{ poolId: 'b', weightBps: 2 }, { poolId: 'a', weightBps: 1 }, { poolId: 'c', weightBps: 0 }]), true);
  assert.equal(verbs.targetsEqual([{ poolId: 'a', weightBps: 1 }], [{ poolId: 'a', weightBps: 2 }]), false);
  assert.equal(verbs.targetsEqual(null, []), false);
  const snap = fakeSnapshot();
  assert.equal(verbs.plain(snap.portfolioAccount.curator), WALLET);
  assert.equal(verbs.num(snap.vaultAccount.totalShares), 1_000_000_000);
  assert.equal(verbs.plain(snap.portfolioAccount.state), 'active');
  assert.equal(verbs.plain(10n), '10');
});

test('pendingOf parses the row\'s RFC 3339 timestamps into unix seconds and prefers the chain header\'s BN seconds', () => {
  const rfc = (secs) => new Date(secs * 1000).toISOString();
  const rowOnly = fakeSnapshot({ pending: { targets: NEW_TARGETS, proposedAt: rfc(T0), effectiveAt: rfc(T0 + 86400) } });
  assert.deepEqual(verbs.pendingOf(rowOnly), { effectiveAt: T0 + 86400, proposedAt: T0, targets: NEW_TARGETS.map((t) => ({ poolId: t.poolId, weightBps: t.weightBps })) });
  const withHeader = { ...rowOnly, portfolioAccount: { ...rowOnly.portfolioAccount, pendingTargets: { proposedAt: new BN(T0 - 5), effectiveAt: new BN(T0 + 86395) } } };
  assert.equal(verbs.pendingOf(withHeader).effectiveAt, T0 + 86395, 'the chain header wins over the row');
  assert.equal(verbs.pendingOf(withHeader).proposedAt, T0 - 5);
  const base = fakeSnapshot();
  const headerOnly = { ...base, portfolioAccount: { ...base.portfolioAccount, pendingTargets: { proposedAt: new BN(T0), effectiveAt: new BN(T0 + 10) } } };
  assert.deepEqual(verbs.pendingOf(headerOnly), { effectiveAt: T0 + 10, proposedAt: T0, targets: null }, 'a header the row has not caught up with still arms');
  assert.equal(verbs.pendingOf(fakeSnapshot()), null);
  assert.equal(verbs.pendingOf(fakeSnapshot({ pending: { targets: NEW_TARGETS, proposedAt: 'soon', effectiveAt: 'later' } })).effectiveAt, null, 'garbage is unknown, never a number');
  assert.equal(verbs.secsOf('2025-10-09T08:53:20.000Z'), T0);
  assert.equal(verbs.secsOf(String(T0)), T0);
  assert.equal(verbs.secsOf(new BN(T0)), T0);
  assert.equal(verbs.secsOf('not a date'), null);
  assert.equal(verbs.secsOf(''), null);
  assert.equal(verbs.secsOf(null), null);
});

test('a lookup-table miss refreshes the table once and re-verifies; a miss that persists refuses; other refusals never refresh', async () => {
  let refreshes = 0;
  let verifies = 0;
  const miss = { ok: false, code: 'UNKNOWN_INSTRUCTION', message: 'portfolio_factory.apply_targets account portfolio is loaded from a lookup table this process cannot resolve' };
  const ctx = mk({ depsOverrides: { verifyBuilt: ({ expect }) => { verifies += 1; return expect.lookupTables.size > 0 ? { ok: true, summary: {} } : miss; } } });
  ctx.chain.lookupTables = new Map();
  ctx.chain.refreshLookupTables = async () => { refreshes += 1; ctx.chain.lookupTables = new Map([['table', []]]); };
  const out = await verbs.applySend(ctx, meta({ session: 'cron' }));
  assert.equal(out.state, 'SENT');
  assert.equal(refreshes, 1);
  assert.equal(verifies, 2, 'verified once before and once after the refresh');
  assert.equal(ctx.signer.calls.length, 1);

  let stale = 0;
  const behind = mk({ depsOverrides: { verifyBuilt: () => miss } });
  behind.chain.refreshLookupTables = async () => { stale += 1; };
  const error = await rejectsWith(verbs.applySend(behind, meta({ session: 'cron' })), 'UNKNOWN_INSTRUCTION');
  assert.match(error.message, /lookup table/);
  assert.equal(stale, 1, 'one refresh, one retry, then the refusal');
  assert.equal(behind.signer.calls.length, 0);

  let untouched = 0;
  const other = mk({ depsOverrides: { verifyBuilt: () => ({ ok: false, code: 'WRONG_PAYER', message: 'fee payer is not the curator' }) } });
  other.chain.refreshLookupTables = async () => { untouched += 1; };
  await rejectsWith(verbs.applySend(other, meta({ session: 'cron' })), 'WRONG_PAYER');
  assert.equal(untouched, 0);

  const noRefresh = mk({ depsOverrides: { verifyBuilt: () => miss } });
  await rejectsWith(verbs.applySend(noRefresh, meta({ session: 'cron' })), 'UNKNOWN_INSTRUCTION');
  assert.equal(noRefresh.signer.calls.length, 0, 'without a refresh a miss is still a refusal');
});

test('writes are held INVARIANTS_UNVERIFIED while the loop could not verify an invariant; cancel and the ops verbs pass; the hold lifts with the state', async () => {
  const ctx = mk();
  ctx.state.invariantsUnverified = ['accountant.recipient1'];
  const error = await rejectsWith(verbs.deposit(ctx, { amountUsd: 10 }, meta()), 'INVARIANTS_UNVERIFIED');
  assert.deepEqual(error.detail.unverified, ['accountant.recipient1']);
  assert.equal(error.journaled, true);
  await rejectsWith(verbs.propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()), 'INVARIANTS_UNVERIFIED');
  await rejectsWith(verbs.applySend(ctx, meta({ session: 'cron' })), 'INVARIANTS_UNVERIFIED');
  await rejectsWith(verbs.refreshNav(ctx, {}, meta()), 'INVARIANTS_UNVERIFIED');
  assert.equal(ctx.client.calls.length, 0);
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal((await verbs.cancel(ctx, { why: 'stop' }, meta())).ok, true);
  assert.equal((await verbs.setDelay(ctx, { rebalanceDelaySecs: 86400, why: 'x' }, meta({ tokenKind: 'ops' }))).ok, true);
  assert.deepEqual((await verbs.status(ctx, {}, meta())).invariantsUnverified, ['accountant.recipient1']);
  ctx.state.invariantsUnverified = null;
  assert.equal((await verbs.deposit(ctx, { amountUsd: 10 }, meta())).ok, true);
  assert.equal((await verbs.status(ctx, {}, meta())).invariantsUnverified, null);
  assert.equal(records(ctx).filter((r) => r.kind === 'refusal' && r.code === 'INVARIANTS_UNVERIFIED').length, 4);
});

test('status reports the invariants the check could not verify without calling them drift', async () => {
  const ctx = mk({ depsOverrides: { checkInvariants: () => ({ ok: true, unverified: ['factory.guardian'] }) } });
  const out = await verbs.status(ctx, {}, meta());
  assert.deepEqual(out.invariants, { ok: true, drift: [], unverified: ['factory.guardian'] });
});

// ------------------------------------------------- the operator's wake request
//
// These run the REAL `deriveReview`. Every other review test here stubs it, and
// `metrics.test.js` calls it directly with a notepad no production caller ever
// passes — which is exactly how OPERATOR_REQUEST came to be unreachable on a
// live signer while both suites stayed green. The join is the thing under test.

test('an operator request reaches the real wake gate, and wakes the agent', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  const quiet = await verbs.review(ctx, {}, meta());
  assert.equal(quiet.wakeAgent, false, 'nothing is wrong with this book on its own');

  const set = await verbs.operatorRequest(ctx, { text: 'Review the SOL concentration', why: 'demo' }, meta({ tokenKind: 'ops' }));
  assert.equal(set.ok, true);
  assert.equal(ctx.state.operatorRequest.text, 'Review the SOL concentration');

  const woken = await verbs.review(ctx, {}, meta());
  assert.equal(woken.wakeAgent, true, 'the request must reach deriveReview through statusBody');
  const trigger = woken.triggers.find((entry) => entry.code === 'OPERATOR_REQUEST');
  assert.ok(trigger, `expected OPERATOR_REQUEST, got ${JSON.stringify(woken.triggers)}`);
  assert.match(trigger.detail, /SOL concentration/);
});

test('one request, one wake: reporting it consumes it', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await verbs.operatorRequest(ctx, { text: 'look again', why: 'demo' }, meta({ tokenKind: 'ops' }));
  const first = await verbs.review(ctx, {}, meta());
  assert.equal(first.wakeAgent, true);

  const second = await verbs.review(ctx, {}, meta());
  assert.equal(second.wakeAgent, false, 'a standing request would wake the agent every review forever');
  assert.equal(ctx.state.operatorRequest, null);
  const kinds = ctx.journal.tail(50).map((record) => record.kind);
  assert.ok(kinds.includes('operator-request'), 'the request is journaled');
  assert.ok(kinds.includes('operator-request-consumed'), 'so is its consumption');
});

test('a request outlives a restart, and a consumed one does not come back', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await verbs.operatorRequest(ctx, { text: 'still pending', why: 'demo' }, meta({ tokenKind: 'ops' }));
  assert.equal(ctx.journal.rebuildLedger({ now: T0 }).operatorRequest?.text, 'still pending');

  await verbs.review(ctx, {}, meta());
  assert.equal(ctx.journal.rebuildLedger({ now: T0 }).operatorRequest, null, 'the consumption is replayed too');
});

test('the operator request refuses an empty or oversized text, and clears on request', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await rejectsWith(verbs.operatorRequest(ctx, { text: '   ', why: 'demo' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');
  await rejectsWith(verbs.operatorRequest(ctx, { text: 'x'.repeat(201), why: 'demo' }, meta({ tokenKind: 'ops' })), 'BAD_REQUEST');

  await verbs.operatorRequest(ctx, { text: 'never mind', why: 'demo' }, meta({ tokenKind: 'ops' }));
  const cleared = await verbs.operatorRequest(ctx, { clear: true, why: 'demo' }, meta({ tokenKind: 'ops' }));
  assert.equal(cleared.cleared, true);
  const out = await verbs.review(ctx, {}, meta());
  assert.equal(out.wakeAgent, false, 'a cleared request wakes nobody');
});

test('a universe or weekly review reports the request but does not take it', async () => {
  // The three cron scripts all call GET /review: the gate bare, curator-universe
  // with ?mode=universe, curator-weekly with ?mode=weekly. Universe emits no wake
  // line and weekly may not propose, so a request consumed by either is destroyed
  // on behalf of a job that cannot act on it — and universe runs four times a day,
  // which would make "set it the evening before" quietly impossible.
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await verbs.operatorRequest(ctx, { text: 'look at the SOL concentration', why: 'demo' }, meta({ tokenKind: 'ops' }));

  for (const mode of ['universe', 'weekly']) {
    const out = await verbs.review(ctx, { mode }, meta());
    assert.ok(out.triggers.some((t) => t.code === 'OPERATOR_REQUEST'), `${mode} still reports the request`);
    assert.equal(ctx.state.operatorRequest?.text, 'look at the SOL concentration', `${mode} must not consume it`);
  }

  const review = await verbs.review(ctx, {}, meta());
  assert.equal(review.wakeAgent, true, 'the review that can act still wakes');
  assert.equal(ctx.state.operatorRequest, null, 'and it is the one that consumes');
  assert.equal(ctx.journal.tail(50).filter((r) => r.kind === 'operator-request-consumed').length, 1,
    'exactly one consumption, from the plain review');
});

test('an explicit mode=review consumes, the same as no mode at all', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await verbs.operatorRequest(ctx, { text: 'check it', why: 'demo' }, meta({ tokenKind: 'ops' }));
  const out = await verbs.review(ctx, { mode: 'review' }, meta());
  assert.equal(out.wakeAgent, true);
  assert.equal(ctx.state.operatorRequest, null);
});

test('operator-request is an ops verb and is routed', () => {
  assert.ok(OPS_VERBS.has('operator-request'), 'the agent must not be able to wake itself');
  const route = ROUTES.find((row) => row[1] === '/operator-request');
  assert.ok(route, 'the verb needs a route or nothing can call it');
  assert.deepEqual([route[0], route[2], route[3].tokenKind], ['POST', 'operator-request', 'ops']);
  assert.equal(typeof verbs.VERBS['operator-request'], 'function');
});

// ------------------------------------------- the streak and the stored tiers
//
// LEG_NEEDS_INFLOW and RISK_TIER_RAISED read a notepad no production caller
// ever passed: the five-argument call handed deriveReview `{}` every review, so
// the streak restarted at one each time and no tier was ever stored, while
// metrics.test.js proved both triggers on a notepad it wrote by hand. The
// notepad is now the signer's own journal, and these run the REAL deriveReview
// through the real verb. Every count and every window below is read from the
// policy the ctx carries, never written into the test, and the join is proven
// rather than assumed: a variant policy moves the gate and the wake moves with
// it (metrics.js has defaults of its own, and a fixture that happens to equal
// them proves nothing). Plain reviews here come from the daily gate (a cron
// session) a day apart: only the gate advances the streak, at most once per
// UTC day, and a chat review never does.

const DAY = 86400;
/** pSOL well under its target; the drift band is the row's `driftBandBps`, and ten points is far outside it. */
const LEGS_UNDER = LEGS.map((leg) => (leg.poolId === 'pSOL' ? { ...leg, weightBps: 3000, valueUsdc: 300 } : leg));
const GATES = POLICY.review.legNeedsInflowGates;
/** The daily gate: curator-review-gate.sh calls the plain review from a cron session. */
const gate = (over = {}) => meta({ session: 'cron', caller: 'curator-review-gate.sh', ...over });
const NO_INFLOW_DAYS = POLICY.review.legNoInflowDays;
/** A policy under which the signer can never top up: the day's cap is zero. */
const SPENT_POLICY = Object.freeze({ ...POLICY, deposit: { ...POLICY.deposit, dailyCapUsd: 0 } });
const reviewRecords = (ctx) => records(ctx).filter((r) => r.kind === 'review');
const inflow = (out) => out.triggers.find((t) => t.code === 'LEG_NEEDS_INFLOW');
const raised = (out) => out.triggers.find((t) => t.code === 'RISK_TIER_RAISED');
/** A ctx over the real deriveReview with pSOL under target and the top-up budget spent. */
const streakCtx = (over = {}) => mk({ depsOverrides: { deriveReview: realDeriveReview }, snapshot: fakeSnapshot({ legs: LEGS_UNDER }), policy: SPENT_POLICY, ...over });
/** The default snapshot with some pools' risk tiers changed: `{ poolId: riskTier }`. */
const tierSnapshot = (tiers) => withPoolKeys({ ...fakeSnapshot(), pools: POOLS.map((pool) => (pool.poolId in tiers ? { ...pool, riskTier: tiers[pool.poolId] } : pool)) });
/** `count` plain reviews on consecutive UTC days (the clock stays on the last one's day); the last output. */
const dailyReviews = async (ctx, count, m = gate()) => {
  let out;
  for (let n = 0; n < count; n += 1) {
    if (n > 0) ctx.clock.advance(DAY);
    out = await verbs.review(ctx, {}, m);
  }
  return out;
};
/** Seed a ctx the way index.js boot() does: from the journal alone. */
const seedFromJournal = (ctx) => {
  const ledger = ctx.journal.rebuildLedger({ now: Math.floor(ctx.now() / 1000) });
  ctx.state = verbs.initialState({ reviewState: ledger.reviewState, ledger });
  ctx.state.ledgerFromJournal = true;
  return ledger;
};

test('an asset under target for the policy\'s count of plain reviews, no inflow ever and the top-up budget spent wakes the agent: LEG_NEEDS_INFLOW', async () => {
  assert.ok(GATES >= 2, 'the fixture must ask for more than one review or the streak is not under test');
  const ctx = streakCtx();
  for (let n = 1; n < GATES; n += 1) {
    const out = await verbs.review(ctx, {}, meta({ session: 'cron' }));
    assert.equal(ctx.state.reviewState.driftStreak.pSOL, n, `streak after review ${n}`);
    assert.equal(inflow(out), undefined, `review ${n} of ${GATES} must not wake yet`);
    assert.equal(out.wakeAgent, false);
    ctx.clock.advance(DAY);
  }
  const woken = await verbs.review(ctx, {}, meta({ session: 'cron' }));
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, GATES);
  const trigger = inflow(woken);
  assert.ok(trigger, `expected LEG_NEEDS_INFLOW, got ${JSON.stringify(woken.triggers)}`);
  assert.match(trigger.detail, new RegExp(`^pSOL -10% under target for ${GATES} reviews, no deposit for an unknown time, top-up budget spent$`));
  assert.equal(woken.wakeAgent, true);
  assert.equal(woken.triggers.filter((t) => t.code === 'LEG_NEEDS_INFLOW').length, 1, 'the assets on target have no streak');
  assert.deepEqual(ctx.state.reviewState.driftStreak, { pSOL: GATES, pCBBTC: 0, pUSDT: 0 });
  assert.equal(reviewRecords(ctx).at(-1).triggers.includes('LEG_NEEDS_INFLOW'), true, 'the record says what woke the agent');
});

test('planted: the budget not spent, or a deposit inside the no-inflow window, holds LEG_NEEDS_INFLOW back at the full streak; a deposit outside it does not', async () => {
  // Budget not spent: the fixture's daily cap with nothing deposited today.
  const unspent = streakCtx({ policy: POLICY });
  for (let n = 0; n < GATES; n += 1) { await verbs.review(unspent, {}, gate()); unspent.clock.advance(DAY); }
  assert.equal(unspent.state.reviewState.driftStreak.pSOL, GATES, 'the streak counts all the same');
  const held = await verbs.review(unspent, {}, gate());
  assert.equal(inflow(held), undefined, 'the signer can still top up, so nobody is woken');
  assert.equal(held.wakeAgent, false);
  assert.equal((await verbs.status(unspent, {}, meta())).ledger.topUpBudgetSpent, false);

  // A deposit two days before the review that completes the streak: journaled with the clock moved back, then
  // the ledger rebuilt the way boot does.
  const lastReviewAt = T0 + (GATES - 1) * DAY;
  const recent = streakCtx();
  recent.clock.set((lastReviewAt - 2 * DAY) * 1000);
  recent.journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 10 } });
  recent.clock.set(T0_MS);
  assert.equal(seedFromJournal(recent).lastDepositAt, lastReviewAt - 2 * DAY);
  assert.ok(2 < NO_INFLOW_DAYS, 'two days must be inside the fixture window');
  let out = await dailyReviews(recent, GATES);
  assert.equal(recent.state.reviewState.driftStreak.pSOL, GATES);
  assert.equal(inflow(out), undefined, 'a deposit inside the no-inflow window is an inflow');
  assert.equal((await verbs.status(recent, {}, meta())).ledger.lastDepositAt, lastReviewAt - 2 * DAY, 'the date is what reached deriveReview');

  // The same deposit one day past the window: no inflow, and the detail counts the days from the journal's date.
  const stale = streakCtx();
  stale.clock.set((lastReviewAt - (NO_INFLOW_DAYS + 1) * DAY) * 1000);
  stale.journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 10 } });
  stale.clock.set(T0_MS);
  seedFromJournal(stale);
  out = await dailyReviews(stale, GATES);
  assert.ok(inflow(out), `expected LEG_NEEDS_INFLOW, got ${JSON.stringify(out.triggers)}`);
  assert.match(inflow(out).detail, new RegExp(`no deposit for ${NO_INFLOW_DAYS + 1} d, top-up budget spent$`));
});

test('topUpBudgetSpent: deposit denied by policy, a zero cap, and deposits that reach the day\'s cap each spend it; on the launch day the launch-day cap is the one that counts', async () => {
  const spentOf = async (ctx) => (await verbs.status(ctx, {}, meta())).ledger.topUpBudgetSpent;
  assert.equal(await spentOf(mk()), false, 'the fixture: a cap and nothing deposited');
  assert.equal(await spentOf(mk({ policy: SPENT_POLICY })), true, 'a zero cap');
  assert.equal(await spentOf(mk({ policy: { ...POLICY, verbs: { ...POLICY.verbs, denied: [...POLICY.verbs.denied, 'deposit'] } } })), true, 'deposit denied outright');
  assert.equal(await spentOf(mk({ policy: { version: 1 } })), false, 'a fixture without deposit rules reads as not spent, never as a crash');

  // Deposits through the real verb, up to the day's cap.
  const cap = POLICY.deposit.dailyCapUsd;
  const capped = mk();
  await verbs.deposit(capped, { amountUsd: cap / 2 }, meta());
  assert.equal(await spentOf(capped), false, 'half the cap');
  await verbs.deposit(capped, { amountUsd: cap / 2 }, meta());
  assert.equal(await spentOf(capped), true, 'the cap reached');
  assert.equal(capped.state.ledger.depositsTodayUsd, cap);

  // The same deposits on the launch day, whose cap is the larger one in the fixture.
  assert.ok(POLICY.deposit.launchDayCapUsd > cap, 'the fixture launch-day cap must exceed the daily cap for this to mean anything');
  const launch = mk({ policy: { ...POLICY, deposit: { ...POLICY.deposit, launchDay: utcDay(T0) } } });
  await verbs.deposit(launch, { amountUsd: cap / 2 }, meta());
  await verbs.deposit(launch, { amountUsd: cap / 2 }, meta());
  assert.equal(await spentOf(launch), false, 'the daily cap is reached but the launch-day cap is the one in force');
  // The day after: the ledger is the journal's view, rebuilt on every append and at boot; rebuilt for the new day,
  // yesterday's deposits are not today's, and the launch-day cap no longer applies.
  launch.clock.advance(DAY);
  seedFromJournal(launch);
  assert.equal(launch.state.ledger.depositsTodayUsd, 0);
  assert.equal(await spentOf(launch), false);
  await verbs.deposit(launch, { amountUsd: cap }, meta());
  assert.equal(await spentOf(launch), true, 'off the launch day the daily cap is back in force');

  // The denied branch reaches the wake gate through the real review.
  const denied = streakCtx({ policy: { ...POLICY, verbs: { ...POLICY.verbs, denied: [...POLICY.verbs.denied, 'deposit'] } } });
  const out = await dailyReviews(denied, GATES);
  assert.ok(inflow(out), 'a signer that may never deposit has its budget spent from the start');
});

test('universe and weekly reviews read the stored streak but never advance or journal it: plain, universe, weekly, plain is a streak of two', async () => {
  const ctx = streakCtx();
  await verbs.review(ctx, {}, gate());
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 1);
  for (const mode of ['universe', 'weekly']) {
    const out = await verbs.review(ctx, { mode }, gate());
    assert.match(out.brief, /pSOL:.*needs inflow, 2 reviews running/, `${mode} counts on from the stored streak of one`);
    assert.equal(ctx.state.reviewState.driftStreak.pSOL, 1, `${mode} must not advance the streak`);
  }
  ctx.clock.advance(DAY);
  const plain = await verbs.review(ctx, {}, gate());
  assert.match(plain.brief, /pSOL:.*needs inflow, 2 reviews running/);
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 2, 'two, not four: only the plain reviews count');
  const journaled = reviewRecords(ctx);
  assert.equal(journaled.length, 2, 'one review record per plain review, none for universe or weekly');
  assert.deepEqual(journaled.map((r) => r.driftStreak.pSOL), [1, 2]);
  assert.equal(ctx.journal.rebuildLedger({ now: T0 }).reviewState.driftStreak.pSOL, 2, 'the file agrees');
  ctx.clock.advance(DAY);
  await verbs.review(ctx, { mode: 'review' }, gate());
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 3, 'an explicit mode=review is the plain review');
});

test('a restart replays the streak from the journal: the policy\'s count less one stored, the next plain review completes it and wakes', async () => {
  const first = streakCtx();
  await dailyReviews(first, GATES - 1);
  assert.equal(first.state.reviewState.driftStreak.pSOL, GATES - 1);
  // A fresh process over the same file: a new Journal on the path, the state seeded the way index.js boot() does.
  const journal = new Journal({ file: first.journal.file, now: first.clock.now, stdout: null });
  const second = streakCtx({ journal, clock: first.clock });
  assert.equal(second.state.reviewState, null, 'nothing in memory');
  seedFromJournal(second);
  assert.equal(second.state.reviewState.driftStreak.pSOL, GATES - 1, 'seeded from the file');
  first.clock.advance(DAY);
  const woken = await verbs.review(second, {}, gate());
  assert.equal(second.state.reviewState.driftStreak.pSOL, GATES);
  assert.ok(inflow(woken), `expected LEG_NEEDS_INFLOW after the restart, got ${JSON.stringify(woken.triggers)}`);
  assert.equal(reviewRecords(second).length, GATES, 'one file, every plain review on it');
});

test('a gap does not reset the streak: a review record ten days old still seeds the next plain review', async () => {
  // The decision, written down: the last journaled review seeds the next one whatever its age. The asset was under
  // target before the gap, and nothing during a gap (a pod down, a paused cron) can heal it without a review seeing
  // it; a review that sees it on target drops the streak to zero by itself. Resetting on age would let every outage
  // buy the asset another full run of reviews before anyone is woken.
  const ctx = streakCtx();
  ctx.clock.set(T0_MS - 10 * DAY * 1000);
  ctx.journal.append({ kind: 'review', driftStreak: { pSOL: GATES - 1, pCBBTC: 0, pUSDT: 0 }, riskTiers: { pSOL: 2, pCBBTC: 2, pUSDT: 2 }, triggers: [] });
  ctx.clock.set(T0_MS);
  const ledger = seedFromJournal(ctx);
  assert.equal(ledger.reviewState.at, T0 - 10 * DAY, 'the seed is ten days old');
  const woken = await verbs.review(ctx, {}, gate());
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, GATES, 'the ten-day-old streak carried');
  assert.ok(inflow(woken), `expected LEG_NEEDS_INFLOW, got ${JSON.stringify(woken.triggers)}`);
  assert.equal(ctx.state.reviewState.at, T0, 'and the new record is dated now');
  // The streak heals only through the chain: on target again, it is zero, however old the seed.
  ctx.deps.setSnapshot(withPoolKeys(fakeSnapshot()));
  ctx.clock.advance(DAY);
  const healed = await verbs.review(ctx, {}, gate());
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 0);
  assert.equal(inflow(healed), undefined);
});

test('RISK_TIER_RAISED: the plain review stores the tiers it saw; a held pool\'s tier rising wakes once, and the review that stored the new tier does not wake again', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  const quiet = await verbs.review(ctx, {}, gate());
  assert.equal(quiet.wakeAgent, false);
  assert.deepEqual(ctx.state.reviewState.riskTiers, { pSOL: 2, pCBBTC: 2, pUSDT: 2 }, 'the held pools\' tiers, from the catalogue rows');
  ctx.deps.setSnapshot(tierSnapshot({ pSOL: 3 }));
  ctx.clock.advance(DAY);
  const woken = await verbs.review(ctx, {}, gate());
  const trigger = raised(woken);
  assert.ok(trigger, `expected RISK_TIER_RAISED, got ${JSON.stringify(woken.triggers)}`);
  assert.equal(trigger.detail, 'pSOL risk tier 2 → 3');
  assert.equal(woken.wakeAgent, true);
  assert.equal(ctx.state.reviewState.riskTiers.pSOL, 3, 'the raised tier is what the next review compares against');
  assert.deepEqual(reviewRecords(ctx).at(-1).triggers, ['RISK_TIER_RAISED']);
  ctx.clock.advance(DAY);
  const again = await verbs.review(ctx, {}, gate());
  assert.equal(raised(again), undefined, 'one raise, one wake');
  assert.equal(again.wakeAgent, false);
  // A tier that falls is not a raise, and the lower tier is stored in its turn.
  ctx.deps.setSnapshot(tierSnapshot({ pSOL: 1 }));
  ctx.clock.advance(DAY);
  const fell = await verbs.review(ctx, {}, gate());
  assert.equal(raised(fell), undefined);
  assert.equal(ctx.state.reviewState.riskTiers.pSOL, 1);
  // A pool that is not held does not count, whatever its tier does.
  ctx.deps.setSnapshot(tierSnapshot({ pSOL: 1, pMSOL: 4 }));
  ctx.clock.advance(DAY);
  assert.equal(raised(await verbs.review(ctx, {}, gate())), undefined);
  assert.equal(ctx.state.reviewState.riskTiers.pMSOL, undefined, 'only held pools are stored');
});

test('a universe review between the raise and the plain review does not store the raised tier, so the plain review still wakes', async () => {
  const ctx = mk({ depsOverrides: { deriveReview: realDeriveReview } });
  await verbs.review(ctx, {}, gate());
  ctx.deps.setSnapshot(tierSnapshot({ pSOL: 3 }));
  for (const mode of ['universe', 'weekly']) {
    const out = await verbs.review(ctx, { mode }, gate());
    assert.ok(raised(out), `${mode} reads the stored tiers and reports the raise`);
    assert.equal(ctx.state.reviewState.riskTiers.pSOL, 2, `${mode} stores nothing`);
  }
  ctx.clock.advance(DAY);
  const plain = await verbs.review(ctx, {}, gate());
  assert.ok(raised(plain), 'the review that can act still sees the raise');
  assert.equal(ctx.state.reviewState.riskTiers.pSOL, 3);
  assert.equal(reviewRecords(ctx).length, 2, 'two plain reviews, two records');
});

test('the join is the six-argument form: an empty notepad before any review, the journal\'s streak and tiers after; one review record per plain review', async () => {
  const seen = [];
  const ctx = mk({
    depsOverrides: { deriveReview: (...args) => { seen.push(args); return realDeriveReview(...args); } },
    snapshot: fakeSnapshot({ legs: LEGS_UNDER }),
  });
  assert.equal(ctx.state.reviewState, null);
  const cron = meta({ caller: 'curator-review-gate.sh', session: 'cron' });
  await verbs.review(ctx, {}, cron);
  assert.equal(seen[0].length, 6);
  assert.deepEqual(seen[0][4], {}, 'no stored state: an empty notepad, never undefined');
  assert.equal(seen[0][5], T0, 'now is the sixth argument');
  ctx.clock.advance(DAY);
  await verbs.review(ctx, {}, cron);
  const notepad = seen[1][4];
  assert.deepEqual(Object.keys(notepad).sort(), ['drift_streak', 'risk_tiers']);
  assert.equal(typeof notepad.drift_streak, 'string', 'the shape metrics.note() parses: JSON strings, as the cron notepad carried them');
  assert.deepEqual(JSON.parse(notepad.drift_streak), { pSOL: 1, pCBBTC: 0, pUSDT: 0 });
  assert.deepEqual(JSON.parse(notepad.risk_tiers), { pSOL: 2, pCBBTC: 2, pUSDT: 2 });
  const journaled = reviewRecords(ctx);
  assert.equal(journaled.length, 2);
  for (const [i, record] of journaled.entries()) {
    assert.deepEqual(record.driftStreak, { pSOL: i + 1, pCBBTC: 0, pUSDT: 0 });
    assert.deepEqual(record.riskTiers, { pSOL: 2, pCBBTC: 2, pUSDT: 2 });
    assert.deepEqual(record.triggers, []);
    assert.equal(record.caller, 'curator-review-gate.sh');
    assert.equal(record.session, 'cron');
    assert.equal(record.tokenKind, 'agent');
    assert.equal(record.redacted, undefined, 'nothing in a review record is secret-shaped');
  }
  // The stubbed deriveReview (no metrics) journals nothing: there is nothing to carry.
  const stub = mk();
  await verbs.review(stub, {}, gate());
  assert.equal(reviewRecords(stub).length, 0);
  assert.equal(stub.state.reviewState, null);
  // Nothing the caller sends reaches the notepad: the streak is the signer's, never a request parameter.
  const planted = mk({ depsOverrides: { deriveReview: (...args) => { seen.push(args); return realDeriveReview(...args); } } });
  seen.length = 0;
  await verbs.review(planted, { drift_streak: '{"pSOL":99}', driftStreak: { pSOL: 99 }, risk_tiers: '{"pSOL":1}', notepad: { drift_streak: '{"pSOL":99}' } }, gate());
  assert.deepEqual(seen[0][4], {});
  assert.equal(planted.state.reviewState.driftStreak.pSOL, 0);
});

test('policy is a read: the loaded document, its version and a digest that matches status; key order does not change the digest, a value does; never journaled', async () => {
  const ctx = mk();
  const out = await verbs.policy(ctx, {}, meta());
  assert.equal(out.version, 1);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.policy, ctx.policy, 'the document itself, not a summary');
  assert.equal(out.sha256, canonicalSha256(POLICY));
  assert.equal((await verbs.status(ctx, {}, meta())).policy.sha256, out.sha256);
  assert.equal(ctx.policyDigest, out.sha256, 'remembered on the ctx');
  assert.equal(records(ctx).length, 0, 'a read is not journaled');
  assert.equal(ctx.state.ledger.writeAttempts.length, 0, 'nor a write attempt');
  const reordered = mk({ policy: Object.fromEntries(Object.entries(POLICY).reverse()) });
  assert.equal((await verbs.policy(reordered, {}, meta())).sha256, out.sha256);
  const changed = mk({ policy: { ...POLICY, review: { ...POLICY.review, legNeedsInflowGates: GATES + 1 } } });
  assert.notEqual((await verbs.policy(changed, {}, meta())).sha256, out.sha256);
  const route = ROUTES.find((row) => row[1] === '/policy');
  assert.deepEqual([route[0], route[2], route[3].tokenKind], ['GET', 'policy', 'agent']);
  assert.equal(verbs.VERBS.policy, verbs.policy);
  assert.ok(!verbs.WRITE_VERBS.has('policy') && !OPS_VERBS.has('policy'));
});

test('planted: only the daily gate advances the streak: chat never persists, cron persists once per UTC day, three cron days are three reviews', async () => {
  // The agent's own `review` tool is the plain GET /review (the Claw Agent plugin sends no mode and its skill calls
  // it on every owner message). If every plain call advanced the streak, the model could mint the LEG_NEEDS_INFLOW
  // gate in seconds from chat, and "consecutive reviews" would mean "consecutive calls". And if a chat review
  // could be the day's record, an owner's 03:00 question would store a tier raised overnight before the 09:00 gate
  // ever saw it. So chat reads and never writes; the cron gate writes once a UTC day.
  const same = streakCtx();
  const chat = meta({ session: 'chat', caller: 'the-model' });
  for (let n = 0; n < 3; n += 1) {
    const out = await verbs.review(same, {}, chat);
    assert.equal(same.state.reviewState, null, `chat call ${n + 1}: nothing persisted`);
    assert.equal(inflow(out), undefined, 'no wake minted from chat');
    assert.equal(out.wakeAgent, false);
  }
  assert.equal(reviewRecords(same).length, 0, 'chat journals no review record');
  same.clock.advance(DAY);
  await verbs.review(same, {}, chat);
  assert.equal(same.state.reviewState, null, 'a new UTC day changes nothing for chat');

  // The gate persists once; a second cron call the same day (the model's own tool call inside the cron run reports
  // cron too) reads the stored state the way universe and weekly do: it counts on from it in the brief and changes nothing.
  const first = await verbs.review(same, {}, gate());
  assert.equal(same.state.reviewState.driftStreak.pSOL, 1, 'the gate persists');
  assert.equal(first.wakeAgent, false);
  same.clock.advance(3600);
  const later = await verbs.review(same, {}, gate({ caller: 'hermes' }));
  assert.match(later.brief, /pSOL:.*needs inflow, 2 reviews running/);
  assert.equal(same.state.reviewState.driftStreak.pSOL, 1, 'the second cron review of the day does not advance it');
  assert.equal(reviewRecords(same).length, 1, 'one review record for the day');
  // and a chat review after the gate reads the gate's record without touching it
  const afterGate = await verbs.review(same, {}, chat);
  assert.match(afterGate.brief, /needs inflow, 2 reviews running/);
  assert.equal(reviewRecords(same).length, 1);

  // The boundary is the UTC day, not 24 hours: a gate just before midnight and one just after are two days.
  const midnight = streakCtx();
  const endOfDay = Date.UTC(2025, 9, 9, 23, 59, 30) / 1000;
  midnight.clock.set(endOfDay * 1000);
  await verbs.review(midnight, {}, gate());
  midnight.clock.advance(60);
  assert.notEqual(utcDay(endOfDay), utcDay(endOfDay + 60), 'the minute crosses midnight UTC');
  await verbs.review(midnight, {}, gate());
  assert.equal(midnight.state.reviewState.driftStreak.pSOL, 2, 'a new UTC day, a new review');
  assert.equal(reviewRecords(midnight).length, 2);

  // Three gate reviews on three UTC days are three reviews and the wake.
  const days = streakCtx();
  const woken = await dailyReviews(days, GATES, gate());
  assert.equal(days.state.reviewState.driftStreak.pSOL, GATES);
  assert.equal(reviewRecords(days).length, GATES);
  assert.ok(inflow(woken), `expected LEG_NEEDS_INFLOW on day ${GATES}, got ${JSON.stringify(woken.triggers)}`);
});

test('planted: a review over a stale snapshot reads but does not persist, and a failed journal write leaves the state untouched', async () => {
  // A streak counted on yesterday's weights is not a review: when this call's snapshot read failed and the last
  // snapshot was reused, the gate still answers (the cron needs its wake line) but stores nothing.
  const ctx = streakCtx();
  await verbs.review(ctx, {}, gate());
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 1);
  ctx.clock.advance(DAY);
  ctx.deps.setSnapshot(() => { throw new Error('getAccountInfo failed for https://rpc.example.com/abc123'); });
  const stale = await verbs.review(ctx, {}, gate());
  assert.equal(typeof stale.brief, 'string', 'the stale review still answers');
  assert.equal(ctx.state.reviewState.driftStreak.pSOL, 1, 'nothing persisted on a stale snapshot');
  assert.equal(reviewRecords(ctx).length, 1);
  assert.ok(!JSON.stringify(stale).includes('rpc.example.com'), 'no URL in the answer');

  // The journal is the source and memory follows it: an append that fails must not move the state ahead of the file.
  const fresh = streakCtx();
  await verbs.review(fresh, {}, gate());
  fresh.clock.advance(DAY);
  const append = fresh.journal.append.bind(fresh.journal);
  fresh.journal.append = (record) => { if (record.kind === 'review') throw new Error('EIO disk gone'); return append(record); };
  const out = await verbs.review(fresh, {}, gate());
  assert.equal(typeof out.brief, 'string');
  assert.equal(fresh.state.reviewState.driftStreak.pSOL, 1, 'the state did not advance past what the journal holds');
  assert.ok(fresh.logs.some((l) => l.event === 'journal-append-failed'), 'the failure is logged');
  fresh.journal.append = append;
  const retry = await verbs.review(fresh, {}, gate());
  assert.equal(fresh.state.reviewState.driftStreak.pSOL, 2, 'the same day is still open once the write succeeds');
  assert.equal(typeof retry.brief, 'string');
});

test('the thresholds deriveReview enforces are the policy the signer loaded, not metrics.js defaults: a variant policy moves the gate and the wake moves with it', async () => {
  // status.policy.review is the loaded section, whole; without it deriveReview would fall back to its own defaults
  // and GET /policy would advertise counts that are not the ones in force.
  const status = await verbs.status(streakCtx(), {}, meta());
  assert.deepEqual(status.policy.review, SPENT_POLICY.review, 'the loaded review section reaches deriveReview through status');
  assert.deepEqual(Object.keys(status.policy), ['version', 'sha256', 'review']);

  // One more gate than the fixture asks for: the review at the fixture's count must not wake, the next one must.
  const strictPolicy = { ...SPENT_POLICY, review: { ...POLICY.review, legNeedsInflowGates: GATES + 1 } };
  const strict = streakCtx({ policy: strictPolicy });
  const held = await dailyReviews(strict, GATES);
  assert.equal(strict.state.reviewState.driftStreak.pSOL, GATES, 'the streak counts the same');
  assert.equal(inflow(held), undefined, 'the fixture\'s count is one short under the variant policy');
  assert.equal(held.wakeAgent, false);
  strict.clock.advance(DAY);
  const woken = await verbs.review(strict, {}, gate());
  assert.ok(inflow(woken), `expected LEG_NEEDS_INFLOW at ${GATES + 1}, got ${JSON.stringify(woken.triggers)}`);
  assert.match(inflow(woken).detail, new RegExp(`under target for ${GATES + 1} reviews`));
  const strictStatus = await verbs.status(strict, {}, meta());
  assert.equal(strictStatus.policy.review.legNeedsInflowGates, GATES + 1);
  assert.notEqual(strictStatus.policy.sha256, status.policy.sha256, 'a different document, a different digest');
  assert.equal(strictStatus.policy.sha256, (await verbs.policy(strict, {}, meta())).sha256, 'the digest names the document whose counts are in force');

  // The no-inflow window too: a deposit one day past the fixture's window wakes under the fixture and does not
  // under a policy whose window is two days longer.
  const lastReviewAt = T0 + (GATES - 1) * DAY;
  const widerPolicy = { ...SPENT_POLICY, review: { ...POLICY.review, legNoInflowDays: NO_INFLOW_DAYS + 2 } };
  for (const [policy, expectWake] of [[SPENT_POLICY, true], [widerPolicy, false]]) {
    const ctx = streakCtx({ policy });
    ctx.clock.set((lastReviewAt - (NO_INFLOW_DAYS + 1) * DAY) * 1000);
    ctx.journal.append({ kind: 'verb', verb: 'deposit', ok: true, args: { amountUsd: 10 } });
    ctx.clock.set(T0_MS);
    seedFromJournal(ctx);
    const out = await dailyReviews(ctx, GATES);
    assert.equal(Boolean(inflow(out)), expectWake, `legNoInflowDays ${policy.review.legNoInflowDays}: ${JSON.stringify(out.triggers)}`);
  }

  // A fixture without a review section (only a test can build one; loadPolicy refuses it) reports null and still runs.
  const bare = mk({ depsOverrides: { deriveReview: realDeriveReview }, policy: { version: 1 } });
  assert.equal((await verbs.status(bare, {}, meta())).policy.review, null);
  assert.equal((await verbs.review(bare, {}, gate())).wakeAgent, false);
});
