/**
 * Derived views for humans and machines: the daily brief the review cron
 * hands to the LLM (with the wake triggers that justify spending a model
 * call), and the Prometheus gauges Alertmanager watches so an alert fires
 * without any LLM in the loop.
 *
 * Pure: everything is computed from the snapshot row, the pool rows, the
 * api health, the signer status and the cron's notepad; tests hand in
 * fixtures and assert on the trigger set.
 *
 * The brief speaks weavr: portfolio, asset, rebalance, deposit, shares;
 * percent and USD, never base units or "bps" — the LLM that reads it has no
 * business converting units, and a unit slip in a brief becomes a wrong
 * proposal. Numbers that change every day stay out of `holdReason`, which
 * must read the same on two quiet days so the cron can stay `[SILENT]`.
 */

/** Plan §4.6 / policy.v1 `review` defaults; `status.policy.review` overrides them when the verb passes it. */
const REVIEW_DEFAULTS = Object.freeze({
  monthlyReviewWeekday: 1,
  legNeedsInflowGates: 3,
  legNoInflowDays: 7,
  publisherParkHours: 6,
  drawdown30dPct: -35,
  briefMaxChars: 4096,
});

/** The apply machine's states in gauge order (loop.js APPLY_STATES; repeated here so metrics stays import-free). */
const APPLY_STATES = ['IDLE', 'ARMED', 'WAIT_NOTICE', 'PREFLIGHT', 'SEND', 'CONFIRM', 'DONE', 'BLOCKED', 'ESCALATED'];

const DAY = 86400;

const num = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(typeof value === 'bigint' ? value : value.toString());
  return Number.isFinite(parsed) ? parsed : null;
};

/** RFC 3339 or unix seconds → unix seconds. */
const secs = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' && /[^0-9.]/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return num(value);
};

/** USDC base units (6 decimals) → dollars. */
const usdOf = (baseUnits) => {
  const value = num(baseUnits);
  return value == null ? null : value / 1e6;
};

const round = (value, places = 1) => (value == null ? null : Number(value.toFixed(places)));

