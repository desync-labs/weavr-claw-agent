/**
 * The policy engine (plan §4.4): pure functions over the policy document,
 * a snapshot and the ledger. No network, no clock of its own (`now` is an
 * argument), no side effects — so every refusal code can be proven on a
 * planted violation in a unit test.
 *
 * The engine refuses; it never clamps. A proposal 1 bps over a cap is
 * refused with the cap in the message so the LLM can re-plan; a "helpful"
 * rounding would hide the violation the policy exists to surface.
 *
 * Two conventions run through every function:
 *
 * - Unknown is never fine. A `null` pool input, a missing vault read, an
 *   absent ledger, an unreadable lamport balance or a signer share balance
 *   the snapshot could not read refuses with the code of the rule that could
 *   not be evaluated, instead of passing — the same rule the pre-flight gates
 *   follow ("null ⇒ wait"). The one deliberate exception is
 *   `pendingCurator`, where `null` is the expected value (Option::None).
 * - `now` may be milliseconds (`ctx.now()`) or unix seconds (`snapshot.at`,
 *   the ledger); it is normalised by magnitude so a caller mixing the two
 *   cannot open a cadence window by accident. Ledger and chain timestamps are
 *   always unix seconds; `nextProposeAt` is unix seconds.
 *
 * Chain values arrive as `fetchDecoded` returns them (`BN` for u64/i64,
 * `PublicKey` for pubkeys) or as the strings the REST row carries; every
 * comparison goes through `toNumber` / `toBigInt` / `toBase58` so the same
 * function serves both.
 */

const ok = Object.freeze({ ok: true });
const refuse = (code, message) => ({ ok: false, code, message });

/** Slippage the deposit and withdraw floors leave under the quoted price, on top of the vault fee. */
export const MIN_OUT_TOLERANCE_BPS = 50;

/** USDC and WEAVR shares both carry six decimals; the vault price is scaled by the same factor. */
const BASE_UNITS = 1_000_000n;
const HOUR_SECS = 3600;
const DAY_SECS = 86_400;

// ---------------------------------------------------------------------------
// Value helpers: BN / PublicKey / string / number → plain numbers and strings.
// ---------------------------------------------------------------------------

/** Unix seconds from a clock that may be ms (`Date.now()`) or seconds; > 1e11 is ms until the year 5138. */
export function toSecs(now) {
  const n = toNumber(now);
  if (n == null) throw new Error('policy: `now` must be a number');
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/** `null` for anything that is not a finite number after conversion (BN, bigint, numeric string). */
export function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object' && typeof value.toString === 'function') {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `null` for anything that is not an integer after conversion; never throws. */
export function toBigInt(value) {
  if (value == null) return null;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null;
    if (typeof value === 'string') return value.trim() === '' ? null : BigInt(value.trim());
    if (typeof value === 'object' && typeof value.toString === 'function') return BigInt(value.toString());
  } catch {
    return null;
  }
  return null;
}

/** Base58 text from a `PublicKey` or a string; `null` for anything else. */
export function toBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toBase58 === 'function') return value.toBase58();
  return null;
}

const bigMin = (...values) => values.reduce((a, b) => (b < a ? b : a));

/** `YYYY-MM-DD` in UTC for the day caps and the launch-day switch. */
export function utcDay(nowSecs) {
  return new Date(nowSecs * 1000).toISOString().slice(0, 10);
}

/** True when `secs` is a "positive" ledger/chain timestamp (0 = never). */
const isSet = (secs) => secs != null && secs > 0;

// ---------------------------------------------------------------------------
// loadPolicy: a deliberately small schema — unknown and missing keys both fail.
// ---------------------------------------------------------------------------

const T = {
  uint: (v) => Number.isInteger(v) && v >= 0,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean',
  string: (v) => typeof v === 'string' && v.length > 0,
  stringOrNull: (v) => v === null || (typeof v === 'string' && v.length > 0),
  strings: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0),
};

const UINTS = (...keys) => Object.fromEntries(keys.map((key) => [key, 'uint']));

/** Every section and key the document must carry, with its type tag. */
const SCHEMA = Object.freeze({
  universe: {
    chains: 'strings',
    requireStatus: 'string',
    requirePythFeedId: 'bool',
    maxRiskTier: 'uint',
    maxExecutionLossBps: 'uint',
    allowlist: 'strings',
    categories: 'categories',
  },
  shape: {
    ...UINTS('minLegs', 'maxLegs', 'pageLimit', 'minLegWeightBps', 'maxLegWeightBps'),
    stableCategory: 'string',
    ...UINTS('stableMinBps', 'stableMaxBps', 'categoryMaxBps', 'sumBps'),
  },
  turnover: { maxTurnoverBps: 'uint' },
  cost: { maxEstimatedCostBps: 'number' },
  cadence: {
    ...UINTS('minSecsSinceLastRebalance', 'maxProposalsPer30d', 'quotaWindowSecs'),
    requireInputsComplete: 'bool',
    riskExitExemptFromInputs: 'bool',
    proposeWindowUtc: 'hourWindow',
  },
  reason: { required: 'bool', maxChars: 'uint' },
  deposit: {
    dailyCapUsd: 'number',
    launchDayCapUsd: 'number',
    launchDay: 'stringOrNull',
    requireBookFresh: 'bool',
  },
  withdraw: { chatOnly: 'bool', dailyCapUsd: 'number', toSignerAtaOnly: 'bool' },
  verbs: { agent: 'strings', ops: 'strings', denied: 'strings', cronDenied: 'strings' },
  rate: UINTS('maxWriteAttemptsPerHour', 'minSignerLamports'),
  invariants: { rebalanceDelaySecs: 'uint', compositionLocked: 'bool', pendingCuratorMustBeNone: 'bool' },
  apply: {
    ...UINTS(
      'tickSecs', 'armBeforeEffectiveSecs', 'windowAfterEffectiveSecs', 'maxSendsPerTick',
      'sendFailedTicksBeforeEscalate', 'refreshNavWhenBookStaleSecs', 'applyInFlightWaitSlots',
      'applyInFlightMaxAttempts', 'missingCustodyRetries',
    ),
    escalateAfterSecs: 'uintOrNullMap',
  },
  review: {
    ...UINTS('monthlyReviewWeekday', 'legNeedsInflowGates', 'legNoInflowDays', 'publisherParkHours'),
    drawdown30dPct: 'number',
    briefMaxChars: 'uint',
  },
});

