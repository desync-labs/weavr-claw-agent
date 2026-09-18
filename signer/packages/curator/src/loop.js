/**
 * The 30 s loop and the apply state machine (plan §4.5). Apply is not a cron
 * job and not an LLM decision: once a change is announced on chain the
 * signer applies it itself when the notice elapses and the gates pass, so a
 * lost Hermes container cannot strand a proposal. Each tick: snapshot →
 * invariants (self-lock on drift) → machine step → alerts → gauges.
 * `stepApply` and `applyOutcome` are pure so every row of the §4.5 table is
 * a faked test; `createLoop` is the only place with a clock, a snapshot
 * read and a send, and all three come through `ctx`.
 *
 * Why the gate the machine sees is `applyGates(...)` plus four fields the
 * loop adds from the same snapshot (`pending`, `currentTargets`,
 * `lastRebalanceAt`, `keeperOk`): the gates say whether an apply may go;
 * the machine also needs to know whether a proposal exists at all, whether
 * a vanished one was applied by a stranger or cancelled, and whether the
 * keeper is up before it spends a refresh-nav. Passing them on the gate
 * keeps `stepApply` a function of its arguments.
 *
 * Why the chain is authoritative on `effectiveAt`: the propose verb arms
 * the machine with `now + delay`, a few seconds off the on-chain value; the
 * first tick after a proposal adopts the chain's number without losing the
 * deploymentId, and only a *different target set* re-arms from scratch.
 *
 * Why an invariant the tick could not verify holds writes: `checkInvariants`
 * lists an accountant or FactoryConfig it could not read under `unverified`
 * — not drift (a transient RPC failure must not need an operator unlock),
 * but not proof either. Treating it as verified would let a deposit run
 * while the fee recipient is unknown, so the machine holds, every write is
 * refused INVARIANTS_UNVERIFIED (cancel and the ops verbs excepted, as under
 * a pause), the `invariants_unverified` alert is raised once, and all of it
 * lifts on its own the tick the reads succeed.
 *
 * Why the tick refreshes the NAV lookup table (`ctx.chain.refreshLookupTables`):
 * an apply page is a v0 message whose accounts are indexes into that table,
 * and the decoder can only assert an account it can resolve. The keeper
 * extends the table when pools are added, so a copy read once at boot goes
 * stale; one account read per tick keeps it current.
 */
import { Refusal } from './errors.js';
import {
  applySend, refreshNav, raiseAlert, clearAlert, clearApplyAlerts, depsOf, scrubText,
  pendingOf, currentTargetsOf, targetsEqual, keeperOkOf, initialApplyState, writeAttemptsLastHour, num,
} from './verbs.js';

/** The machine's states, in order of a normal cycle. */
export const APPLY_STATES = Object.freeze([
  'IDLE', 'ARMED', 'WAIT_NOTICE', 'PREFLIGHT', 'SEND', 'CONFIRM', 'DONE', 'BLOCKED', 'ESCALATED',
]);

const ACTIVE = new Set(['ARMED', 'WAIT_NOTICE', 'PREFLIGHT', 'SEND', 'CONFIRM']);
const TERMINAL = new Set(['DONE', 'BLOCKED', 'ESCALATED']);

/** A send refused by the decoder is not retried: the api built the wrong thing and a rebuild would too. */
export const DECODE_CODES = Object.freeze(new Set([
  'NOT_A_TRANSACTION', 'WRONG_PAYER', 'FOREIGN_PROGRAM', 'FOREIGN_LOOKUP_TABLE', 'UNKNOWN_INSTRUCTION',
  'UNEXPECTED_INSTRUCTIONS', 'WRONG_PORTFOLIO', 'TARGETS_MISMATCH', 'UNEXPECTED_STEP',
]));

const DEFAULT_APPLY_POLICY = Object.freeze({
  armBeforeEffectiveSecs: 120,
  windowAfterEffectiveSecs: 21600,
  maxSendsPerTick: 3,
  sendFailedTicksBeforeEscalate: 3,
  refreshNavWhenBookStaleSecs: 900,
  applyInFlightMaxAttempts: 3,
  missingCustodyRetries: 1,
  escalateAfterSecs: {},
});