const fmtUsd = (value) => (value == null ? 'unknown' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPct = (value, places = 1) => (value == null ? 'unknown' : `${round(value, places)}%`);
const fmtSigned = (value, places = 1) => (value == null ? 'unknown' : `${value >= 0 ? '+' : ''}${round(value, places)}%`);
const fmtAge = (ageSecs) => {
  if (ageSecs == null) return 'unknown age';
  if (ageSecs < 120) return `${Math.max(0, Math.round(ageSecs))} s old`;
  if (ageSecs < 2 * 3600) return `${Math.round(ageSecs / 60)} min old`;
  if (ageSecs < 2 * DAY) return `${Math.round(ageSecs / 3600)} h old`;
  return `${Math.round(ageSecs / DAY)} d old`;
};
const fmtDate = (unixSecs) => (unixSecs == null ? 'unknown' : new Date(unixSecs * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');

/** The notepad is a per-job string KV (`hermes cron notepad <job> set <key> <value>`); values may be JSON, numbers, flags or text. */
const note = (notepad, key) => {
  const raw = notepad?.[key];
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
const flag = (value) => value === true || value === 1 || /^(1|true|yes|spent)$/i.test(String(value ?? ''));

const poolIndex = (pools) => {
  const list = pools instanceof Map ? [...pools.values()] : (pools ?? []);
  return new Map(list.map((pool) => [pool.poolId, pool]));
};

/**
 * Σ|Δw_i| × maxExecutionLossBps_i / 10000 in bps of value — the same bound the
 * policy's COST_CAP uses — between the portfolio's current target weights and
 * a candidate set (union of both, a missing side is 0). Pools without a row
 * count at `fallbackLossBps` (100, the universe cap) so an unknown cost is
 * never an optimistic one.
 * @param {object} row GET /v1/portfolios/:mint
 * @param {Array<object> | Map<string, object>} pools
 * @param {Array<{ poolId: string, weightBps: number }>} candidate
 * @param {{ from?: Array<{ poolId: string, weightBps: number }>, fallbackLossBps?: number }} [opts] `from` replaces the row's targets (e.g. actual weights)
 * @returns {number | null} bps, null when the current targets are unknown
 */
export function deltaCostBps(row, pools, candidate, { from, fallbackLossBps = 100 } = {}) {
  const current = from ?? row?.targets ?? row?.holdings?.legs?.map((leg) => ({ poolId: leg.poolId, weightBps: leg.targetWeightBps })) ?? null;
  if (!current) return null;
  const index = poolIndex(pools);
  const weights = new Map();
  for (const target of current) weights.set(target.poolId, { from: num(target.weightBps) ?? 0, to: 0 });
  for (const target of candidate ?? []) {
    const entry = weights.get(target.poolId) ?? { from: 0, to: 0 };
    entry.to = num(target.weightBps) ?? 0;
    weights.set(target.poolId, entry);
  }
  let cost = 0;
  for (const [poolId, { from: a, to: b }] of weights) {
    const loss = num(index.get(poolId)?.maxExecutionLossBps) ?? fallbackLossBps;
    cost += (Math.abs(b - a) * loss) / 10000;
  }
  return round(cost, 2);
}

/** True on the policy's review weekday inside the first seven days of a UTC month (the first Monday, by default). */
export function isMonthlyReviewDay(now, weekday = REVIEW_DEFAULTS.monthlyReviewWeekday) {
  const date = new Date(now * 1000);
  return date.getUTCDay() === weekday && date.getUTCDate() <= 7;
}

/**
 * The review brief and wake triggers (plan §4.6 curator-review).
 *
 * Trigger codes: MONTHLY_REVIEW (the first Monday), LEG_NEEDS_INFLOW (an asset
 * under target beyond the band for ≥ `legNeedsInflowGates` consecutive
 * reviews, no deposit for `legNoInflowDays` and the top-up budget spent),
 * HELD_POOL_NOT_ACTIVE, PUBLISHER_PARK (a held or book mark parked longer
 * than `publisherParkHours`), DRAWDOWN_30D (30-day return under
 * `drawdown30dPct`), RISK_TIER_RAISED (a held pool's riskTier above the one
 * the notepad stored), OPERATOR_REQUEST (a notepad or status flag).
 *
 * The notepad carries what one review cannot know on its own: `drift_streak`
 * (JSON `{poolId: reviews}`), `last_inflow_at` (unix secs or RFC 3339),
 * `topup_budget_spent` (flag), `risk_tiers` (JSON `{poolId: tier}`),
 * `operator_request` (text). `metrics.driftStreak` and `metrics.riskTiers`
 * are the values the cron script writes back for tomorrow.
 *
 * `brief` is ≤ `briefMaxChars` of plain text whose LAST line is the JSON
 * `{"wakeAgent": bool}` the Hermes wake gate reads; `wakeAgent` is true when
 * any trigger fires; `holdReason` is stable text so the cron can stay
 * `[SILENT]` on an unchanged HOLD.
 *
 * Also accepts the README's five-argument form `(row, pools, health, status, now)`.
 * @param {object} row GET /v1/portfolios/:mint
 * @param {Array<object>} pools GET /v1/pools rows
 * @param {object} health GET /health
 * @param {object} status the signer's /status body (`policy.review` overrides the thresholds; `vault` caps are optional)
 * @param {object} notepad the review job's notepad, string values
 * @param {number} now unix secs
 * @returns {{ brief: string, triggers: Array<{ code: string, detail: string }>, wakeAgent: boolean, holdReason: string, metrics: object }}
 */
export function deriveReview(row, pools, health, status, notepad, now) {
  if (typeof notepad === 'number' && now === undefined) {
    now = notepad;
    notepad = {};
  }
  notepad ??= {};
  const thresholds = { ...REVIEW_DEFAULTS, ...(status?.policy?.review ?? status?.review ?? {}) };
  const index = poolIndex(pools);
  const bandPct = (num(row?.driftBandBps) ?? 200) / 100;

  // --- per asset -----------------------------------------------------------
  const holdings = row?.holdings?.legs ?? null;
  const targets = row?.targets ?? null;
  const legs = (holdings ?? targets ?? []).map((leg) => {
    const pool = index.get(leg.poolId) ?? null;
    const targetPct = (num(leg.targetWeightBps ?? leg.weightBps) ?? 0) / 100;
    const actualPct = holdings ? (num(leg.weightBps) == null ? null : num(leg.weightBps) / 100) : null;
    const driftPct = actualPct == null ? null : actualPct - targetPct;
    return {
      poolId: leg.poolId,
      symbol: leg.symbol ?? pool?.symbol ?? leg.poolId,
      status: pool?.status ?? null,
      priceState: pool?.priceState ?? null,
      pendingPrice: pool?.pendingPrice ?? null,
      pythFeedId: pool?.pythFeedId ?? null,
      riskTier: num(pool?.riskTier),
      valueUsd: usdOf(leg.valueUsdc),
      targetPct: round(targetPct, 2),
      actualPct: round(actualPct, 2),
      driftPct: round(driftPct, 2),
      // The keeper trims only above target + band; underweight heals only
      // through inflow (a deposit) or a top-up. Inside the band nothing moves.
      selfHealing: driftPct != null && driftPct > bandPct,
      needsInflow: driftPct != null && driftPct < -bandPct,
      inputsComplete: pool != null && pool.trailingYieldBps != null && pool.tvlUsdc != null && pool.riskTier != null,
    };
  });

  const drifts = legs.map((leg) => leg.driftPct).filter((value) => value != null);
  const maxDriftPct = drifts.length ? round(Math.max(...drifts.map(Math.abs)), 2) : null;
  const worst = legs.filter((leg) => leg.driftPct != null).sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))[0] ?? null;
  const idlePct = row?.holdings?.idleWeightBps == null ? null : round(num(row.holdings.idleWeightBps) / 100, 2);
  const idleTargetPct = row?.idleTargetBps == null ? null : num(row.idleTargetBps) / 100;
  const price = num(row?.price);
  const navUsd = usdOf(row?.tvlUsdc);
  const navAsOf = secs(row?.priceAsOf);
  const navFreshAgeSecs = navAsOf == null ? null : Math.max(0, now - navAsOf);
  const withdrawalsPendingShares = num(row?.withdrawalsPending);
  const withdrawalsPendingUsd = withdrawalsPendingShares == null || price == null ? null : round((withdrawalsPendingShares * price) / 1e12, 2);

  // Caps are on VaultConfig, not on the row (P5 adds `row.caps`); the verb may
  // pass them as `status.vault`. Unknown stays unknown rather than 100 %.
  const caps = status?.vault ?? row?.caps ?? null;
  const maxShares = num(caps?.maxTotalShares);
  const totalShares = num(caps?.totalShares ?? row?.totalShares);
  const capHeadroomPct = maxShares && totalShares != null ? round(((maxShares - totalShares) / maxShares) * 100, 1) : null;
  const capHeadroomUsd = maxShares && totalShares != null && price != null ? round(((maxShares - totalShares) * price) / 1e12, 2) : null;

  const lastRebalanceAt = secs(status?.portfolio?.lastRebalanceAt);
  const quietDays = lastRebalanceAt == null ? null : Math.floor((now - lastRebalanceAt) / DAY);
  const healCostBps = holdings
    ? deltaCostBps(row, pools, legs.map((leg) => ({ poolId: leg.poolId, weightBps: Math.round(leg.targetPct * 100) })),
      { from: legs.map((leg) => ({ poolId: leg.poolId, weightBps: Math.round((leg.actualPct ?? leg.targetPct) * 100) })) })
    : null;
  const inputsComplete = legs.length > 0 && legs.every((leg) => leg.inputsComplete);
  const return30dPct = num(row?.returns?.['30d']?.portfolio);
  const benchmark30dPct = num(row?.returns?.['30d']?.btc);

  // --- streaks carried through the notepad -------------------------------------
  const previousStreak = note(notepad, 'drift_streak');
  const driftStreak = {};
  for (const leg of legs) {
    const prior = typeof previousStreak === 'object' && previousStreak ? num(previousStreak[leg.poolId]) ?? 0 : num(previousStreak) ?? 0;
    driftStreak[leg.poolId] = leg.needsInflow ? prior + 1 : 0;
  }
  const lastInflowAt = secs(note(notepad, 'last_inflow_at')) ?? secs(status?.ledger?.lastDepositAt);
  const daysSinceInflow = lastInflowAt == null ? null : Math.floor((now - lastInflowAt) / DAY);
  const budgetSpent = flag(note(notepad, 'topup_budget_spent')) || flag(status?.ledger?.topUpBudgetSpent);
  const storedTiers = note(notepad, 'risk_tiers');
  const riskTiers = Object.fromEntries(legs.filter((leg) => leg.riskTier != null).map((leg) => [leg.poolId, leg.riskTier]));

  // --- triggers ------------------------------------------------------------------
  const triggers = [];
  if (isMonthlyReviewDay(now, thresholds.monthlyReviewWeekday)) {
    triggers.push({ code: 'MONTHLY_REVIEW', detail: 'first review weekday of the month: revisit the thesis' });
  }
  for (const leg of legs) {
    const streak = driftStreak[leg.poolId];
    const noInflow = daysSinceInflow == null || daysSinceInflow >= thresholds.legNoInflowDays;
    if (streak >= thresholds.legNeedsInflowGates && noInflow && budgetSpent) {
      triggers.push({
        code: 'LEG_NEEDS_INFLOW',
        detail: `${leg.symbol} ${fmtSigned(leg.driftPct)} under target for ${streak} reviews, no deposit for ${daysSinceInflow == null ? 'an unknown time' : `${daysSinceInflow} d`}, top-up budget spent`,
      });
    }
  }
  for (const leg of legs) {
    if (leg.status !== 'active') {
      triggers.push({ code: 'HELD_POOL_NOT_ACTIVE', detail: `${leg.symbol} is ${leg.status ?? 'missing from the catalogue'}` });
    }
  }
  const parkHours = thresholds.publisherParkHours;
  const parkedAt = (pending) => secs(pending?.proposedAt);
  for (const leg of legs) {
    const at = parkedAt(leg.pendingPrice);
    if (leg.pendingPrice && at != null && now - at > parkHours * 3600) {
      triggers.push({
        code: 'PUBLISHER_PARK',
        detail: `${leg.symbol} mark parked ${Math.floor((now - at) / 3600)} h (${leg.pythFeedId ? 'Pyth-cranked, should have cleared' : 'publisher-marked, nobody cranks it'})`,
      });
    }
  }
  const bookParkedAt = parkedAt(row?.pendingPrice);
  if (row?.pendingPrice && bookParkedAt != null && now - bookParkedAt > parkHours * 3600) {
    triggers.push({ code: 'PUBLISHER_PARK', detail: `the portfolio's own mark is parked ${Math.floor((now - bookParkedAt) / 3600)} h` });
  }
  if (return30dPct != null && return30dPct < thresholds.drawdown30dPct) {
    triggers.push({ code: 'DRAWDOWN_30D', detail: `30-day return ${fmtSigned(return30dPct)} is under ${fmtPct(thresholds.drawdown30dPct)}` });
  }
  if (storedTiers && typeof storedTiers === 'object') {
    for (const leg of legs) {
      const before = num(storedTiers[leg.poolId]);
      if (before != null && leg.riskTier != null && leg.riskTier > before) {
        triggers.push({ code: 'RISK_TIER_RAISED', detail: `${leg.symbol} risk tier ${before} → ${leg.riskTier}` });
      }
    }
  }
  const operatorRequest = note(notepad, 'operator_request') ?? status?.operatorRequest ?? null;
  if (operatorRequest) {
    triggers.push({ code: 'OPERATOR_REQUEST', detail: String(operatorRequest).slice(0, 200) });
  }
  const wakeAgent = triggers.length > 0;

  // --- hold reason: categorical only, so two quiet days read the same -------------
  const pendingChange = row?.pendingTargets ?? null;
  const holdParts = [];
  if (status?.selfLocked) holdParts.push('signer self-locked');
  else if (status?.paused) holdParts.push('signer paused');
  if (pendingChange) holdParts.push('a rebalance is announced and waits for its notice');
  else holdParts.push(maxDriftPct != null && maxDriftPct <= bandPct ? 'every asset inside its band' : 'drift heals on its own or through deposits');
  holdParts.push(row?.priceState === 'fresh' ? 'portfolio price fresh' : `portfolio price ${row?.priceState ?? 'unknown'}`);
  holdParts.push(inputsComplete ? 'inputs complete' : 'inputs incomplete');
  const holdReason = wakeAgent ? '' : `HOLD: ${holdParts.join('; ')}`;

  // --- brief ---------------------------------------------------------------------
  const applyState = status?.apply?.state ?? 'unknown';
  const ledger = status?.ledger ?? {};
  const lines = [];
  lines.push(`WEAVR review ${fmtDate(now)}`);
  lines.push(`Portfolio ${row?.symbol ?? 'unknown'}: ${row?.state ?? 'unknown'}, ${fmtUsd(navUsd)} across ${legs.length} assets, ${fmtPct(idlePct)} idle (target ${fmtPct(idleTargetPct)}), price ${row?.priceState ?? 'unknown'} (${fmtAge(navFreshAgeSecs)}).`);
  lines.push(pendingChange
    ? `Pending: rebalance announced ${fmtDate(secs(pendingChange.proposedAt))}, applies ${fmtDate(secs(pendingChange.effectiveAt))}; signer apply state ${applyState}.`
    : `Pending: none; signer apply state ${applyState}.`);
  lines.push(`Withdrawals waiting: ${fmtUsd(withdrawalsPendingUsd)}. Cap headroom: ${capHeadroomPct == null ? 'unknown' : `${fmtPct(capHeadroomPct)} (${fmtUsd(capHeadroomUsd)})`}. Last rebalance: ${quietDays == null ? 'unknown' : `${quietDays} d ago`}.`);
  lines.push(`30-day return: ${fmtSigned(return30dPct)}${benchmark30dPct != null ? ` (BTC ${fmtSigned(benchmark30dPct)})` : ''}. Inputs complete: ${inputsComplete ? 'yes' : 'no'}.`);
  const assetLines = legs.map((leg) => {
    const state = leg.driftPct == null ? 'value unknown'
      : leg.needsInflow ? `needs inflow, ${driftStreak[leg.poolId]} review${driftStreak[leg.poolId] === 1 ? '' : 's'} running`
        : leg.selfHealing ? 'keeper trims' : 'inside band';
    const mark = leg.pendingPrice ? ', mark parked' : leg.priceState && leg.priceState !== 'fresh' ? `, mark ${leg.priceState}` : '';
    return `  ${leg.symbol}: ${fmtPct(leg.actualPct)} of ${fmtPct(leg.targetPct)} target (${fmtSigned(leg.driftPct)}), ${fmtUsd(leg.valueUsd)}, ${leg.status ?? 'no catalogue row'}${mark} — ${state}`;
  });
  lines.push(`Assets (actual of target, drift band ${fmtPct(bandPct)}):`);
  lines.push(...assetLines);
  lines.push(`Largest drift: ${worst ? `${fmtPct(maxDriftPct)} (${worst.symbol})` : 'unknown'}. Cost for the keeper to close all drift: ${healCostBps == null ? 'unknown' : `${fmtPct(healCostBps / 100, 3)} of value`}.`);
  lines.push(`Signer: ${status?.paused ? 'paused' : 'running'}, ${status?.selfLocked ? 'self-locked' : 'invariants ok'}, proposals last 30 d ${ledger.proposalsLast30d ?? 'unknown'}, deposited today ${fmtUsd(num(ledger.depositsTodayUsd))}, withdrawn today ${fmtUsd(num(ledger.withdrawalsTodayUsd))}. Cluster ${health?.status ?? 'unknown'}, keeper ${health?.processes?.keeper?.status ?? health?.keeper?.status ?? 'unknown'}.`);
  lines.push(wakeAgent
    ? `Triggers: ${triggers.map((trigger) => `${trigger.code} — ${trigger.detail}`).join(' | ')}`
    : `Triggers: none. ${holdReason}`);
  const tail = JSON.stringify({ wakeAgent });
  const brief = fitBrief(lines, tail, thresholds.briefMaxChars);

  const metrics = {
    legs,
    maxDriftPct,
    bandPct,
    idlePct,
    idleTargetPct,
    navUsd,
    navFreshAgeSecs,
    withdrawalsPendingUsd,
    capHeadroomPct,
    capHeadroomUsd,
    quietDays,
    healCostBps,
    inputsComplete,
    return30dPct,
    driftStreak,
    riskTiers,
    daysSinceInflow,
    budgetSpent,
  };
  return { brief, triggers, wakeAgent, holdReason, metrics };
}

/** Join the lines under the cap with the JSON tail intact: drop asset lines from the end first, then hard-cut the text. */
function fitBrief(lines, tail, maxChars) {
  const room = maxChars - tail.length - 1;
  let body = lines.join('\n');
  let kept = [...lines];
  while (body.length > room && kept.some((line) => line.startsWith('  '))) {
    const last = kept.map((line) => line.startsWith('  ')).lastIndexOf(true);
    kept.splice(last, 1);
    body = kept.join('\n');
  }
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1))}…`;
  return `${body}\n${tail}`;
}

/**
 * Prometheus text exposition for GET /metrics from the ctx.state gauges:
 * curator_last_tick_ts, curator_hermes_heartbeat_ts,
 * curator_pending_effective_at, curator_apply_state{state=…} (1 on the
 * current state, 0 on the others, so a rule can match by label),
 * curator_book_price_fresh, curator_signer_lamports, curator_self_locked,
 * curator_paused, curator_write_attempts_1h. A gauge never seen (no heartbeat
 * yet) is 0, which is what an alert on staleness should see.
 * @param {{ lastTickTs?: number, hermesHeartbeatTs?: number, pendingEffectiveAt?: number, applyState?: string, bookPriceFresh?: boolean | number, signerLamports?: number, selfLocked?: boolean | number, paused?: boolean | number, writeAttempts1h?: number }} gauges
 * @returns {string}
 */
/**
 * Gauge keys arrive in two spellings: the metric names themselves (what
 * `loop.gaugesOf` emits, `curator_signer_lamports`) and the camelCase the
 * first renderer read (`signerLamports`). Accepting both is what stops a
 * producer/renderer rename from silently rendering every gauge as 0 — the
 * defect a fake renderer in the server tests once hid.
 */
const GAUGE_ALIASES = Object.freeze({
  lastTickTs: 'curator_last_tick_ts',
  hermesHeartbeatTs: 'curator_hermes_heartbeat_ts',
  pendingEffectiveAt: 'curator_pending_effective_at',
  applyState: 'curator_apply_state',
  bookPriceFresh: 'curator_book_price_fresh',
  signerLamports: 'curator_signer_lamports',
  selfLocked: 'curator_self_locked',
  paused: 'curator_paused',
  writeAttempts1h: 'curator_write_attempts_1h',
});

export function normaliseGauges(raw = {}) {
  const out = {};
  for (const [camel, metric] of Object.entries(GAUGE_ALIASES)) {
    out[camel] = raw[camel] !== undefined ? raw[camel] : raw[metric];
  }
  return out;
}

export function renderPrometheus(rawGauges = {}) {
  const gauges = normaliseGauges(rawGauges);
  const value = (raw) => {
    if (raw === true) return 1;
    if (raw === false || raw == null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const gauge = (name, help, raw) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value(raw)}`];
  const lines = [
    ...gauge('curator_last_tick_ts', 'Unix time of the last loop tick.', gauges.lastTickTs),
    ...gauge('curator_hermes_heartbeat_ts', 'Unix time of the last POST /hermes-heartbeat.', gauges.hermesHeartbeatTs),
    ...gauge('curator_pending_effective_at', 'effectiveAt of the pending targets change, 0 when none.', gauges.pendingEffectiveAt),
    '# HELP curator_apply_state Apply state machine; 1 on the current state.',
    '# TYPE curator_apply_state gauge',
    ...APPLY_STATES.map((state) => `curator_apply_state{state="${state}"} ${gauges.applyState === state ? 1 : 0}`),
    ...gauge('curator_book_price_fresh', '1 when the book priceState is fresh.', gauges.bookPriceFresh),
    ...gauge('curator_signer_lamports', 'Signer SOL balance in lamports.', gauges.signerLamports),
    ...gauge('curator_self_locked', '1 while an invariant drift holds every write.', gauges.selfLocked),
    ...gauge('curator_paused', '1 while paused by /pause.', gauges.paused),
    ...gauge('curator_write_attempts_1h', 'Write verb attempts in the last hour.', gauges.writeAttempts1h),
  ];
  return `${lines.join('\n')}\n`;
}