const fail = (message) => { throw new Error(`policy: ${message}`); };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `_comment` keys are documentation for the file's readers; they never reach the engine. */
const stripComments = (object) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => key !== '_comment'));

function checkValue(path, value, type) {
  switch (type) {
    case 'categories': {
      if (!isPlainObject(value)) fail(`${path} must be an object of symbol lists`);
      const clean = stripComments(value);
      if (!Object.keys(clean).length) fail(`${path} must name at least one category`);
      for (const [name, list] of Object.entries(clean)) {
        if (!T.strings(list)) fail(`${path}.${name} must be a list of symbols`);
      }
      return clean;
    }
    case 'hourWindow': {
      if (!isPlainObject(value)) fail(`${path} must be { fromHour, toHour }`);
      const clean = stripComments(value);
      const keys = Object.keys(clean).sort();
      if (keys.join(',') !== 'fromHour,toHour') fail(`${path} must carry exactly fromHour and toHour`);
      const { fromHour, toHour } = clean;
      if (!T.uint(fromHour) || !T.uint(toHour) || fromHour >= toHour || toHour > 24) {
        fail(`${path} must satisfy 0 <= fromHour < toHour <= 24`);
      }
      return { fromHour, toHour };
    }
    case 'uintOrNullMap': {
      if (!isPlainObject(value)) fail(`${path} must be an object`);
      const clean = stripComments(value);
      for (const [key, secs] of Object.entries(clean)) {
        if (secs !== null && !T.uint(secs)) fail(`${path}.${key} must be a non-negative integer or null`);
      }
      return clean;
    }
    default: {
      const check = T[type];
      if (!check) fail(`internal: unknown schema type ${type}`);
      if (!check(value)) fail(`${path} must be ${type}`);
      return value;
    }
  }
}

function deepFreeze(object) {
  for (const value of Object.values(object)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(object);
}

/**
 * Parse and validate the policy document.
 *
 * Every section and key in `SCHEMA` must be present with the right type, and
 * nothing else may be present (`_comment` keys are dropped): an unknown key
 * is almost always a typo of a cap, and a typo'd cap is a cap that does not
 * apply. Beyond the shape it checks the relations the engine relies on: the
 * allowlist is unique and every symbol on it sits in exactly one category;
 * every category member is allowlisted (a member the engine can never target
 * is a stale edit); `stableCategory` exists; the leg and stable bands are
 * ordered; the verb lists do not contradict each other.
 *
 * Throws `Error('policy: …')`; returns a deep-frozen object.
 * @param {string | object} jsonOrObject CURATOR_POLICY_JSON or its parsed form
 * @returns {object}
 */
export function loadPolicy(jsonOrObject) {
  let raw = jsonOrObject;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      fail(`not valid JSON (${error.message})`);
    }
  }
  if (!isPlainObject(raw)) fail('document must be a JSON object');
  const doc = stripComments(raw);
  if (doc.version !== 1) fail(`version must be 1 (got ${JSON.stringify(doc.version)})`);

  const policy = { version: 1 };
  for (const [section, keys] of Object.entries(SCHEMA)) {
    if (!isPlainObject(doc[section])) fail(`missing section ${section}`);
    const given = stripComments(doc[section]);
    const out = {};
    for (const [key, type] of Object.entries(keys)) {
      if (!(key in given)) fail(`missing key ${section}.${key}`);
      out[key] = checkValue(`${section}.${key}`, given[key], type);
    }
    for (const key of Object.keys(given)) {
      if (!(key in keys)) fail(`unknown key ${section}.${key}`);
    }
    policy[section] = out;
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && !(key in SCHEMA)) fail(`unknown section ${key}`);
  }

  // Universe relations.
  const { allowlist, categories } = policy.universe;
  if (new Set(allowlist).size !== allowlist.length) fail('universe.allowlist has a duplicate symbol');
  const categoryOf = new Map();
  for (const [name, symbols] of Object.entries(categories)) {
    for (const symbol of symbols) {
      if (categoryOf.has(symbol)) fail(`${symbol} is in two categories (${categoryOf.get(symbol)}, ${name})`);
      categoryOf.set(symbol, name);
      if (!allowlist.includes(symbol)) fail(`category ${name} lists ${symbol}, which is not allowlisted`);
    }
  }
  for (const symbol of allowlist) {
    if (!categoryOf.has(symbol)) fail(`allowlisted ${symbol} is in no category`);
  }
  const { shape } = policy;
  if (!(shape.stableCategory in categories)) fail(`shape.stableCategory ${shape.stableCategory} is not a category`);
  if (shape.minLegs < 1 || shape.minLegs > shape.maxLegs) fail('shape.minLegs must be 1..maxLegs');
  if (shape.minLegWeightBps > shape.maxLegWeightBps) fail('shape.minLegWeightBps exceeds maxLegWeightBps');
  if (shape.stableMinBps > shape.stableMaxBps) fail('shape.stableMinBps exceeds stableMaxBps');
  if (shape.sumBps < 1) fail('shape.sumBps must be positive');

  // Verb relations: one verb, one answer.
  const { verbs } = policy;
  const seen = new Map();
  for (const list of ['agent', 'ops', 'denied']) {
    for (const verb of verbs[list]) {
      if (seen.has(verb)) fail(`verb ${verb} is in both verbs.${seen.get(verb)} and verbs.${list}`);
      seen.set(verb, list);
    }
  }
  for (const verb of verbs.cronDenied) {
    if (!seen.has(verb) || seen.get(verb) === 'denied') fail(`verbs.cronDenied ${verb} is not an agent or ops verb`);
  }
  if (policy.deposit.launchDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(policy.deposit.launchDay)) {
    fail('deposit.launchDay must be YYYY-MM-DD or null');
  }
  return deepFreeze(policy);
}