const applyPolicy = (policy) => ({ ...DEFAULT_APPLY_POLICY, ...(policy?.apply ?? {}) });

/**
 * One pure step of the machine.
 * @param {object} applyState README §4.1 `state.apply`
 * @param {{ ok?: boolean, blockers?: object[], pending?: { effectiveAt: number, proposedAt: number | null, targets: object[] } | null, currentTargets?: object[] | null, lastRebalanceAt?: number | null, keeperOk?: boolean | null }} gate
 *   the applyGates result for this tick plus the loop's four snapshot-derived fields; `ok === undefined` means "no gate result: wait"
 * @param {number} now unix secs
 * @param {object} policy
 * @returns {{ next: object, actions: Array<'send' | 'refresh-nav' | `alert:${string}` | 'journal'> }}
 */
export function stepApply(applyState, gate, now, policy) {
  const a = applyPolicy(policy);
  const actions = [];
  let s = { ...initialApplyState(), ...(applyState ?? {}) };
  const from = s.state;
  const pending = gate?.pending ?? null;
  // One step may cross several states (IDLE → ARMED → WAIT_NOTICE → SEND on
  // a late first tick); it is journaled once, from the state it entered with
  // to the one it leaves with, so the de-duplication keeps first occurrences.
  const finish = () => ({ next: s, actions: [...new Set(actions)] });
  const go = (state, extra = {}) => {
    if (s.state !== state) actions.push('journal');
    s = { ...s, ...extra, state, since: s.state === state ? s.since : now };
  };
  const escalate = (code, message) => {
    go('ESCALATED', { escalatedAt: now, lastBlocker: { code, since: s.lastBlocker?.code === code ? s.lastBlocker.since : now, message: message ?? null } });
    actions.push(`alert:${code}`);
  };

  if (pending) {
    // The header (the chain) can show a pending change before the api row
    // carries its target set; an unknown set is not a different set.
    const targetsKnown = Array.isArray(pending.targets);
    const sameTargets = targetsKnown ? targetsEqual(s.targets, pending.targets) : Array.isArray(s.targets);
    const rearm = s.state === 'IDLE' || !sameTargets || (TERMINAL.has(s.state) && s.effectiveAt !== pending.effectiveAt);
    if (rearm) {
      s = {
        ...initialApplyState(),
        state: 'ARMED',
        deploymentId: sameTargets ? s.deploymentId : null,
        effectiveAt: pending.effectiveAt,
        targets: targetsKnown ? pending.targets : s.targets,
        proposedAt: pending.proposedAt ?? now,
        since: now,
      };
      actions.push('journal');
    } else if (TERMINAL.has(s.state)) {
      return finish(); // the same proposal, held for the operator (BLOCKED/ESCALATED) or already done
    } else if (s.effectiveAt !== pending.effectiveAt) {
      s = { ...s, effectiveAt: pending.effectiveAt, proposedAt: pending.proposedAt ?? s.proposedAt };
    }

    if (s.effectiveAt == null) return finish(); // unknown timing: wait for a row that carries it
    if (s.state === 'ARMED') {
      if (now < s.effectiveAt - a.armBeforeEffectiveSecs) return finish();
      go('WAIT_NOTICE');
    }
    if (now > s.effectiveAt + a.windowAfterEffectiveSecs) {
      escalate('WINDOW_CLOSED', `the apply window closed ${a.windowAfterEffectiveSecs} s after effectiveAt`);
      return finish();
    }
    if (!gate || typeof gate.ok !== 'boolean') return finish();
    if (gate.ok) {
      go('SEND');
      actions.push('send');
      return finish();
    }
    const blockers = Array.isArray(gate.blockers) ? gate.blockers : [];
    const esc = blockers.find((b) => b.action === 'escalate');
    if (esc) {
      escalate(esc.code, esc.message);
      return finish();
    }
    const blk = blockers.find((b) => b.action === 'blocked');
    if (blk) {
      go('BLOCKED', { lastBlocker: { code: blk.code, since: now, message: blk.message ?? null } });
      actions.push(`alert:${blk.code}`);
      return finish();
    }
    const wait = blockers.find((b) => b.action === 'wait') ?? blockers[0] ?? { code: 'INPUTS_INCOMPLETE', message: 'no blocker named' };
    const prev = s.lastBlocker && s.lastBlocker.code === wait.code ? s.lastBlocker : { code: wait.code, since: now, message: wait.message ?? null };
    const waited = now - prev.since;
    if (wait.code !== 'NOTICE_NOT_ELAPSED') {
      const escalateAfter = wait.escalateAfterSecs ?? a.escalateAfterSecs?.[wait.code] ?? null;
      if (escalateAfter != null && waited >= escalateAfter) {
        s.lastBlocker = prev;
        escalate(wait.code, wait.message);
        return finish();
      }
      if (wait.code === 'APPLY_IN_FLIGHT' && s.attempts >= a.applyInFlightMaxAttempts) {
        s.lastBlocker = prev;
        escalate('APPLY_IN_FLIGHT', `apply_next_page stayed non-zero after ${s.attempts} attempts`);
        return finish();
      }
      if (wait.code === 'BOOK_NOT_FRESH' && !s.refreshNavSent && gate.keeperOk === false
        && (wait.staleSecs ?? waited) >= a.refreshNavWhenBookStaleSecs) {
        actions.push('refresh-nav');
        s = { ...s, refreshNavSent: true };
      }
    }
    go(wait.code === 'NOTICE_NOT_ELAPSED' ? 'WAIT_NOTICE' : 'PREFLIGHT', { lastBlocker: prev });
    return finish();
  }

  // Nothing pending on chain.
  if (s.state === 'IDLE') return finish();
  if (TERMINAL.has(s.state)) {
    s = { ...initialApplyState(), since: now };
    actions.push('journal');
    return finish();
  }
  // ACTIVE and the proposal vanished: applied by us, applied by a stranger, or cancelled.
  const onChain = gate?.currentTargets ?? null;
  const lastRebalanceAt = gate?.lastRebalanceAt ?? null;
  const applied = onChain != null && Array.isArray(s.targets) && targetsEqual(s.targets, onChain);
  const advanced = lastRebalanceAt != null && s.proposedAt != null && lastRebalanceAt >= s.proposedAt;
  if (applied || (s.state === 'CONFIRM' && (advanced || onChain == null))) {
    go('DONE');
    return finish();
  }
  if (advanced) {
    escalate('APPLIED_MISMATCH', 'the pending change is gone and the on-chain targets differ from the proposal');
    return finish();
  }
  s = { ...initialApplyState(), since: now };
  actions.push('journal');
  return finish();
}

