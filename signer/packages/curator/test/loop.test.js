/**
 * The apply machine on faked gates, one test per §4.5 row, and the tick on
 * fakes: a blocked pre-flight never sends, a paused or self-locked signer
 * holds, a stranger's apply is recognised as DONE, invariant drift locks
 * every write. No clock of the wall, no network.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import anchor from '@coral-xyz/anchor';
import { fakeCtx, fakeSnapshot, meta, NEW_TARGETS, LEGS, LEGS_AFTER, POLICY, T0, KEYS, WALLET } from './fakes.js';
import { stepApply, applyOutcome, createLoop, gaugesOf, APPLY_STATES } from '../src/loop.js';
import { initialApplyState, propose, alerts } from '../src/verbs.js';
import { Refusal } from '../src/errors.js';

const { BN } = anchor;
const ctxs = [];
const mk = (over) => { const ctx = fakeCtx(over); ctxs.push(ctx); return ctx; };
after(() => ctxs.forEach((ctx) => ctx.cleanup()));

const EFF = T0 + 86400;
const PENDING = { effectiveAt: EFF, proposedAt: T0, targets: NEW_TARGETS };
const ROW_PENDING = { targets: NEW_TARGETS, proposedAt: T0, effectiveAt: EFF };
const armed = (extra = {}) => ({ ...initialApplyState(), state: 'ARMED', effectiveAt: EFF, targets: NEW_TARGETS, proposedAt: T0, since: T0, deploymentId: 'dep-1', ...extra });
const gateOk = (extra = {}) => ({ ok: true, pending: PENDING, ...extra });
const gateWait = (code, extra = {}, blockerExtra = {}) => ({ ok: false, blockers: [{ code, action: 'wait', message: `${code} message`, ...blockerExtra }], pending: PENDING, ...extra });
const gateBlocked = (code) => ({ ok: false, blockers: [{ code, action: 'blocked', message: `${code} message` }], pending: PENDING });

test('APPLY_STATES is the §4.5 list', () => {
  assert.deepEqual([...APPLY_STATES], ['IDLE', 'ARMED', 'WAIT_NOTICE', 'PREFLIGHT', 'SEND', 'CONFIRM', 'DONE', 'BLOCKED', 'ESCALATED']);
});

test('IDLE → ARMED when the chain shows a pending change (own or a stranger\'s)', () => {
  const { next, actions } = stepApply(initialApplyState(), gateOk(), T0 + 10, POLICY);
  assert.equal(next.state, 'ARMED');
  assert.equal(next.effectiveAt, EFF);
  assert.deepEqual(next.targets, NEW_TARGETS);
  assert.deepEqual(actions, ['journal']);
});

test('IDLE stays IDLE with nothing pending and never sends', () => {
  const { next, actions } = stepApply(initialApplyState(), { ok: true, pending: null }, T0, POLICY);
  assert.equal(next.state, 'IDLE');
  assert.deepEqual(actions, []);
});

test('ARMED holds until effectiveAt − 120 s, then WAIT_NOTICE while the notice runs', () => {
  const early = stepApply(armed(), gateWait('NOTICE_NOT_ELAPSED'), EFF - 121, POLICY);
  assert.equal(early.next.state, 'ARMED');
  assert.deepEqual(early.actions, []);
  const at = stepApply(armed(), gateWait('NOTICE_NOT_ELAPSED'), EFF - 120, POLICY);
  assert.equal(at.next.state, 'WAIT_NOTICE');
  assert.equal(at.next.lastBlocker.code, 'NOTICE_NOT_ELAPSED');
  assert.ok(!at.actions.includes('send'));
  const still = stepApply(at.next, gateWait('NOTICE_NOT_ELAPSED'), EFF - 30, POLICY);
  assert.equal(still.next.state, 'WAIT_NOTICE');
  assert.deepEqual(still.actions, []);
});

test('notice elapsed and gates green → SEND with a send action', () => {
  const { next, actions } = stepApply(armed({ state: 'WAIT_NOTICE' }), gateOk(), EFF + 1, POLICY);
  assert.equal(next.state, 'SEND');
  assert.deepEqual(actions, ['journal', 'send']);
});

test('the verb-armed estimate adopts the chain\'s effectiveAt without losing the deploymentId; new targets re-arm fresh', () => {
  const adopted = stepApply(armed({ effectiveAt: EFF - 5 }), gateOk(), T0 + 1, POLICY);
  assert.equal(adopted.next.effectiveAt, EFF);
  assert.equal(adopted.next.deploymentId, 'dep-1');
  assert.equal(adopted.next.state, 'ARMED');
  const other = [{ poolId: 'pSOL', weightBps: 5000 }, { poolId: 'pUSDT', weightBps: 5000 }];
  const rearmed = stepApply(armed({ state: 'PREFLIGHT', attempts: 2 }), { ok: true, pending: { ...PENDING, targets: other } }, T0 + 1, POLICY);
  assert.equal(rearmed.next.state, 'ARMED');
  assert.equal(rearmed.next.deploymentId, null);
  assert.equal(rearmed.next.attempts, 0);
  assert.deepEqual(rearmed.next.targets, other);
});

test('a wait blocker keeps PREFLIGHT and escalates once it outlives its escalateAfterSecs', () => {
  const first = stepApply(armed({ state: 'PREFLIGHT' }), gateWait('BOOK_NOT_FRESH'), EFF + 10, POLICY);
  assert.equal(first.next.state, 'PREFLIGHT');
  assert.equal(first.next.lastBlocker.since, EFF + 10);
  const later = stepApply(first.next, gateWait('BOOK_NOT_FRESH'), EFF + 10 + 1799, POLICY);
  assert.equal(later.next.state, 'PREFLIGHT');
  assert.equal(later.next.lastBlocker.since, EFF + 10, 'the wait clock does not reset while the code is unchanged');
  assert.ok(!later.actions.includes('send'));
  const escalated = stepApply(later.next, gateWait('BOOK_NOT_FRESH'), EFF + 10 + 1800, POLICY);
  assert.equal(escalated.next.state, 'ESCALATED');
  assert.ok(escalated.actions.includes('alert:BOOK_NOT_FRESH'));
  // a blocker's own escalateAfterSecs wins over the policy table
  const custom = stepApply(armed({ state: 'PREFLIGHT', lastBlocker: { code: 'LEG_STALE', since: EFF } }), gateWait('LEG_STALE', {}, { escalateAfterSecs: 60 }), EFF + 60, POLICY);
  assert.equal(custom.next.state, 'ESCALATED');
});

test('a different wait code restarts the wait clock', () => {
  const a = stepApply(armed({ state: 'PREFLIGHT', lastBlocker: { code: 'BOOK_NOT_FRESH', since: EFF } }), gateWait('LEG_STALE'), EFF + 1700, POLICY);
  assert.equal(a.next.lastBlocker.code, 'LEG_STALE');
  assert.equal(a.next.lastBlocker.since, EFF + 1700);
});

test('BOOK_NOT_FRESH with the keeper down and the book stale > 15 min asks for one refresh-nav, only once', () => {
  const gate = gateWait('BOOK_NOT_FRESH', { keeperOk: false }, { staleSecs: 900 });
  const first = stepApply(armed({ state: 'PREFLIGHT' }), gate, EFF + 10, POLICY);
  assert.ok(first.actions.includes('refresh-nav'));
  assert.equal(first.next.refreshNavSent, true);
  const second = stepApply(first.next, gate, EFF + 40, POLICY);
  assert.ok(!second.actions.includes('refresh-nav'));
  const keeperUp = stepApply(armed({ state: 'PREFLIGHT' }), gateWait('BOOK_NOT_FRESH', { keeperOk: true }, { staleSecs: 900 }), EFF + 10, POLICY);
  assert.ok(!keeperUp.actions.includes('refresh-nav'), 'the keeper cranks; the signer does not spend a refresh');
  const fresh = stepApply(armed({ state: 'PREFLIGHT' }), gateWait('BOOK_NOT_FRESH', { keeperOk: false }, { staleSecs: 899 }), EFF + 10, POLICY);
  assert.ok(!fresh.actions.includes('refresh-nav'));
});

test('a blocked blocker → BLOCKED with an alert, then holds on the same proposal', () => {
  const { next, actions } = stepApply(armed({ state: 'PREFLIGHT' }), gateBlocked('VAULT_PAUSED'), EFF + 5, POLICY);
  assert.equal(next.state, 'BLOCKED');
  assert.deepEqual(actions, ['journal', 'alert:VAULT_PAUSED']);
  const held = stepApply(next, gateOk(), EFF + 35, POLICY);
  assert.equal(held.next.state, 'BLOCKED', 'green gates do not un-block: the LLM cancels or POST /apply forces');
  assert.deepEqual(held.actions, []);
});

test('an escalate blocker → ESCALATED at once', () => {
  const { next, actions } = stepApply(armed({ state: 'PREFLIGHT' }), { ok: false, blockers: [{ code: 'LEG_PENDING_PRICE', action: 'escalate', message: 'publisher mark' }], pending: PENDING }, EFF + 5, POLICY);
  assert.equal(next.state, 'ESCALATED');
  assert.equal(next.escalatedAt, EFF + 5);
  assert.deepEqual(actions, ['journal', 'alert:LEG_PENDING_PRICE']);
});

test('the window closes 6 h after effectiveAt → ESCALATED WINDOW_CLOSED', () => {
  const { next, actions } = stepApply(armed({ state: 'PREFLIGHT' }), gateWait('LEG_STALE'), EFF + 21601, POLICY);
  assert.equal(next.state, 'ESCALATED');
  assert.equal(next.lastBlocker.code, 'WINDOW_CLOSED');
  assert.ok(actions.includes('alert:WINDOW_CLOSED'));
});

test('APPLY_IN_FLIGHT escalates after the attempt cap', () => {
  const ok = stepApply(armed({ state: 'CONFIRM', attempts: 2 }), gateWait('APPLY_IN_FLIGHT'), EFF + 5, POLICY);
  assert.equal(ok.next.state, 'PREFLIGHT');
  const capped = stepApply(armed({ state: 'CONFIRM', attempts: 3 }), gateWait('APPLY_IN_FLIGHT'), EFF + 5, POLICY);
  assert.equal(capped.next.state, 'ESCALATED');
  assert.ok(capped.actions.includes('alert:APPLY_IN_FLIGHT'));
});

test('no gate result (a throwing gate) means wait, never send', () => {
  const { next, actions } = stepApply(armed({ state: 'PREFLIGHT' }), { pending: PENDING }, EFF + 5, POLICY);
  assert.equal(next.state, 'PREFLIGHT');
  assert.deepEqual(actions, []);
});

test('pending gone before we sent: applied by a stranger → DONE; applied with other targets → APPLIED_MISMATCH; cancelled → IDLE', () => {
  const done = stepApply(armed({ state: 'PREFLIGHT' }), { ok: false, blockers: [{ code: 'NO_PENDING_CHANGE', action: 'done' }], pending: null, currentTargets: NEW_TARGETS, lastRebalanceAt: T0 + 5 }, EFF + 5, POLICY);
  assert.equal(done.next.state, 'DONE');
  assert.deepEqual(done.actions, ['journal']);
  const mismatch = stepApply(armed({ state: 'WAIT_NOTICE' }), { ok: false, blockers: [], pending: null, currentTargets: [{ poolId: 'pSOL', weightBps: 10000 }], lastRebalanceAt: T0 + 5 }, EFF + 5, POLICY);
  assert.equal(mismatch.next.state, 'ESCALATED');
  assert.ok(mismatch.actions.includes('alert:APPLIED_MISMATCH'));
  const cancelled = stepApply(armed({ state: 'PREFLIGHT' }), { ok: false, blockers: [], pending: null, currentTargets: LEGS.map((l) => ({ poolId: l.poolId, weightBps: l.targetWeightBps })), lastRebalanceAt: T0 - 86400 }, EFF + 5, POLICY);
  assert.equal(cancelled.next.state, 'IDLE');
});

test('pending gone after our send → DONE; DONE/ESCALATED/BLOCKED go back to IDLE once the proposal is gone', () => {
  const ours = stepApply(armed({ state: 'CONFIRM' }), { ok: true, pending: null, currentTargets: NEW_TARGETS, lastRebalanceAt: EFF + 2 }, EFF + 40, POLICY);
  assert.equal(ours.next.state, 'DONE');
  for (const state of ['DONE', 'ESCALATED', 'BLOCKED']) {
    const back = stepApply(armed({ state }), { ok: true, pending: null, currentTargets: NEW_TARGETS }, EFF + 100, POLICY);
    assert.equal(back.next.state, 'IDLE', state);
  }
});

test('applyOutcome: ok → CONFIRM; three send failures → ESCALATED; MISSING_CUSTODY retries once; a decode code escalates at once; PAUSED holds', () => {
  const sent = applyOutcome(armed({ state: 'SEND' }), { ok: true, signatures: ['s1'] }, EFF + 1, POLICY);
  assert.equal(sent.next.state, 'CONFIRM');
  assert.equal(sent.next.attempts, 1);
  assert.deepEqual(sent.next.signatures, ['s1']);
  let s = armed({ state: 'SEND' });
  for (let i = 1; i <= 2; i += 1) {
    const r = applyOutcome(s, { ok: false, code: 'SEND_FAILED', message: 'expired' }, EFF + i, POLICY);
    assert.equal(r.next.state, 'PREFLIGHT', `failure ${i} retries next tick`);
    assert.equal(r.next.sendFailures, i);
    s = r.next;
  }
  const third = applyOutcome(s, { ok: false, code: 'UPSTREAM', message: 'api down' }, EFF + 3, POLICY);
  assert.equal(third.next.state, 'ESCALATED');
  assert.ok(third.actions.includes('alert:SEND_FAILED'));
  const custody1 = applyOutcome(armed({ state: 'SEND' }), { ok: false, code: 'MISSING_CUSTODY' }, EFF + 1, POLICY);
  assert.equal(custody1.next.state, 'PREFLIGHT');
  assert.equal(custody1.next.custodyRetries, 1);
  const custody2 = applyOutcome(custody1.next, { ok: false, code: 'MISSING_CUSTODY' }, EFF + 2, POLICY);
  assert.equal(custody2.next.state, 'ESCALATED');
  assert.ok(custody2.actions.includes('alert:MISSING_CUSTODY'));
  const decode = applyOutcome(armed({ state: 'SEND' }), { ok: false, code: 'WRONG_PAYER' }, EFF + 1, POLICY);
  assert.equal(decode.next.state, 'ESCALATED');
  assert.ok(decode.actions.includes('alert:WRONG_PAYER'));
  const paused = applyOutcome(armed({ state: 'SEND' }), { ok: false, code: 'PAUSED' }, EFF + 1, POLICY);
  assert.equal(paused.next.state, 'SEND');
  assert.deepEqual(paused.actions, []);
  const noPending = applyOutcome(armed({ state: 'SEND' }), { ok: false, code: 'NO_PENDING_CHANGE' }, EFF + 1, POLICY);
  assert.equal(noPending.next.state, 'CONFIRM');
  const lowSol = applyOutcome(armed({ state: 'SEND' }), { ok: false, code: 'LOW_SOL' }, EFF + 1, POLICY);
  assert.equal(lowSol.next.state, 'PREFLIGHT');
  assert.ok(lowSol.actions.includes('alert:LOW_SOL'));
});

// ------------------------------------------------------------------ ticks

test('tick: invariant drift → self-lock, lock journaled once, INVARIANT_DRIFT alert, and every write refused SELF_LOCKED', async () => {
  const drift = [{ invariant: 'portfolio.curator', expected: WALLET, actual: KEYS.governance.toBase58() }];
  const ctx = mk({ snapshot: fakeSnapshot({ curator: KEYS.governance.toBase58(), pending: ROW_PENDING }), depsOverrides: { checkInvariants: () => ({ ok: false, drift }) } });
  const loop = createLoop({ ctx, intervalMs: 30000 });
  const first = await loop.tick();
  assert.equal(first.ok, true);
  assert.equal(ctx.state.selfLocked.reason, 'INVARIANT_DRIFT');
  assert.deepEqual(ctx.state.selfLocked.drift, drift);
  assert.deepEqual(first.alerts.map((a) => a.code), ['INVARIANT_DRIFT']);
  assert.equal(ctx.state.apply.state, 'IDLE', 'the machine held: no arming while locked');
  ctx.clock.advance(30);
  const second = await loop.tick();
  assert.deepEqual(second.alerts, [], 'a standing drift is not re-alerted every tick');
  assert.equal(ctx.journal.records().filter((r) => r.kind === 'lock').length, 1);
  let error = null;
  try { await propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()); } catch (e) { error = e; }
  assert.ok(error instanceof Refusal);
  assert.equal(error.code, 'SELF_LOCKED');
  assert.equal(ctx.signer.calls.length, 0);
  assert.equal(ctx.client.calls.length, 0);
});

test('tick: a blocked pre-flight never sends', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING, vaultPaused: true }), depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'VAULT_PAUSED', action: 'blocked', message: 'paused' }] }) } });
  ctx.clock.set((EFF + 5) * 1000);
  const loop = createLoop({ ctx });
  const out = await loop.tick();
  assert.equal(out.applyState, 'BLOCKED');
  assert.equal(out.blockers[0].code, 'VAULT_PAUSED');
  assert.ok(!ctx.trace.includes('buildApply') && !ctx.trace.includes('sign') && !ctx.trace.includes('send'));
  assert.ok(ctx.state.alerts.has('apply:VAULT_PAUSED'));
  assert.equal(ctx.journal.records().filter((r) => r.kind === 'apply').at(-1).to, 'BLOCKED');
});

test('tick: notice elapsed and gates green → build, verify, sign, send through the loop; state CONFIRM; then DONE once the chain shows it', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  const loop = createLoop({ ctx });
  ctx.clock.set((EFF - 60) * 1000);
  await loop.tick();
  // The fake gate is green inside the arming window (a real applyGates emits
  // NOTICE_NOT_ELAPSED here); SEND → send → CONFIRM happens within the tick.
  assert.deepEqual(ctx.trace.filter((t) => t !== 'readSnapshot' && t !== 'checkInvariants' && t !== 'applyGates'), ['verbAllowed', 'evaluateWrite', 'buildApply', 'verifyBuilt', 'sign', 'send']);
  assert.equal(ctx.state.apply.state, 'CONFIRM');
  assert.equal(ctx.state.apply.attempts, 1);
  assert.deepEqual(ctx.state.apply.signatures, ['sig-1']);
  const applyRecords = ctx.journal.records().filter((r) => r.kind === 'apply');
  assert.deepEqual(applyRecords.map((r) => [r.from, r.to]), [['IDLE', 'SEND'], ['SEND', 'CONFIRM']], 'one record per step: the late first tick crosses ARMED and WAIT_NOTICE in one go');
  assert.deepEqual(applyRecords.at(-1).signatures, ['sig-1']);
  assert.equal(ctx.journal.records().find((r) => r.kind === 'verb').verb, 'apply');
  ctx.deps.setSnapshot(fakeSnapshot({ pending: null, legs: LEGS_AFTER, lastRebalanceAt: EFF - 59 }));
  ctx.clock.advance(30);
  const done = await loop.tick();
  assert.equal(done.applyState, 'DONE');
  assert.equal(ctx.state.ledger.lastProposalAt, EFF - 59, 'the chain\'s last apply is merged into the ledger');
});

test('tick: paused holds the machine even with green gates', async () => {
  const ctx = mk({ paused: true, snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  ctx.clock.set((EFF + 5) * 1000);
  const loop = createLoop({ ctx });
  const out = await loop.tick();
  assert.equal(out.ok, true);
  assert.equal(out.applyState, 'IDLE');
  assert.equal(ctx.client.calls.length, 0);
  assert.equal(ctx.state.lastTick.ok, true);
});

test('tick: a stranger applied our proposal first → DONE, apply alerts cleared, nothing sent', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  const loop = createLoop({ ctx });
  ctx.clock.set((EFF - 1000) * 1000);
  await loop.tick();
  assert.equal(ctx.state.apply.state, 'ARMED');
  ctx.deps.setSnapshot(fakeSnapshot({ pending: null, legs: LEGS_AFTER, lastRebalanceAt: EFF - 900 }));
  ctx.clock.set((EFF - 800) * 1000);
  const out = await loop.tick();
  assert.equal(out.applyState, 'DONE');
  assert.ok(!ctx.trace.includes('buildApply'));
  assert.equal(ctx.journal.records().filter((r) => r.kind === 'apply').at(-1).to, 'DONE');
});

test('tick: a stranger applied something else → ESCALATED APPLIED_MISMATCH', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  const loop = createLoop({ ctx });
  ctx.clock.set((EFF - 1000) * 1000);
  await loop.tick();
  ctx.deps.setSnapshot(fakeSnapshot({ pending: null, legs: [{ poolId: 'pSOL', symbol: 'pSOL', targetWeightBps: 10000, weightBps: 10000, valueUsdc: 1 }], lastRebalanceAt: EFF - 900 }));
  ctx.clock.set((EFF - 800) * 1000);
  const out = await loop.tick();
  assert.equal(out.applyState, 'ESCALATED');
  assert.deepEqual(out.alerts.map((a) => a.code), ['APPLIED_MISMATCH']);
});

test('tick: an expired send is rebuilt and re-sent within the tick with backoff, at most maxSendsPerTick', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  ctx.state.apply = armed({ state: 'PREFLIGHT' });
  ctx.clock.set((EFF + 5) * 1000);
  ctx.client.fail.send = (n) => {
    if (n < 3) throw new Refusal('SEND_FAILED', 'expired', { code: 'SEND_EXPIRED', message: 'Blockhash not found', status: 'expired' });
    return { ok: true, status: 'confirmed', signatures: ['sig-3'], error: null };
  };
  const loop = createLoop({ ctx });
  const out = await loop.tick();
  assert.equal(out.applyState, 'CONFIRM');
  assert.equal(ctx.client.calls.filter((c) => c.name === 'send').length, 3);
  assert.deepEqual(ctx.sleeps, [1000, 2000]);
  assert.deepEqual(ctx.state.apply.signatures, ['sig-3']);
  // a non-retriable failure stops after one attempt
  const ctx2 = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  ctx2.state.apply = armed({ state: 'PREFLIGHT' });
  ctx2.clock.set((EFF + 5) * 1000);
  ctx2.client.fail.send = new Refusal('SEND_FAILED', 'rejected', { code: 'SEND_FAILED', message: 'custom program error: 0x1772' });
  const out2 = await createLoop({ ctx: ctx2 }).tick();
  assert.equal(out2.applyState, 'PREFLIGHT');
  assert.equal(ctx2.client.calls.filter((c) => c.name === 'send').length, 1);
  assert.equal(ctx2.state.apply.sendFailures, 1);
});

test('tick: three failed ticks escalate SEND_FAILED', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }) });
  ctx.state.apply = armed({ state: 'PREFLIGHT' });
  ctx.clock.set((EFF + 5) * 1000);
  ctx.client.fail.send = new Refusal('SEND_FAILED', 'rejected', { code: 'SEND_FAILED', message: 'custom program error: 0x1772' });
  const loop = createLoop({ ctx });
  await loop.tick();
  ctx.clock.advance(30);
  await loop.tick();
  ctx.clock.advance(30);
  const out = await loop.tick();
  assert.equal(out.applyState, 'ESCALATED');
  assert.ok(ctx.state.alerts.has('apply:SEND_FAILED'));
});

test('tick: BOOK_NOT_FRESH with the keeper down sends one refresh-nav through the verb pipeline', async () => {
  const ctx = mk({
    snapshot: fakeSnapshot({ pending: ROW_PENDING, priceState: 'stale', keeperOk: false }),
    depsOverrides: { applyGates: () => ({ ok: false, blockers: [{ code: 'BOOK_NOT_FRESH', action: 'wait', message: 'stale', staleSecs: 1200 }] }) },
  });
  ctx.state.apply = armed({ state: 'PREFLIGHT' });
  ctx.clock.set((EFF + 5) * 1000);
  const loop = createLoop({ ctx });
  await loop.tick();
  assert.deepEqual(ctx.client.calls.map((c) => c.name), ['buildRefreshNav', 'send']);
  ctx.clock.advance(30);
  await loop.tick();
  assert.equal(ctx.client.calls.filter((c) => c.name === 'buildRefreshNav').length, 1, 'once per proposal');
  assert.equal(ctx.state.apply.state, 'PREFLIGHT');
});

test('tick: a failed snapshot read marks the tick, journals once, and never leaks the RPC URL', async () => {
  const ctx = mk();
  ctx.deps.setSnapshot(() => { throw new Error('fetch failed: https://mainnet.helius-rpc.com/?api-key=SECRET'); });
  const loop = createLoop({ ctx });
  const out = await loop.tick();
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('SECRET') && !out.error.includes('helius'));
  assert.equal(ctx.state.lastTick.ok, false);
  ctx.clock.advance(30);
  await loop.tick();
  const ticks = ctx.journal.records().filter((r) => r.kind === 'tick');
  assert.equal(ticks.length, 1);
  assert.ok(!JSON.stringify(ticks).includes('SECRET'));
});

test('tick: LOW_SOL is a standing alert, raised under the floor and resolved above it', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ lamports: 1_000_000 }) });
  const loop = createLoop({ ctx });
  const low = await loop.tick();
  assert.deepEqual(low.alerts.map((a) => a.code), ['LOW_SOL']);
  ctx.clock.advance(30);
  const again = await loop.tick();
  assert.deepEqual(again.alerts, [], 'a standing LOW_SOL is not re-alerted every tick');
  assert.equal((await alerts(ctx, {}, meta())).alerts[0].code, 'LOW_SOL');
  ctx.deps.setSnapshot(fakeSnapshot({ lamports: 500_000_000 }));
  ctx.clock.advance(30);
  await loop.tick();
  assert.equal(ctx.state.alerts.get('sol').resolvedAt, T0 + 60);
  const resolved = (await alerts(ctx, {}, meta())).alerts;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolved, true);
});

test('gaugesOf carries the seven plan gauges plus paused and write attempts', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING, priceState: 'fresh' }) });
  ctx.state.hermesHeartbeatAt = T0 - 5;
  await createLoop({ ctx }).tick();
  const gauges = gaugesOf(ctx);
  assert.deepEqual(Object.keys(gauges), ['curator_last_tick_ts', 'curator_hermes_heartbeat_ts', 'curator_pending_effective_at', 'curator_apply_state', 'curator_book_price_fresh', 'curator_signer_lamports', 'curator_self_locked', 'curator_paused', 'curator_write_attempts_1h']);
  assert.equal(gauges.curator_last_tick_ts, T0);
  assert.equal(gauges.curator_hermes_heartbeat_ts, T0 - 5);
  assert.equal(gauges.curator_pending_effective_at, EFF);
  assert.equal(gauges.curator_apply_state, 'ARMED');
  assert.equal(gauges.curator_book_price_fresh, 1);
  assert.equal(gauges.curator_signer_lamports, 100_000_000);
  assert.equal(gauges.curator_self_locked, 0);
  assert.equal(gauges.curator_paused, 0);
});

test('start ticks at once and on the interval; stop ends it; ticks never overlap', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    let resolveRead;
    let reads = 0;
    const ctx = mk({ depsOverrides: { readSnapshot: () => { reads += 1; return new Promise((resolve) => { resolveRead = resolve; }); } } });
    const loop = createLoop({ ctx, intervalMs: 1000 });
    loop.start();
    assert.equal(loop.state().running, true);
    await Promise.resolve();
    assert.equal(reads, 1, 'the first tick runs at start');
    mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(reads, 1, 'a tick in flight is not overlapped');
    resolveRead(fakeSnapshot());
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(reads, 2);
    resolveRead(fakeSnapshot());
    await loop.stop();
    assert.equal(loop.state().running, false);
    mock.timers.tick(5000);
    assert.equal(reads, 2, 'no ticks after stop');
  } finally {
    mock.timers.reset();
  }
});

// -------------------------------------------- unverified invariants, RFC 3339 rows, the NAV table

test('tick: an invariant the tick could not verify holds the machine and every write, alerts invariants_unverified once, and lifts the tick the reads succeed', async () => {
  const withoutAccountant = { ...fakeSnapshot({ pending: ROW_PENDING }), accountantAccount: null };
  const ctx = mk({
    snapshot: withoutAccountant,
    depsOverrides: { checkInvariants: (snapshot) => ({ ok: true, unverified: snapshot.accountantAccount ? [] : ['accountant.recipient1'] }) },
  });
  ctx.clock.set((EFF + 5) * 1000);
  const loop = createLoop({ ctx });
  const first = await loop.tick();
  assert.equal(first.ok, true);
  assert.deepEqual(first.alerts.map((a) => [a.key, a.code]), [['invariants_unverified', 'INVARIANTS_UNVERIFIED']]);
  assert.deepEqual(ctx.state.invariantsUnverified, ['accountant.recipient1']);
  assert.equal(ctx.state.apply.state, 'IDLE', 'the machine held: no arming, no send');
  assert.equal(ctx.client.calls.length, 0);
  assert.equal(ctx.state.selfLocked, null, 'not drift: no self-lock, no operator unlock needed');
  assert.equal((await alerts(ctx, {}, meta())).alerts[0].key, 'invariants_unverified');
  let error = null;
  try { await propose(ctx, { targets: NEW_TARGETS, why: 'x' }, meta()); } catch (e) { error = e; }
  assert.equal(error?.code, 'INVARIANTS_UNVERIFIED');
  assert.equal(ctx.signer.calls.length, 0);
  ctx.clock.advance(30);
  const second = await loop.tick();
  assert.deepEqual(second.alerts, [], 'a standing hold is not re-alerted every tick');
  assert.equal(ctx.state.apply.state, 'IDLE');
  ctx.deps.setSnapshot(fakeSnapshot({ pending: ROW_PENDING }));
  ctx.clock.advance(30);
  const third = await loop.tick();
  assert.equal(ctx.state.invariantsUnverified, null);
  assert.equal(third.applyState, 'CONFIRM', 'the reads are back: the machine ran through send');
  assert.ok(ctx.state.alerts.get('invariants_unverified').resolvedAt > 0, 'the alert resolves on its own');
});

test('tick: a checkInvariants that throws is unverified, never verified', async () => {
  const ctx = mk({ snapshot: fakeSnapshot({ pending: ROW_PENDING }), depsOverrides: { checkInvariants: () => { throw new Error('decode failed'); } } });
  ctx.clock.set((EFF + 5) * 1000);
  const out = await createLoop({ ctx }).tick();
  assert.equal(out.ok, true);
  assert.equal(out.applyState, 'IDLE');
  assert.equal(ctx.client.calls.length, 0);
  assert.deepEqual(ctx.state.invariantsUnverified, ['invariants (check failed)']);
  assert.ok(ctx.state.alerts.has('invariants_unverified'));
});

test('tick: the api row\'s RFC 3339 pendingTargets arm the machine with numeric seconds, and the chain header wins when it is readable', async () => {
  const rfc = (secs) => new Date(secs * 1000).toISOString();
  const rowPending = { targets: NEW_TARGETS, proposedAt: rfc(T0), effectiveAt: rfc(EFF) };
  const ctx = mk({ snapshot: fakeSnapshot({ pending: rowPending }) });
  ctx.clock.set((EFF - 1000) * 1000);
  const loop = createLoop({ ctx });
  await loop.tick();
  assert.equal(ctx.state.apply.state, 'ARMED');
  assert.equal(ctx.state.apply.effectiveAt, EFF, 'RFC 3339 → unix seconds, not NaN');
  assert.equal(ctx.state.apply.proposedAt, T0);
  assert.equal(gaugesOf(ctx).curator_pending_effective_at, EFF);
  const fromChain = fakeSnapshot({ pending: rowPending });
  fromChain.portfolioAccount.pendingTargets = { proposedAt: new BN(T0), effectiveAt: new BN(EFF + 7) };
  ctx.deps.setSnapshot(fromChain);
  ctx.clock.advance(30);
  await loop.tick();
  assert.equal(ctx.state.apply.state, 'ARMED');
  assert.equal(ctx.state.apply.effectiveAt, EFF + 7, 'the chain header is authoritative on timing');
  assert.deepEqual(ctx.state.apply.targets, NEW_TARGETS, 'the row still supplies the target set');
});

test('tick: the NAV lookup table is refreshed every tick through ctx.chain.refreshLookupTables; a failing refresh is logged without its URL and does not stop the tick', async () => {
  const ctx = mk();
  let calls = 0;
  ctx.chain.refreshLookupTables = async () => { calls += 1; if (calls === 2) throw new Error('getAddressLookupTable failed for https://rpc.example.com/key-SECRET'); };
  const loop = createLoop({ ctx });
  await loop.tick();
  ctx.clock.advance(30);
  const out = await loop.tick();
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  const warn = ctx.logs.find((l) => l.event === 'lookup-table-refresh-failed');
  assert.ok(warn, 'the failure is logged');
  assert.ok(!JSON.stringify(warn).includes('rpc.example') && !JSON.stringify(warn).includes('SECRET'));
});