// ---------------------------------------------------------------------------
// verbAllowed and evaluateWrite: who may call what, and the checks every write shares.
// ---------------------------------------------------------------------------

/**
 * Is `verb` (the route name, e.g. 'refresh-nav') allowed for this token kind
 * and session? Raises VERB_DENIED (never-allowed verbs, and any verb the
 * policy does not name — unknown is denied), OPS_ONLY (ops verb with the
 * agent token; the ops token is a superset and may call agent verbs) and
 * WITHDRAW_CRON_BLOCKED (a `cronDenied` verb outside a chat session; a
 * missing or unknown session is cron, the more restrictive reading).
 * @param {object} policy
 * @param {string} verb
 * @param {{ session?: 'cron' | 'chat', tokenKind?: 'agent' | 'ops' }} meta
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function verbAllowed(policy, verb, meta = {}) {
  const { session, tokenKind } = meta ?? {};
  const v = policy.verbs;
  if (typeof verb !== 'string' || v.denied.includes(verb)) {
    return refuse('VERB_DENIED', `verb ${String(verb)} never goes through the signer`);
  }
  if (v.ops.includes(verb)) {
    if (tokenKind !== 'ops') return refuse('OPS_ONLY', `verb ${verb} needs the ops token`);
    return ok;
  }
  if (!v.agent.includes(verb)) return refuse('VERB_DENIED', `verb ${verb} is not in the policy`);
  if (tokenKind !== 'agent' && tokenKind !== 'ops') {
    return refuse('VERB_DENIED', `verb ${verb}: unknown token kind ${String(tokenKind)}`);
  }
  if (v.cronDenied.includes(verb) && session !== 'chat') {
    return refuse('WITHDRAW_CRON_BLOCKED', `verb ${verb} is allowed in chat sessions only (session: ${session ?? 'cron'})`);
  }
  return ok;
}

/** Write attempts inside the last hour, from the ledger's list or its rolled-up count; `null` when the ledger cannot say. */
function writeAttemptsLastHour(ledger, nowSecs) {
  if (!isPlainObject(ledger)) return null;
  if (Array.isArray(ledger.writeAttempts)) {
    return ledger.writeAttempts.filter((at) => {
      const t = toNumber(at);
      return t != null && t > nowSecs - HOUR_SECS && t <= nowSecs;
    }).length;
  }
  return toNumber(ledger.writeAttemptsLastHour);
}

/**
 * The pre-check every write verb runs first, in this order:
 * PORTFOLIO_NOT_ALLOWED (the requested mint is not the configured one, or no
 * mint is configured), SELF_LOCKED (every write, `cancel` included — the
 * operator unlocks), PAUSED (`cancel` passes, and so do the ops-token verbs:
 * kill-ladder step 5, the curator rotation, must not require a `resume` that
 * re-arms the agent mid-incident), RATE_LIMITED (write attempts in the last
 * hour, before this one is counted), LOW_SOL (signer lamports under the
 * floor; an unreadable balance refuses).
 * @param {{ policy: object, verb: string, portfolio: string, allowedPortfolio: string, state: object, ledger: object, lamports: number | null, now: number }} input `now` in ms or unix secs
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function evaluateWrite(input) {
  const { policy, verb, portfolio, allowedPortfolio, state, ledger, lamports } = input;
  const nowSecs = toSecs(input.now);
  const mint = toBase58(portfolio);
  const allowed = toBase58(allowedPortfolio);
  if (!allowed) return refuse('PORTFOLIO_NOT_ALLOWED', 'no allowed portfolio configured');
  if (mint !== allowed) return refuse('PORTFOLIO_NOT_ALLOWED', `portfolio ${mint ?? 'unknown'} is not ${allowed}`);
  if (!isPlainObject(state)) return refuse('SELF_LOCKED', 'signer state unavailable');
  if (state.selfLocked) {
    const reason = state.selfLocked.reason ?? 'invariant drift';
    return refuse('SELF_LOCKED', `writes are self-locked (${reason}); POST /unlock with the ops token once the drift is gone`);
  }
  if (state.paused && verb !== 'cancel' && !policy.verbs.ops.includes(verb)) {
    return refuse('PAUSED', `the signer is paused; only cancel and ops verbs run until POST /resume`);
  }
  const attempts = writeAttemptsLastHour(ledger, nowSecs);
  if (attempts == null) return refuse('RATE_LIMITED', 'ledger unavailable: write attempts cannot be counted');
  const max = policy.rate.maxWriteAttemptsPerHour;
  if (attempts >= max) return refuse('RATE_LIMITED', `${attempts} write attempts in the last hour reach the cap of ${max}`);
  const sol = toNumber(lamports);
  if (sol == null) return refuse('LOW_SOL', 'signer balance unknown');
  if (sol < policy.rate.minSignerLamports) {
    return refuse('LOW_SOL', `signer holds ${sol} lamports, under the ${policy.rate.minSignerLamports} floor`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// evaluateProposal: universe, shape, turnover, cost, cadence, reason.
// ---------------------------------------------------------------------------

/** Every leg the book carries (targets ∪ positions), as `{ poolId, symbol, targetWeightBps }`; `null` when unknown. */
function heldLegs(row) {
  if (!isPlainObject(row)) return null;
  if (Array.isArray(row.holdings?.legs)) {
    return row.holdings.legs
      .filter((leg) => leg?.poolId)
      .map((leg) => ({ poolId: leg.poolId, symbol: leg.symbol ?? null, targetWeightBps: toNumber(leg.targetWeightBps) ?? 0 }));
  }
  if (Array.isArray(row.targets) || Array.isArray(row.positions)) {
    const byId = new Map();
    for (const target of row.targets ?? []) {
      if (target?.poolId) byId.set(target.poolId, { poolId: target.poolId, symbol: null, targetWeightBps: toNumber(target.weightBps) ?? 0 });
    }
    for (const poolId of row.positions ?? []) {
      if (poolId && !byId.has(poolId)) byId.set(poolId, { poolId, symbol: null, targetWeightBps: 0 });
    }
    return [...byId.values()];
  }
  return null;
}