/**
 * The machine after a SEND attempt.
 * @param {object} applyState
 * @param {{ ok: boolean, code?: string, signatures?: string[], message?: string, detail?: object }} outcome
 * @param {number} now unix secs
 * @param {object} policy
 * @returns {{ next: object, actions: string[] }}
 */
export function applyOutcome(applyState, outcome, now, policy) {
  const a = applyPolicy(policy);
  const s = { ...initialApplyState(), ...(applyState ?? {}) };
  const journal = ['journal'];
  if (outcome?.ok) {
    return {
      next: { ...s, state: 'CONFIRM', attempts: s.attempts + 1, sendFailures: 0, lastSentAt: now, since: now, signatures: [...(s.signatures ?? []), ...(outcome.signatures ?? [])] },
      actions: journal,
    };
  }
  const code = outcome?.code ?? 'SEND_FAILED';
  const blocker = { code, since: now, message: outcome?.message ?? null };
  if (code === 'PAUSED' || code === 'SELF_LOCKED' || code === 'INVARIANTS_UNVERIFIED') return { next: s, actions: [] };
  if (code === 'NO_PENDING_CHANGE') return { next: { ...s, state: 'CONFIRM', since: now, lastBlocker: blocker }, actions: journal };
  if (code === 'MISSING_CUSTODY') {
    const custodyRetries = s.custodyRetries + 1;
    if (custodyRetries > a.missingCustodyRetries) {
      return { next: { ...s, state: 'ESCALATED', escalatedAt: now, since: now, custodyRetries, lastBlocker: blocker }, actions: [...journal, 'alert:MISSING_CUSTODY'] };
    }
    return { next: { ...s, state: 'PREFLIGHT', since: now, custodyRetries, lastBlocker: blocker }, actions: journal };
  }
  if (DECODE_CODES.has(code)) {
    return { next: { ...s, state: 'ESCALATED', escalatedAt: now, since: now, lastBlocker: blocker }, actions: [...journal, `alert:${code}`] };
  }
  if (code === 'LOW_SOL' || code === 'RATE_LIMITED') {
    return { next: { ...s, state: 'PREFLIGHT', since: now, lastBlocker: blocker }, actions: [...journal, `alert:${code}`] };
  }
  const sendFailures = s.sendFailures + 1;
  const attempts = s.attempts + 1;
  if (sendFailures >= a.sendFailedTicksBeforeEscalate) {
    return { next: { ...s, state: 'ESCALATED', escalatedAt: now, since: now, sendFailures, attempts, lastBlocker: blocker }, actions: [...journal, 'alert:SEND_FAILED'] };
  }
  return { next: { ...s, state: 'PREFLIGHT', since: now, sendFailures, attempts, lastBlocker: blocker }, actions: journal };
}