/** `{ ok:false, code:'BAD_REQUEST' }` unless targets is a non-empty list of unique `{ poolId, weightBps }` with integer weights. */
function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return refuse('BAD_REQUEST', 'targets must be a non-empty list');
  const seen = new Set();
  for (const [index, target] of targets.entries()) {
    if (!isPlainObject(target) || typeof target.poolId !== 'string' || !target.poolId) {
      return refuse('BAD_REQUEST', `targets[${index}].poolId must be a string`);
    }
    if (!Number.isInteger(target.weightBps) || target.weightBps < 0) {
      return refuse('BAD_REQUEST', `targets[${index}].weightBps must be a non-negative integer`);
    }
    if (seen.has(target.poolId)) return refuse('BAD_REQUEST', `targets repeats ${target.poolId}`);
    seen.add(target.poolId);
  }
  return ok;
}

/** True inside `[fromHour, toHour)` UTC. */
function insideWindow(secs, { fromHour, toHour }) {
  const hour = new Date(secs * 1000).getUTCHours();
  return hour >= fromHour && hour < toHour;
}

/** The first second at or after `secs` that is inside the UTC window. */
function nextInsideWindow(secs, window) {
  if (insideWindow(secs, window)) return secs;
  const d = new Date(secs * 1000);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const todayOpen = dayStart + window.fromHour * HOUR_SECS;
  return secs < todayOpen ? todayOpen : todayOpen + DAY_SECS;
}

/** Ledger proposals inside the quota window, ascending; falls back to the rolled-up count when only that is known. */
function recentProposals(ledger, nowSecs, windowSecs) {
  if (!isPlainObject(ledger)) return null;
  if (Array.isArray(ledger.proposals)) {
    const inWindow = ledger.proposals
      .map((p) => toNumber(p?.at))
      .filter((at) => at != null && at > nowSecs - windowSecs && at <= nowSecs)
      .sort((a, b) => a - b);
    const rolled = toNumber(ledger.proposalsLast30d);
    // Two answers disagree ⇒ trust the larger one (a count cannot be rebuilt lower than the list).
    if (rolled != null && rolled > inWindow.length) return { count: rolled, at: inWindow };
    return { count: inWindow.length, at: inWindow };
  }
  const rolled = toNumber(ledger.proposalsLast30d);
  return rolled == null ? null : { count: rolled, at: [] };
}

/**
 * §4.4 universe, shape, turnover, cost, cadence and reason rules over a
 * proposed target set. `refusals` lists every violation found, in the
 * table's order; `code` and `message` are the first, so a verb throws one
 * Refusal while `/simulate` shows the LLM the whole list.
 *
 * Definitions the rules rely on:
 * - current weights are the book's *target* weights (`holdings.legs[].targetWeightBps`),
 *   never the actual ones — the keeper moves money towards target, so a
 *   proposal's cost is the distance between two target sets;
 * - held = every leg the book carries (targets ∪ positions), and
 *   `|held ∪ new| ≤ pageLimit` mirrors the api's one-page apply;
 * - turnover = Σ|Δw| / 2 over held ∪ new; estimated cost = Σ|Δw_i| ×
 *   maxExecutionLossBps_i / 10000 with both sides of every move charged at
 *   the pool's own loss cap (a removed leg is charged at its own);
 * - a risk exit is a proposal that adds no pool and drops at least one held
 *   leg; it is exempt from INPUTS_INCOMPLETE because the broken pool is the
 *   one whose inputs go missing;
 * - `simulate: true` skips the reason rule only (nothing else differs, so a
 *   simulation that passes is a proposal that passes given a `why`).
 *
 * `session` is accepted for parity with the other verbs and journaling; no
 * proposal rule depends on it (the window applies to chat and cron alike:
 * it is about when `effectiveAt` lands, not who is present now).
 * @param {{ policy: object, targets: Array<{ poolId: string, weightBps: number }>, why?: string, snapshot: object, ledger: object, now: number, session?: 'cron' | 'chat', simulate?: boolean }} input
 * @returns {{ ok: true, summary: object, intent: object } | { ok: false, code: string, message: string, refusals: Array<{ code: string, message: string }>, summary: object }}
 *   summary = { turnoverBps, estimatedCostBps, legs: [{ poolId, symbol, fromBps, toBps, deltaBps, maxExecutionLossBps }], categories: { [name]: bps }, nextProposeAt }
 *   intent  = { targets: [{ poolId, weightBps }], why, turnoverBps, estimatedCostBps }
 */
export function evaluateProposal(input) {
  const { policy, targets, why, snapshot, ledger, simulate = false } = input;
  const nowSecs = toSecs(input.now);
  const refusals = [];
  const add = (code, message) => refusals.push({ code, message });
  const emptySummary = () => ({
    turnoverBps: null,
    estimatedCostBps: null,
    legs: [],
    categories: Object.fromEntries(Object.keys(policy.universe.categories).map((name) => [name, 0])),
    nextProposeAt: null,
  });
  const done = (summary, intent) => {
    if (refusals.length) return { ok: false, code: refusals[0].code, message: refusals[0].message, refusals, summary };
    return { ok: true, summary, intent };
  };

  const shape = validateTargets(targets);
  if (!shape.ok) return { ...shape, refusals: [{ code: shape.code, message: shape.message }], summary: emptySummary() };

  const pools = Array.isArray(snapshot?.pools) ? snapshot.pools : null;
  if (!pools) {
    add('INPUTS_INCOMPLETE', 'pool catalogue unavailable; nothing can be evaluated');
    return done(emptySummary());
  }
  const poolById = new Map(pools.filter((pool) => pool?.poolId).map((pool) => [pool.poolId, pool]));
  const { universe, shape: shp, turnover, cost, cadence, reason } = policy;
  const categoryOf = new Map();
  for (const [name, symbols] of Object.entries(universe.categories)) for (const s of symbols) categoryOf.set(s, name);

  // Universe — per target, in the caller's order.
  for (const { poolId } of targets) {
    const pool = poolById.get(poolId);
    if (!pool) {
      add('POOL_DENIED', `${poolId} is not in the catalogue`);
      continue;
    }
    const label = pool.symbol ?? poolId;
    if (!universe.chains.includes(pool.chain)) add('CHAIN_DENIED', `${label} is on ${pool.chain ?? 'an unknown chain'}; allowed: ${universe.chains.join(', ')}`);
    if (pool.status !== universe.requireStatus) add('POOL_NOT_ACTIVE', `${label} status is ${pool.status ?? 'unknown'}, not ${universe.requireStatus}`);
    if (!universe.allowlist.includes(pool.symbol)) add('POOL_DENIED', `${label} is not on the allowlist`);
    const tier = toNumber(pool.riskTier);
    if (tier == null) add('POOL_DENIED', `${label} riskTier unknown`);
    else if (tier > universe.maxRiskTier) add('POOL_DENIED', `${label} riskTier ${tier} exceeds ${universe.maxRiskTier}`);
    if (universe.requirePythFeedId && !pool.pythFeedId) add('POOL_DENIED', `${label} has no pythFeedId`);
    const loss = toNumber(pool.maxExecutionLossBps);
    if (loss == null) add('POOL_COST_TOO_HIGH', `${label} maxExecutionLossBps unknown`);
    else if (loss > universe.maxExecutionLossBps) add('POOL_COST_TOO_HIGH', `${label} maxExecutionLossBps ${loss} exceeds ${universe.maxExecutionLossBps}`);
  }

  // Shape.
  const held = heldLegs(snapshot?.portfolioRow);
  const legsKnown = held !== null;
  if (targets.length < shp.minLegs) add('MIN_LEGS', `${targets.length} legs, fewer than ${shp.minLegs}`);
  if (targets.length > shp.maxLegs) add('MAX_LEGS', `${targets.length} legs, more than ${shp.maxLegs}`);
  if (legsKnown) {
    const union = new Set([...held.map((leg) => leg.poolId), ...targets.map((t) => t.poolId)]);
    if (union.size > shp.pageLimit) add('PAGE_LIMIT', `held ∪ new is ${union.size} pools, more than the ${shp.pageLimit} one apply page holds`);
  } else {
    add('INPUTS_INCOMPLETE', 'portfolio holdings unavailable; page limit, turnover and cost cannot be evaluated');
  }
  const categoryBps = Object.fromEntries(Object.keys(universe.categories).map((name) => [name, 0]));
  let sum = 0;
  for (const { poolId, weightBps } of targets) {
    const pool = poolById.get(poolId);
    const label = pool?.symbol ?? poolId;
    sum += weightBps;
    const poolCap = toNumber(pool?.maxWeightBps);
    const cap = poolCap == null ? shp.maxLegWeightBps : Math.min(shp.maxLegWeightBps, poolCap);
    if (weightBps < shp.minLegWeightBps) add('LEG_WEIGHT_CAP', `${label} at ${weightBps} bps is under the ${shp.minLegWeightBps} bps leg minimum`);
    else if (weightBps > cap) add('LEG_WEIGHT_CAP', `${label} at ${weightBps} bps is over its ${cap} bps cap`);
    const category = pool ? categoryOf.get(pool.symbol) : undefined;
    if (category) categoryBps[category] += weightBps;
  }
  const stable = categoryBps[shp.stableCategory] ?? 0;
  if (stable < shp.stableMinBps) add('STABLE_BAND', `${shp.stableCategory} at ${stable} bps is under the ${shp.stableMinBps} bps floor`);
  else if (stable > shp.stableMaxBps) add('STABLE_BAND', `${shp.stableCategory} at ${stable} bps is over the ${shp.stableMaxBps} bps ceiling`);
  for (const [name, bps] of Object.entries(categoryBps)) {
    if (bps > shp.categoryMaxBps) add('CATEGORY_CAP', `${name} at ${bps} bps is over the ${shp.categoryMaxBps} bps category cap`);
  }
  if (sum !== shp.sumBps) add('WEIGHTS_SUM', `weights sum to ${sum} bps, not ${shp.sumBps}`);

  // Turnover and cost over held ∪ new (targets first, then removed legs).
  const legs = [];
  let turnoverBps = null;
  let estimatedCostBps = null;
  let newPools = [];
  let removed = [];
  if (legsKnown) {
    const heldById = new Map(held.map((leg) => [leg.poolId, leg]));
    const targetIds = new Set(targets.map((t) => t.poolId));
    newPools = targets.filter((t) => !heldById.has(t.poolId)).map((t) => t.poolId);
    removed = held.filter((leg) => !targetIds.has(leg.poolId) && leg.targetWeightBps > 0);
    let absDelta = 0;
    let costNumerator = 0;
    let lossKnown = true;
    const legOf = (poolId, fromBps, toBps, symbol) => {
      const pool = poolById.get(poolId);
      const loss = toNumber(pool?.maxExecutionLossBps);
      const deltaBps = toBps - fromBps;
      absDelta += Math.abs(deltaBps);
      if (loss == null) lossKnown = false;
      else costNumerator += Math.abs(deltaBps) * loss;
      legs.push({ poolId, symbol: pool?.symbol ?? symbol ?? null, fromBps, toBps, deltaBps, maxExecutionLossBps: loss });
    };
    for (const { poolId, weightBps } of targets) legOf(poolId, heldById.get(poolId)?.targetWeightBps ?? 0, weightBps, heldById.get(poolId)?.symbol);
    for (const leg of held) if (!targetIds.has(leg.poolId)) legOf(leg.poolId, leg.targetWeightBps, 0, leg.symbol);
    turnoverBps = absDelta / 2;
    if (turnoverBps > turnover.maxTurnoverBps) add('TURNOVER_CAP', `turnover ${turnoverBps} bps exceeds the ${turnover.maxTurnoverBps} bps cap`);
    if (lossKnown) {
      estimatedCostBps = costNumerator / 10_000;
      if (estimatedCostBps > cost.maxEstimatedCostBps) add('COST_CAP', `estimated cost ${estimatedCostBps.toFixed(2)} bps exceeds the ${cost.maxEstimatedCostBps} bps cap`);
    } else {
      add('COST_CAP', 'a leg has no maxExecutionLossBps; the cost cannot be bounded');
    }
  }

  // Cadence.
  const account = snapshot?.portfolioAccount;
  const lastRebalanceAt = toNumber(account?.lastRebalanceAt);
  let earliest = nowSecs;
  if (!isPlainObject(account)) {
    add('PROPOSAL_TOO_SOON', 'portfolio account unavailable; last_rebalance_at unknown');
  } else if (lastRebalanceAt == null) {
    add('PROPOSAL_TOO_SOON', 'last_rebalance_at unreadable');
  } else if (isSet(lastRebalanceAt)) {
    const since = nowSecs - lastRebalanceAt;
    earliest = Math.max(earliest, lastRebalanceAt + cadence.minSecsSinceLastRebalance);
    if (since < cadence.minSecsSinceLastRebalance) {
      add('PROPOSAL_TOO_SOON', `${since} s since last_rebalance_at, under the ${cadence.minSecsSinceLastRebalance} s cadence`);
    }
  }
  const recent = recentProposals(ledger, nowSecs, cadence.quotaWindowSecs);
  if (recent == null) {
    add('PROPOSAL_QUOTA', 'ledger unavailable; proposals in the quota window cannot be counted');
  } else if (recent.count >= cadence.maxProposalsPer30d) {
    add('PROPOSAL_QUOTA', `${recent.count} proposals in the last ${cadence.quotaWindowSecs} s reach the cap of ${cadence.maxProposalsPer30d}`);
    const expiresAt = recent.at.length >= cadence.maxProposalsPer30d
      ? recent.at[recent.at.length - cadence.maxProposalsPer30d] + cadence.quotaWindowSecs
      : nowSecs + cadence.quotaWindowSecs;
    earliest = Math.max(earliest, expiresAt);
  }
  const rowPending = snapshot?.portfolioRow?.pendingTargets;
  const chainPending = account?.pendingTargets;
  if (rowPending || chainPending) {
    const effectiveAt = rowPending?.effectiveAt ?? toNumber(chainPending?.effectiveAt);
    add('TARGETS_PENDING', `a change is already pending (effective ${effectiveAt ?? 'unknown'}); apply or cancel it first`);
  }
  if (cadence.requireInputsComplete) {
    const riskExit = cadence.riskExitExemptFromInputs && legsKnown && newPools.length === 0 && removed.length > 0;
    if (!riskExit) {
      for (const { poolId } of targets) {
        const pool = poolById.get(poolId);
        if (!pool) continue; // already POOL_DENIED
        const missing = ['trailingYieldBps', 'tvlUsdc', 'riskTier'].filter((key) => toNumber(pool[key]) == null);
        if (missing.length) add('INPUTS_INCOMPLETE', `${pool.symbol ?? poolId} is missing ${missing.join(', ')}`);
      }
    }
  }
  const window = cadence.proposeWindowUtc;
  if (!insideWindow(nowSecs, window)) {
    const hh = (h) => `${String(h).padStart(2, '0')}:00`;
    add('OUTSIDE_WINDOW', `proposals are accepted ${hh(window.fromHour)}–${hh(window.toHour)} UTC only`);
  }

  // Reason.
  if (reason.required && !simulate) {
    if (typeof why !== 'string' || why.trim() === '') add('WHY_REQUIRED', 'a non-empty `why` is required');
    else if (why.length > reason.maxChars) add('WHY_REQUIRED', `why is ${why.length} chars, over the ${reason.maxChars} cap`);
  }

  const summary = {
    turnoverBps,
    estimatedCostBps,
    legs,
    categories: categoryBps,
    nextProposeAt: nextInsideWindow(earliest, window),
  };
  const intent = {
    targets: targets.map(({ poolId, weightBps }) => ({ poolId, weightBps })),
    why: typeof why === 'string' ? why : null,
    turnoverBps,
    estimatedCostBps,
  };
  return done(summary, intent);
}