/** The Prometheus gauges from `ctx.state`, read at request time so a pause or a heartbeat shows at once. */
export function gaugesOf(ctx) {
  const state = ctx.state;
  const nowSecs = Math.floor(ctx.now() / 1000);
  const apply = state.apply ?? initialApplyState();
  const pendingEffectiveAt = (ACTIVE.has(apply.state) || apply.state === 'BLOCKED' || apply.state === 'ESCALATED') && apply.effectiveAt != null ? apply.effectiveAt : 0;
  const row = state.lastSnapshot?.portfolioRow ?? null;
  return {
    curator_last_tick_ts: state.lastTick?.at ?? 0,
    curator_hermes_heartbeat_ts: state.hermesHeartbeatAt ?? 0,
    curator_pending_effective_at: pendingEffectiveAt,
    curator_apply_state: apply.state,
    curator_book_price_fresh: row?.priceState === 'fresh' ? 1 : 0,
    curator_signer_lamports: state.lastSnapshot?.signer?.lamports ?? 0,
    curator_self_locked: state.selfLocked ? 1 : 0,
    curator_paused: state.paused ? 1 : 0,
    curator_write_attempts_1h: writeAttemptsLastHour(state.ledger, nowSecs),
  };
}

const describeDrift = (drift) => (Array.isArray(drift) ? drift : [])
  .map((d) => `${d.invariant}: expected ${d.expected}, actual ${d.actual}`)
  .join('; ') || 'invariant drift';

/**
 * @param {{ ctx: object, intervalMs?: number }} opts
 * @returns {{ start: () => void, stop: () => Promise<void>, tick: () => Promise<{ at: number, ok: boolean, applyState: string, blockers: object[], alerts: object[], error?: string }>, state: () => object }}
 */