// ---------------------------------------------------------------------------
// evaluateDeposit / evaluateWithdraw.
// ---------------------------------------------------------------------------

/** `{ amountBase, amountUsd }` or a BAD_REQUEST refusal; USD is six-decimal USDC base units. */
function parseAmount(amountUsd) {
  const usd = toNumber(amountUsd);
  if (usd == null || usd <= 0) return refuse('BAD_REQUEST', 'amountUsd must be a positive number');
  return { ok: true, usd, base: BigInt(Math.round(usd * 1_000_000)) };
}

/** Fee-and-tolerance floor: `gross × (10000 − feeBps − MIN_OUT_TOLERANCE_BPS) / 10000`. */
const floorAfter = (gross, feeBps) => (gross * BigInt(10_000 - feeBps - MIN_OUT_TOLERANCE_BPS)) / 10_000n;

/** The vault's share price as a positive bigint, or a BOOK_NOT_FRESH refusal — a zero price is a book that cannot be valued. */
function vaultPrice(vault) {
  const price = toBigInt(vault?.price);
  if (price == null || price <= 0n) return refuse('BOOK_NOT_FRESH', 'vault price unknown or zero');
  return { ok: true, price };
}

/**
 * Deposit rules, in order: DEPOSIT_DAILY_CAP (UTC day; the launch-day cap
 * when `policy.deposit.launchDay` is today), BOOK_NOT_FRESH
 * (`portfolioRow.priceState !== 'fresh'`, or no readable price), CAP_HEADROOM
 * (the deposit's shares against `max_total_shares − total_shares` and
 * `max_shares_per_user − signer shares`, and its base units against
 * `max_total_idle − total_idle`, all from `vaultAccount` — never the REST
 * row). `minShares` is the gross share count less the vault deposit fee and
 * `MIN_OUT_TOLERANCE_BPS`; the vault fee is read from `vaultAccount.depositFeeBps`
 * and taken as 0 when absent, which only makes the floor stricter.
 * @param {{ policy: object, amountUsd: number, snapshot: object, ledger: object, now: number }} input
 * @returns {{ ok: true, summary: { amountBaseUnits: string, minShares: string, headroomBaseUnits: string } } | { ok: false, code: string, message: string }}
 */
export function evaluateDeposit(input) {
  const { policy, snapshot, ledger } = input;
  const nowSecs = toSecs(input.now);
  const amount = parseAmount(input.amountUsd);
  if (!amount.ok) return amount;

  const today = utcDay(nowSecs);
  const cap = policy.deposit.launchDay === today ? policy.deposit.launchDayCapUsd : policy.deposit.dailyCapUsd;
  const soFar = isPlainObject(ledger) ? toNumber(ledger.depositsTodayUsd) : null;
  if (soFar == null) return refuse('DEPOSIT_DAILY_CAP', 'ledger unavailable; today\'s deposits cannot be summed');
  if (soFar + amount.usd > cap) {
    return refuse('DEPOSIT_DAILY_CAP', `$${amount.usd} on top of $${soFar} today exceeds the $${cap} daily cap`);
  }

  const priceState = snapshot?.portfolioRow?.priceState ?? null;
  if (policy.deposit.requireBookFresh && priceState !== 'fresh') {
    return refuse('BOOK_NOT_FRESH', `book priceState is ${priceState ?? 'unknown'}, not fresh`);
  }
  const vault = snapshot?.vaultAccount;
  if (!isPlainObject(vault)) return refuse('CAP_HEADROOM', 'vault account unavailable; caps unknown');
  const priced = vaultPrice(vault);
  if (!priced.ok) return priced;
  const { price } = priced;

  const fields = {};
  for (const key of ['maxTotalShares', 'totalShares', 'maxSharesPerUser', 'maxTotalIdle', 'totalIdle']) {
    fields[key] = toBigInt(vault[key]);
    if (fields[key] == null) return refuse('CAP_HEADROOM', `vault ${key} unreadable`);
  }
  const signerShares = toBigInt(snapshot?.signer?.shares);
  if (signerShares == null) return refuse('CAP_HEADROOM', 'signer share balance unknown; the per-user cap cannot be checked');

  const grossShares = (amount.base * BASE_UNITS) / price;
  const sharesHeadroom = bigMin(fields.maxTotalShares - fields.totalShares, fields.maxSharesPerUser - signerShares);
  const idleHeadroom = fields.maxTotalIdle - fields.totalIdle;
  const headroomBase = bigMin((sharesHeadroom > 0n ? sharesHeadroom : 0n) * price / BASE_UNITS, idleHeadroom > 0n ? idleHeadroom : 0n);
  if (grossShares > sharesHeadroom || amount.base > idleHeadroom) {
    return refuse('CAP_HEADROOM', `${amount.base} base units exceed the vault headroom of ${headroomBase} (shares ${sharesHeadroom}, idle ${idleHeadroom})`);
  }
  const feeBps = toNumber(vault.depositFeeBps) ?? 0;
  return {
    ok: true,
    summary: {
      amountBaseUnits: amount.base.toString(),
      minShares: floorAfter(grossShares, feeBps).toString(),
      headroomBaseUnits: headroomBase.toString(),
    },
  };
}