export function createLoop(opts) {
  const { ctx, intervalMs = ctx?.config?.tickMs ?? 30000 } = opts ?? {};
  if (!ctx) throw new Error('createLoop: ctx is required');
  const meta = { session: 'cron', caller: 'loop', tokenKind: 'agent' };
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = (level, event, fields) => ctx.log?.(level, event, fields);
  let timer = null;
  let inFlight = null;

  const journal = (record) => {
    try {
      ctx.journal.append(record);
    } catch (error) {
      log('error', 'journal-append-failed', { kind: record.kind, error: scrubText(error?.message) });
    }
  };

  function applyActions(from, next, actions, gate, extra = {}) {
    const raised = [];
    for (const action of actions) {
      if (action === 'journal') {
        journal({
          kind: 'apply',
          from,
          to: next.state,
          deploymentId: next.deploymentId ?? null,
          effectiveAt: next.effectiveAt ?? null,
          blockers: (gate?.blockers ?? []).map((b) => b.code),
          attempts: next.attempts ?? 0,
          signatures: extra.signatures ?? [],
          ...(extra.outcome ? { outcome: extra.outcome } : {}),
        });
      } else if (action.startsWith('alert:')) {
        const code = action.slice('alert:'.length);
        const message = next.lastBlocker?.code === code && next.lastBlocker.message
          ? `${code}: ${next.lastBlocker.message}`
          : `${code} while applying${next.deploymentId ? ` ${next.deploymentId}` : ''}`;
        if (raiseAlert(ctx, `apply:${code}`, code, message)) raised.push({ key: `apply:${code}`, code, message });
      }
    }
    return raised;
  }

  async function sendWithBackoff(snapshot, nowSecs, policy) {
    const a = applyPolicy(policy);
    let outcome = { ok: false, code: 'SEND_FAILED', message: 'no attempt' };
    for (let i = 0; i < Math.max(1, a.maxSendsPerTick); i += 1) {
      try {
        const result = await applySend(ctx, meta, { snapshot: i === 0 ? snapshot : undefined });
        outcome = { ok: true, signatures: result.signatures ?? [] };
        break;
      } catch (error) {
        const code = error instanceof Refusal ? error.code : 'SEND_FAILED';
        outcome = { ok: false, code, message: scrubText(error?.message ?? String(error)), detail: error?.detail };
        const retriable = code === 'SEND_FAILED' && Boolean(error?.detail?.expired);
        if (!retriable || i === a.maxSendsPerTick - 1) break;
        await sleep(1000 * 2 ** i);
      }
    }
    return outcome;
  }

  async function runTick() {
    const nowSecs = Math.floor(ctx.now() / 1000);
    const result = { at: nowSecs, ok: true, applyState: ctx.state.apply.state, blockers: [], alerts: [] };
    const deps = depsOf(ctx);

    let snapshot;
    try {
      snapshot = await deps.readSnapshot(ctx);
    } catch (error) {
      const message = scrubText(error?.message ?? String(error));
      if (ctx.state.lastTick?.ok !== false) journal({ kind: 'tick', ok: false, error: message });
      ctx.state.lastTick = { at: nowSecs, ok: false, error: message };
      log('error', 'tick-snapshot-failed', { error: message });
      return { ...result, ok: false, error: message };
    }
    ctx.state.lastSnapshot = snapshot;

    // The NAV table's contents, so the decoder can resolve a v0 apply page.
    if (typeof ctx.chain?.refreshLookupTables === 'function') {
      try {
        await ctx.chain.refreshLookupTables();
      } catch (error) {
        log('warn', 'lookup-table-refresh-failed', { error: scrubText(error?.message) });
      }
    }

    // Invariants: any drift locks every write until an operator unlocks.
    let invariants = null;
    try {
      invariants = deps.checkInvariants(snapshot, ctx.config, ctx.policy);
    } catch (error) {
      log('error', 'invariants-check-failed', { error: scrubText(error?.message) });
    }
    // Not drift, not proof: an invariant this tick could not read (or a check
    // that threw) holds every write until the reads succeed.
    const unverified = invariants
      ? (Array.isArray(invariants.unverified) ? invariants.unverified.map(String) : [])
      : ['invariants (check failed)'];
    ctx.state.invariantsUnverified = unverified.length ? unverified : null;
    if (unverified.length) {
      const message = `${unverified.join(', ')} could not be verified this tick; writes are held until the accountant and FactoryConfig reads succeed`;
      if (raiseAlert(ctx, 'invariants_unverified', 'INVARIANTS_UNVERIFIED', message)) {
        result.alerts.push({ key: 'invariants_unverified', code: 'INVARIANTS_UNVERIFIED', message });
      }
      log('warn', 'invariants-unverified', { unverified });
    } else {
      clearAlert(ctx, 'invariants_unverified');
    }
    if (invariants && invariants.ok === false) {
      const drift = Array.isArray(invariants.drift) ? invariants.drift : [];
      if (!ctx.state.selfLocked) {
        ctx.state.selfLocked = { at: nowSecs, reason: 'INVARIANT_DRIFT', drift };
        journal({ kind: 'lock', reason: 'INVARIANT_DRIFT', drift });
        log('error', 'self-locked', { drift });
      }
      if (raiseAlert(ctx, 'invariants', 'INVARIANT_DRIFT', describeDrift(drift))) {
        result.alerts.push({ key: 'invariants', code: 'INVARIANT_DRIFT', message: describeDrift(drift) });
      }
    }

    // The chain's last apply counts for cadence even when this journal never saw it.
    const lastRebalanceAt = num(snapshot.portfolioAccount?.lastRebalanceAt);
    if (lastRebalanceAt != null && lastRebalanceAt > 0) {
      const ledger = ctx.state.ledger;
      if (ledger.lastProposalAt == null || lastRebalanceAt > ledger.lastProposalAt) ledger.lastProposalAt = lastRebalanceAt;
    }

    // Standing alerts.
    const lamports = snapshot.signer?.lamports;
    const floor = ctx.policy?.rate?.minSignerLamports;
    if (typeof lamports === 'number' && typeof floor === 'number') {
      if (lamports < floor) {
        if (raiseAlert(ctx, 'sol', 'LOW_SOL', `signer holds ${lamports} lamports, floor ${floor}`)) result.alerts.push({ key: 'sol', code: 'LOW_SOL' });
      } else {
        clearAlert(ctx, 'sol');
      }
    }

    // The machine, unless held.
    const held = Boolean(ctx.state.paused) || Boolean(ctx.state.selfLocked) || unverified.length > 0;
    if (held) {
      log('info', 'tick-held', { paused: Boolean(ctx.state.paused), selfLocked: Boolean(ctx.state.selfLocked), unverified, applyState: ctx.state.apply.state });
    } else {
      const pending = pendingOf(snapshot);
      let gate = { pending, currentTargets: currentTargetsOf(snapshot), lastRebalanceAt, keeperOk: keeperOkOf(snapshot.health) };
      if (pending || ACTIVE.has(ctx.state.apply.state)) {
        try {
          const gates = deps.applyGates(snapshot, ctx.policy, nowSecs);
          gate = { ...gate, ...(gates ?? {}) };
        } catch (error) {
          log('error', 'apply-gates-failed', { error: scrubText(error?.message) });
        }
      }
      const from = ctx.state.apply.state;
      const { next, actions } = stepApply(ctx.state.apply, gate, nowSecs, ctx.policy);
      ctx.state.apply = next;
      result.alerts.push(...applyActions(from, next, actions, gate));
      result.blockers = gate.ok === false ? (gate.blockers ?? []) : [];

      if (actions.includes('refresh-nav')) {
        try {
          const out = await refreshNav(ctx, {}, meta);
          log('info', 'refresh-nav-sent', { pages: out.pages, signatures: out.signatures });
        } catch (error) {
          log('warn', 'refresh-nav-refused', { code: error?.code ?? 'ERROR', error: scrubText(error?.message) });
        }
      }
      if (actions.includes('send')) {
        const outcome = await sendWithBackoff(snapshot, nowSecs, ctx.policy);
        const sendFrom = ctx.state.apply.state;
        const stepped = applyOutcome(ctx.state.apply, outcome, nowSecs, ctx.policy);
        ctx.state.apply = stepped.next;
        result.alerts.push(...applyActions(sendFrom, stepped.next, stepped.actions, gate, {
          signatures: outcome.ok ? outcome.signatures : [],
          outcome: outcome.ok ? 'sent' : `${outcome.code}: ${outcome.message ?? ''}`.slice(0, 300),
        }));
        if (!outcome.ok) log('warn', 'apply-send-failed', { code: outcome.code, error: outcome.message });
      }
      if (ctx.state.apply.state === 'IDLE' || ctx.state.apply.state === 'DONE') clearApplyAlerts(ctx);
    }

    ctx.state.lastTick = { at: nowSecs, ok: true, error: null };
    result.applyState = ctx.state.apply.state;
    return result;
  }

  function tick() {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  const guarded = () => tick().catch((error) => log('error', 'tick-crashed', { error: scrubText(error?.message ?? String(error)) }));

  return {
    start() {
      if (timer) return;
      timer = setInterval(guarded, intervalMs);
      timer.unref?.();
      void guarded();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight.catch(() => {});
    },
    tick,
    state: () => ({ running: timer !== null, intervalMs, apply: ctx.state.apply, lastTick: ctx.state.lastTick }),
  };
}