/**
 * Withdraw rules, in order: WITHDRAW_CRON_BLOCKED (chat sessions only when
 * `policy.withdraw.chatOnly`), WITHDRAW_DAILY_CAP (UTC day), BOOK_NOT_FRESH,
 * and INSUFFICIENT_SHARES when the signer's own balance (the only source —
 * the verb sends to the signer's ATA) is unknown or short. `shares` is the
 * USD amount at the vault price, rounded down; `minAmountOut` is the amount
 * less the vault withdraw fee and `MIN_OUT_TOLERANCE_BPS`.
 * @param {{ policy: object, amountUsd: number, session: 'cron' | 'chat', snapshot: object, ledger: object, now: number }} input
 * @returns {{ ok: true, summary: { shares: string, minAmountOut: string } } | { ok: false, code: string, message: string }}
 */
export function evaluateWithdraw(input) {
  const { policy, session, snapshot, ledger } = input;
  toSecs(input.now); // same contract as the other verbs: a missing clock is a caller bug, not a pass
  if (policy.withdraw.chatOnly && session !== 'chat') {
    return refuse('WITHDRAW_CRON_BLOCKED', `withdraw is allowed in chat sessions only (session: ${session ?? 'cron'})`);
  }
  const amount = parseAmount(input.amountUsd);
  if (!amount.ok) return amount;
  const soFar = isPlainObject(ledger) ? toNumber(ledger.withdrawalsTodayUsd) : null;
  if (soFar == null) return refuse('WITHDRAW_DAILY_CAP', 'ledger unavailable; today\'s withdrawals cannot be summed');
  const cap = policy.withdraw.dailyCapUsd;
  if (soFar + amount.usd > cap) {
    return refuse('WITHDRAW_DAILY_CAP', `$${amount.usd} on top of $${soFar} today exceeds the $${cap} daily cap`);
  }
  const priceState = snapshot?.portfolioRow?.priceState ?? null;
  if (priceState !== 'fresh') return refuse('BOOK_NOT_FRESH', `book priceState is ${priceState ?? 'unknown'}, not fresh`);
  const vault = snapshot?.vaultAccount;
  if (!isPlainObject(vault)) return refuse('BOOK_NOT_FRESH', 'vault account unavailable; price unknown');
  const priced = vaultPrice(vault);
  if (!priced.ok) return priced;
  const shares = (amount.base * BASE_UNITS) / priced.price;
  const held = toBigInt(snapshot?.signer?.shares);
  if (held == null) return refuse('INSUFFICIENT_SHARES', 'signer share balance unknown');
  if (shares > held) return refuse('INSUFFICIENT_SHARES', `${shares} shares needed, signer holds ${held}`);
  if (shares <= 0n) return refuse('BAD_REQUEST', 'amountUsd is below one share at the current price');
  const feeBps = toNumber(vault.withdrawFeeBps) ?? 0;
  return {
    ok: true,
    summary: { shares: shares.toString(), minAmountOut: floorAfter(amount.base, feeBps).toString() },
  };
}

// ---------------------------------------------------------------------------
// evaluateInvariants: the every-tick checks, as a pure function of chain facts.
// ---------------------------------------------------------------------------

/**
 * The invariants the loop checks every tick (plan §4.4 last row), as pure
 * data so `preflight.checkInvariants` and the ops twin script can share one
 * definition: `curator == expectedCurator`, `pendingCurator == None`,
 * `rebalanceDelaySecs == policy.invariants.rebalanceDelaySecs`,
 * `recipient1 == treasury`, `guardian == expected`, `compositionLocked ==
 * policy.invariants.compositionLocked`. An unreadable value is drift
 * (`actual: 'unknown'`), except `pendingCurator`, whose `null` is the
 * expected None.
 * @param {{ policy: object, chain: { curator, pendingCurator, rebalanceDelaySecs, recipient1, guardian, compositionLocked }, config: { expectedCurator: string, treasury: string, guardian: string } }} input
 * @returns {{ ok: true, drift: [] } | { ok: false, code: 'INVARIANT_DRIFT', message: string, drift: Array<{ invariant: string, expected: string, actual: string }> }}
 */
export function evaluateInvariants({ policy, chain, config }) {
  const drift = [];
  const facts = isPlainObject(chain) ? chain : {};
  const expectPubkey = (invariant, actual, expected) => {
    const have = toBase58(actual) ?? 'unknown';
    const want = toBase58(expected) ?? 'unconfigured';
    if (have !== want) drift.push({ invariant, expected: want, actual: have });
  };
  expectPubkey('portfolio.curator', facts.curator, config?.expectedCurator);
  if (policy.invariants.pendingCuratorMustBeNone && facts.pendingCurator != null) {
    drift.push({ invariant: 'portfolio.pending_curator', expected: 'none', actual: toBase58(facts.pendingCurator) ?? 'set' });
  }
  const delay = toNumber(facts.rebalanceDelaySecs);
  if (delay !== policy.invariants.rebalanceDelaySecs) {
    drift.push({ invariant: 'portfolio.rebalance_delay_secs', expected: String(policy.invariants.rebalanceDelaySecs), actual: delay == null ? 'unknown' : String(delay) });
  }
  expectPubkey('accountant.recipient1', facts.recipient1, config?.treasury);
  expectPubkey('factory.guardian', facts.guardian, config?.guardian);
  const locked = typeof facts.compositionLocked === 'boolean' ? facts.compositionLocked : null;
  if (locked !== policy.invariants.compositionLocked) {
    drift.push({ invariant: 'portfolio.composition_locked', expected: String(policy.invariants.compositionLocked), actual: locked == null ? 'unknown' : String(locked) });
  }
  if (!drift.length) return { ok: true, drift };
  const names = drift.map((d) => d.invariant).join(', ');
  return { ok: false, code: 'INVARIANT_DRIFT', message: `invariant drift: ${names}`, drift };
}
