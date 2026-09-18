/**
 * One function per verb. A write verb is one straight line, never
 * reordered: verbAllowed → evaluateWrite → the verb's own policy or gates →
 * REST build → verifyBuilt → sign → send → journal. The write attempt is
 * counted in the ledger before the build so a build that keeps failing still
 * hits RATE_LIMITED. Every function takes `(ctx, args, meta)` and throws a
 * `Refusal`; the server turns that into `{ error: { code, message } }`.
 *
 * `meta` is `{ session: 'cron' | 'chat', caller: string, tokenKind: 'agent' | 'ops' }`.
 *
 * Why the verbs hard-check SELF_LOCKED, PAUSED, WITHDRAW_CRON_BLOCKED and
 * PORTFOLIO_NOT_ALLOWED themselves before asking the policy engine: the
 * engine is data-driven (a rendered JSON document) and injectable for tests;
 * the four rules that bound the damage of a hostile model must hold even
 * when the policy document lost a line or the engine is a fake. The engine
 * still runs afterwards and may refuse for its own reasons.
 *
 * Why `ctx.deps`: policy, decode, preflight and metrics are imported here,
 * but a test hands in fakes through `ctx.deps` so a refusal can be planted
 * without a network and the order of calls (never sign before verify, never
 * send before sign) can be asserted on the real pipeline.
 *
 * Why the journal names the verb in camelCase (`refreshNav`, not
 * `refresh-nav`): `journal.js LEDGER_WRITE_VERBS` counts attempts by that
 * form, and the ledger is rebuilt from the file at boot — a route-name record
 * would make a restart forget the hour's attempts. The route name is kept in
 * `route` for readers.
 *
 * Why `verifyBuilt`'s `expect` is assembled from the snapshot (`expectFor`)
 * and never from config alone: the decoder compares the Portfolio PDA, the
 * VaultConfig key and the Pool keys the built instructions carry, and the
 * api row is the only place those live (`portfolio`, `vaultKey`,
 * `pools[].addresses.pool`). The configured mint is the shares mint, which
 * no instruction names — handing it to the decoder as the portfolio refuses
 * every write as WRONG_PORTFOLIO. A row without the keys, or a targeted pool
 * without one, refuses before the build: an intent the decoder cannot pin to
 * accounts is not an intent. The same goes for the verb's fixed arguments
 * (`spec.intent`: amounts, shares, the nominee, the delay, the uri) — an
 * argument the decoder is not told is an argument it does not check.
 *
 * Why PAUSED lets cancel and the ops-token verbs through while SELF_LOCKED
 * refuses everything: pause is kill-ladder step 1, and step 5 (the curator
 * rotation) must not need a `resume` that re-arms the agent mid-incident
 * (policy.js evaluateWrite says the same). A self-lock says the chain no
 * longer matches what this process believes, and only an operator unlock,
 * after the drift is gone, may end it. Invariants the loop could not verify
 * (an accountant or FactoryConfig read failed) hold writes the same way a
 * pause does — unknown is never fine — and lift on their own once the reads
 * succeed.
 */
import { PublicKey } from '@solana/web3.js';
import { Refusal, REFUSAL_STATUS, nameProgramError as realNameProgramError } from './errors.js';
import * as policyMod from './policy.js';
import * as decodeMod from './decode.js';
import * as preflightMod from './preflight.js';
import * as metricsMod from './metrics.js';
import { canonicalSha256 } from './journal.js';

/** An alert key that stays raised is delivered again after this long. */
export const REALERT_SECS = 6 * 3600;
export const NOTE_MAX_CHARS = 2048;
/** `deriveReview` truncates the trigger detail at 200; refuse rather than silently cut. */
export const OPERATOR_REQUEST_MAX_CHARS = 200;
export const JOURNAL_DEFAULT_N = 50;
export const JOURNAL_MAX_N = 500;
export const CALLER_MAX_CHARS = 64;
export const METADATA_URI_MAX_CHARS = 128;

/** Route name → journal verb name (camelCase, what `journal.js` counts). */
export const JOURNAL_VERB = Object.freeze({
  'refresh-nav': 'refreshNav',
  'rotate-curator': 'rotateCurator',
  'set-delay': 'setDelay',
  'set-metadata': 'setMetadata',
  'hermes-heartbeat': 'hermesHeartbeat',
});
const journalVerb = (route) => JOURNAL_VERB[route] ?? route;

/** Which program a verb's instructions live on, so a send error is named against the right enum. */
const PROGRAM_OF_VERB = Object.freeze({
  propose: 'portfolio_factory',
  apply: 'portfolio_factory',
  cancel: 'portfolio_factory',
  'rotate-curator': 'portfolio_factory',
  'set-delay': 'portfolio_factory',
  'set-metadata': 'portfolio_factory',
  deposit: 'stoken',
  withdraw: 'stoken',
});

/** The api's MCP presenter appends a "build it again" fix; it is dropped, never acted on. */
const FIX_SENTENCE = /\s*(?:Build it again|Rebuild it)[^.]*\.?\s*$/i;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const HOUR_SECS = 3600;

const REAL_DEPS = Object.freeze({
  verbAllowed: policyMod.verbAllowed,
  evaluateWrite: policyMod.evaluateWrite,
  evaluateProposal: policyMod.evaluateProposal,
  evaluateDeposit: policyMod.evaluateDeposit,
  evaluateWithdraw: policyMod.evaluateWithdraw,
  verifyBuilt: decodeMod.verifyBuilt,
  readSnapshot: preflightMod.readSnapshot,
  applyGates: preflightMod.applyGates,
  proposeGates: preflightMod.proposeGates,
  checkInvariants: preflightMod.checkInvariants,
  deriveReview: metricsMod.deriveReview,
  renderPrometheus: metricsMod.renderPrometheus,
  nameProgramError: realNameProgramError,
});

/** The pure modules, with `ctx.deps` overriding any of them (tests plant fakes here). */
export function depsOf(ctx) {
  return { ...REAL_DEPS, ...(ctx?.deps ?? {}) };
}

/** README §4.3, empty. */
export function emptyLedger() {
  return {
    lastProposalAt: null,
    proposalsLast30d: 0,
    proposals: [],
    depositsTodayUsd: 0,
    withdrawalsTodayUsd: 0,
    writeAttempts: [],
    writeAttemptsLastHour: 0,
    paused: false,
    selfLocked: null,
    operatorRequest: null,
    applied: [],
    reviewState: null,
    lastDepositAt: null,
  };
}

/** The apply machine at rest. */
export function initialApplyState() {
  return {
    state: 'IDLE',
    deploymentId: null,
    effectiveAt: null,
    targets: null,
    proposedAt: null,
    attempts: 0,
    since: null,
    lastBlocker: null,
    escalatedAt: null,
    sendFailures: 0,
    refreshNavSent: false,
    custodyRetries: 0,
    lastSentAt: null,
    signatures: [],
  };
}

/** README §4.1 `ctx.state`, fresh. `reviewState` is the journal's last review record (`ledger.reviewState`), replayed at boot. */
export function initialState({ paused = false, selfLocked = null, operatorRequest = null, reviewState = null, ledger = emptyLedger() } = {}) {
  return {
    paused: Boolean(paused),
    selfLocked: selfLocked ?? null,
    operatorRequest: operatorRequest ?? null,
    reviewState: reviewState ?? null,
    invariantsUnverified: null,
    apply: initialApplyState(),
    ledger,
    alerts: new Map(),
    alertsSince: null,
    hermesHeartbeatAt: null,
    lastTick: { at: null, ok: null, error: null },
    lastSnapshot: null,
    ledgerFromJournal: false,
  };
}

/** Text that may reach a response, the journal or stdout: URLs replaced, length bounded. */
export function scrubText(text, max = 500) {
  return String(text ?? '').replace(URL_RE, '<url>').slice(0, max);
}

/** Digest per loaded policy object, so a ctx whose policy is swapped (a test variant) is never served a stale one. */
const POLICY_DIGESTS = new WeakMap();

/**
 * sha256 hex of the canonical JSON of `ctx.policy`, the document as loaded
 * (comments already stripped by `loadPolicy`). Computed once per policy
 * object and remembered on `ctx.policyDigest`; `index.js` calls this at boot
 * so the boot record and the log line carry it, and a ctx built without
 * `index.js` (a test's fakeCtx) gets it on first use. The digest is what an
 * agent quotes back so an operator can tell which policy a decision was made
 * under; the document itself is served by GET /policy.
 * @param {object} ctx
 * @returns {string}
 */
export function policyDigestOf(ctx) {
  const policy = ctx?.policy ?? null;
  const keyed = policy !== null && typeof policy === 'object';
  let digest = keyed ? POLICY_DIGESTS.get(policy) : undefined;
  if (!digest) {
    digest = canonicalSha256(policy);
    if (keyed) POLICY_DIGESTS.set(policy, digest);
  }
  if (ctx && typeof ctx === 'object') {
    try { ctx.policyDigest = digest; } catch { /* a frozen ctx keeps the WeakMap copy */ }
  }
  return digest;
}

/** PublicKey → base58, BN/bigint → decimal string, Anchor enum `{ active: {} }` → 'active', scalars as they are. */
export function plain(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (typeof value.toNumber === 'function' && typeof value.toString === 'function') return value.toString();
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && value[keys[0]] && typeof value[keys[0]] === 'object' && Object.keys(value[keys[0]]).length === 0) return keys[0];
  }
  return value;
}

/** A number out of a BN, a bigint, a string or a number; null when it is none of those. */
export function num(value) {
  const p = plain(value);
  if (p == null || typeof p === 'boolean' || typeof p === 'object') return null;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

const nowSecsOf = (ctx) => Math.floor(ctx.now() / 1000);

/** `meta` as the verbs rely on it: anything but 'chat' is cron, anything but 'ops' is agent. */
export function normMeta(meta) {
  return {
    session: meta?.session === 'chat' ? 'chat' : 'cron',
    caller: String(meta?.caller ?? 'unknown').slice(0, CALLER_MAX_CHARS) || 'unknown',
    tokenKind: meta?.tokenKind === 'ops' ? 'ops' : 'agent',
  };
}

/** Write attempts in the trailing hour, from the ledger's list. */
export function writeAttemptsLastHour(ledger, nowSecs) {
  return (ledger?.writeAttempts ?? []).filter((t) => t > nowSecs - HOUR_SECS && t <= nowSecs).length;
}

// ------------------------------------------------------------------ journal

function journalAppend(ctx, record) {
  try {
    const written = ctx.journal.append(record);
    refreshLedger(ctx);
    return written;
  } catch (error) {
    ctx.log?.('error', 'journal-append-failed', { kind: record.kind, error: scrubText(error?.message) });
    return null;
  }
}

/**
 * The ledger is the journal's view; rebuild it after every append so a cap
 * moves with the file. Returns true when the ledger now comes from the file
 * — the verbs then skip their own in-memory bookkeeping, which would count
 * the same record twice.
 */
function refreshLedger(ctx) {
  if (typeof ctx.journal?.rebuildLedger !== 'function') return false;
  try {
    ctx.state.ledger = ctx.journal.rebuildLedger({ now: nowSecsOf(ctx) });
    ctx.state.ledgerFromJournal = true;
    return true;
  } catch (error) {
    ctx.log?.('warn', 'ledger-rebuild-failed', { error: scrubText(error?.message) });
    return false;
  }
}

/** In-memory ledger bookkeeping, only when the journal is not the source of truth (a journal without rebuildLedger). */
function bumpLedger(ctx, fn) {
  if (ctx.state.ledgerFromJournal) return;
  fn(ctx.state.ledger);
}

// ------------------------------------------------------------------- alerts

/**
 * Raise (or re-raise after REALERT_SECS) an alert. Returns true when the
 * next GET /alerts will carry it — a key already delivered and still raised
 * is silent until it clears or 6 h pass.
 */
export function raiseAlert(ctx, key, code, message) {
  const now = nowSecsOf(ctx);
  const alerts = ctx.state.alerts;
  const existing = alerts.get(key);
  const text = scrubText(message, 300);
  if (existing && !existing.resolvedAt) {
    if (now - existing.lastAlertedAt < REALERT_SECS) {
      existing.message = text;
      return false;
    }
    existing.lastAlertedAt = now;
    existing.delivered = false;
    existing.message = text;
    existing.count += 1;
    journalAppend(ctx, { kind: 'alert', key, code, message: text, state: 're-raised' });
    return true;
  }
  alerts.set(key, { key, code, at: now, lastAlertedAt: now, message: text, delivered: false, resolvedAt: null, count: 1 });
  journalAppend(ctx, { kind: 'alert', key, code, message: text, state: 'raised' });
  return true;
}

/** Mark an alert resolved: delivered once as a `resolved:` line, or dropped silently if it was never delivered. */
export function clearAlert(ctx, key) {
  const alerts = ctx.state.alerts;
  const existing = alerts.get(key);
  if (!existing || existing.resolvedAt) return false;
  if (!existing.delivered) {
    alerts.delete(key);
    return false;
  }
  existing.resolvedAt = nowSecsOf(ctx);
  existing.delivered = false;
  journalAppend(ctx, { kind: 'alert', key, code: existing.code, message: existing.message, state: 'resolved' });
  return true;
}

/** Every `apply:*` alert, cleared when the machine is back at rest. */
export function clearApplyAlerts(ctx) {
  for (const key of [...ctx.state.alerts.keys()]) if (key.startsWith('apply:')) clearAlert(ctx, key);
}

// ---------------------------------------------------------------- snapshots

/** RFC 3339 (the api row), or unix seconds as a number, numeric string, BN or bigint → unix seconds; null when unreadable. */
export function secsOf(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    if (/[^0-9]/.test(text)) {
      const ms = Date.parse(text);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
  }
  return num(value);
}

/**
 * `{ effectiveAt, proposedAt, targets }` for the pending change on chain, or
 * null. Timing comes from the Portfolio account's `pending_targets` header
 * (BN seconds — the truth) when it is readable, else from the api row, whose
 * `effectiveAt`/`proposedAt` are RFC 3339 (`catalogue.js rfc3339()`): a
 * `Number()` of those is NaN, and a machine armed with `effectiveAt: null`
 * parks in ARMED forever. The target set is the row's; the header carries
 * timestamps only. Unix seconds.
 */
export function pendingOf(snapshot) {
  const row = snapshot?.portfolioRow?.pendingTargets;
  const rowPending = row && typeof row === 'object' ? row : null;
  const header = snapshot?.portfolioAccount?.pendingTargets;
  const fromHeader = header && typeof header === 'object'
    ? { effectiveAt: num(header.effectiveAt), proposedAt: num(header.proposedAt) }
    : { effectiveAt: null, proposedAt: null };
  const headerKnown = fromHeader.effectiveAt != null || fromHeader.proposedAt != null;
  if (!rowPending && !headerKnown) return null;
  const targets = Array.isArray(rowPending?.targets)
    ? rowPending.targets.map((t) => ({ poolId: String(t.poolId), weightBps: Number(t.weightBps) }))
    : null;
  return {
    effectiveAt: fromHeader.effectiveAt ?? secsOf(rowPending?.effectiveAt),
    proposedAt: fromHeader.proposedAt ?? secsOf(rowPending?.proposedAt),
    targets,
  };
}

/** The targets pending on chain, or null. */
export function pendingTargetsOf(snapshot) {
  return pendingOf(snapshot)?.targets ?? null;
}

/** The current target weights per held leg, from the REST row's holdings; null when unknown. */
export function currentTargetsOf(snapshot) {
  const legs = snapshot?.portfolioRow?.holdings?.legs;
  if (!Array.isArray(legs)) return null;
  return legs.map((leg) => ({ poolId: String(leg.poolId), weightBps: Number(leg.targetWeightBps ?? 0) }));
}

/** Two target sets are equal when every non-zero weight matches by poolId, order ignored. */
export function targetsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const map = (list) => {
    const out = new Map();
    for (const t of list) if (Number(t.weightBps) > 0) out.set(String(t.poolId), Number(t.weightBps));
    return out;
  };
  const ma = map(a);
  const mb = map(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

/** `keeper.ok` out of the api's /health json, whatever shape it has; null when unknown. */
export function keeperOkOf(health) {
  const keeper = health?.keeper ?? health?.services?.keeper ?? null;
  if (!keeper || typeof keeper !== 'object') return null;
  if (typeof keeper.ok === 'boolean') return keeper.ok;
  if (typeof keeper.status === 'string') return keeper.status === 'ok';
  return null;
}

async function readSnapshot(ctx) {
  const snapshot = await depsOf(ctx).readSnapshot(ctx);
  ctx.state.lastSnapshot = snapshot;
  return snapshot;
}

async function snapshotOrLast(ctx) {
  try {
    return { snapshot: await readSnapshot(ctx), error: null };
  } catch (error) {
    return { snapshot: ctx.state.lastSnapshot ?? null, error: scrubText(error?.message ?? String(error)) };
  }
}

// --------------------------------------------------------------- arguments

const bad = (message) => new Refusal('BAD_REQUEST', message);

function parseTargets(value) {
  if (!Array.isArray(value) || value.length === 0) throw bad('targets must be a non-empty array of { poolId, weightBps }');
  return value.map((t, i) => {
    if (!t || typeof t !== 'object') throw bad(`targets[${i}] must be an object`);
    if (typeof t.poolId !== 'string' || t.poolId.trim() === '') throw bad(`targets[${i}].poolId must be a string`);
    if (!Number.isInteger(t.weightBps) || t.weightBps < 0 || t.weightBps > 10000) throw bad(`targets[${i}].weightBps must be an integer 0..10000`);
    return { poolId: t.poolId, weightBps: t.weightBps };
  });
}

function parseAmountUsd(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw bad('amountUsd must be a positive number');
  return n;
}

function parsePubkey(value, name) {
  if (typeof value !== 'string') throw bad(`${name} must be a base58 public key`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw bad(`${name} must be a base58 public key`);
  }
}

const whyOf = (args) => (typeof args?.why === 'string' ? args.why.trim() : '');

/** `why` non-empty and within `policy.reason.maxChars` when the policy requires a reason. */
function requireWhy(ctx, why, refuse) {
  const rule = ctx.policy?.reason ?? { required: true, maxChars: 500 };
  if (rule.required !== false && why === '') refuse('WHY_REQUIRED', 'why is required: one sentence on the reason for this action');
  if (rule.maxChars && why.length > rule.maxChars) refuse('WHY_REQUIRED', `why must be at most ${rule.maxChars} characters`);
}

const withStatus = (body, httpStatus) => Object.assign(body, { httpStatus });

/** A base58 string out of a string or a PublicKey; null for anything else (an empty string included). */
const base58Of = (value) => {
  const p = plain(value);
  return typeof p === 'string' && p !== '' ? p : null;
};

/**
 * `verifyBuilt`'s `expect` for one write, from the snapshot the policy just
 * saw. The Portfolio PDA and the VaultConfig key are the row's (`portfolio`,
 * `vaultKey`); the Pool keys are `pools[].addresses.pool` by poolId (what
 * `GET /v1/pools` carries); `intent` is the verb's fixed arguments —
 * `targets` for propose (the only verb whose instruction carries the set),
 * amounts, the nominee, the delay, the uri. Throws UPSTREAM when the row
 * cannot name the accounts and INPUTS_INCOMPLETE when an intent target has
 * no key — either way nothing is built. `lookupTables` is read from
 * `ctx.chain` at verify time, not here, so a refresh between two verifies
 * is seen.
 * @param {object} ctx
 * @param {{ snapshot: object, intent?: { targets?: Array<{ poolId: string, weightBps: number }>, [arg: string]: unknown } }} input
 * @returns {object} the decoder's `expect`
 * @throws {Refusal} UPSTREAM, INPUTS_INCOMPLETE
 */
export function expectFor(ctx, { snapshot, intent = {} }) {
  const { targets } = intent;
  const row = snapshot?.portfolioRow;
  const portfolio = base58Of(row?.portfolio);
  const vault = base58Of(row?.vaultKey);
  if (!portfolio || !vault) {
    throw new Refusal('UPSTREAM', 'the portfolio row is unavailable or carries no portfolio/vaultKey; the built accounts cannot be checked');
  }
  const poolKeys = {};
  for (const pool of Array.isArray(snapshot?.pools) ? snapshot.pools : []) {
    const key = base58Of(pool?.addresses?.pool);
    if (pool?.poolId && key) poolKeys[String(pool.poolId)] = key;
  }
  if (Array.isArray(targets)) {
    const missing = targets.map((t) => String(t.poolId)).filter((poolId) => !poolKeys[poolId]);
    if (missing.length) {
      throw new Refusal('INPUTS_INCOMPLETE', `no Pool key in the catalogue for ${missing.join(', ')}; the built targets cannot be verified`, { missing });
    }
  }
  return {
    payer: ctx.signer.wallet,
    portfolio,
    vault,
    poolKeys,
    ...intent,
    allowedPrograms: ctx.chain.programs,
    lookupTables: ctx.chain.lookupTables,
    idls: ctx.chain.idls,
  };
}

/** A decode refusal that a fresher copy of the NAV lookup table could turn into a resolved account. */
const isLookupMiss = (verdict) => (verdict?.code === 'UNKNOWN_INSTRUCTION' || verdict?.code === 'FOREIGN_LOOKUP_TABLE')
  && /lookup table/i.test(String(verdict?.message ?? ''));

// ------------------------------------------------------------ write pipeline

/**
 * The one write pipeline. `spec`:
 *   args      journal-safe args (targets, amountUsd, why, …)
 *   snapshot  a snapshot already read this tick (the loop passes its own)
 *   precheck  ({ snapshot, deps, now, nowSecs, refuse }) → { targets?, …, stop? }; `stop` answers without building
 *   intent    ({ pre, snapshot }) → the verb's fixed arguments for the decoder (amount/minShares, shares/minAmountOut, newCurator, rebalanceDelaySecs, uri)
 *   build     ({ snapshot, pre }) → the api's build response
 *   record    ({ payload, sent, pre, snapshot }) → extra journal fields
 *   after     ({ payload, sent, pre, snapshot, nowSecs, record }) → side effects on ctx.state
 *   result    ({ payload, sent, pre, snapshot, record, transactions }) → the HTTP body
 */
async function runWrite(ctx, meta, verb, spec) {
  const deps = depsOf(ctx);
  const now = ctx.now();
  const nowSecs = Math.floor(now / 1000);
  const base = {
    verb: journalVerb(verb),
    route: verb,
    caller: meta.caller,
    session: meta.session,
    tokenKind: meta.tokenKind,
    args: spec.args ?? {},
  };
  // Counted first: the journal counts every attempt at a write verb, refused or not.
  ctx.state.ledger.writeAttempts.push(nowSecs);

  const refuse = (code, message, detail) => {
    const written = journalAppend(ctx, { kind: 'refusal', ...base, ok: false, code, message: scrubText(message), ...(detail !== undefined ? { detail } : {}) });
    const error = new Refusal(code, scrubText(message), detail);
    error.journaled = true;
    error.journalId = written?.id ?? null;
    throw error;
  };

  // 1. Who may call this verb, and the four hard rules.
  if (spec.args?.mint !== undefined && spec.args.mint !== ctx.config.mint) {
    refuse('PORTFOLIO_NOT_ALLOWED', 'this signer acts on one portfolio only');
  }
  const allowed = deps.verbAllowed(ctx.policy, verb, { session: meta.session, tokenKind: meta.tokenKind });
  if (!allowed?.ok) refuse(allowed?.code ?? 'VERB_DENIED', allowed?.message ?? `${verb} is not allowed`);
  if (verb === 'withdraw' && meta.session !== 'chat') refuse('WITHDRAW_CRON_BLOCKED', 'withdraw is allowed in chat sessions only');
  if (ctx.state.selfLocked) {
    refuse('SELF_LOCKED', `self-locked since ${ctx.state.selfLocked.at}: ${ctx.state.selfLocked.reason}; POST /unlock (ops) once the drift is fixed`, {
      at: ctx.state.selfLocked.at, reason: ctx.state.selfLocked.reason,
    });
  }
  // The ops-token verbs pass a pause (kill-ladder step 5 must not need a resume); an ops verb reached with the agent token is not one.
  const opsVerb = OPS_VERBS.has(verb) && meta.tokenKind === 'ops';
  if (ctx.state.paused && verb !== 'cancel' && !opsVerb) {
    refuse('PAUSED', 'the signer is paused; only cancel and the ops-token verbs run until POST /resume (ops)');
  }
  const unverified = ctx.state.invariantsUnverified;
  if (Array.isArray(unverified) && unverified.length > 0 && verb !== 'cancel' && !opsVerb) {
    refuse('INVARIANTS_UNVERIFIED', `writes are held: ${unverified.join(', ')} could not be read on the last tick; they resume once the accountant and FactoryConfig reads succeed`, { unverified });
  }

  // 2. What the chain and the api say right now.
  let snapshot = spec.snapshot ?? null;
  if (!snapshot) {
    try {
      snapshot = await readSnapshot(ctx);
    } catch (error) {
      if (error instanceof Refusal) refuse(error.code, error.message, error.detail);
      refuse('UPSTREAM', `snapshot failed: ${error?.message ?? String(error)}`);
    }
  }

  // 3. The policy's own pre-check: portfolio, lock, pause, rate, SOL.
  // `allowedPortfolio` is the configured mint: the engine refuses when it is
  // absent (fail closed), so omitting it here refuses every write, chat and
  // the loop's apply alike, with no fake to notice.
  const write = deps.evaluateWrite({
    policy: ctx.policy, verb, portfolio: ctx.config.mint, allowedPortfolio: ctx.config.mint, state: ctx.state, ledger: ctx.state.ledger,
    lamports: snapshot?.signer?.lamports ?? null, now,
  });
  if (!write?.ok) refuse(write?.code ?? 'VERB_DENIED', write?.message ?? 'refused by policy');

  // 4. The verb's policy or gates.
  const pre = (await spec.precheck?.({ snapshot, deps, now, nowSecs, refuse })) ?? {};
  if (pre.stop) return pre.stop;

  // The decoder's intent, before the build: accounts it cannot be told are accounts it cannot check.
  let expect;
  try {
    expect = expectFor(ctx, { snapshot, intent: spec.intent?.({ pre, snapshot }) ?? {} });
  } catch (error) {
    if (error instanceof Refusal) refuse(error.code, error.message, error.detail);
    throw error;
  }

  // 5. Build at the api.
  let payload;
  try {
    payload = await spec.build({ snapshot, pre });
  } catch (error) {
    refuseFromClient(error, refuse);
  }
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  if (transactions.length === 0) refuse('BUILD_REFUSED', 'the api returned no transactions', { deploymentId: payload?.deploymentId ?? null });
  if (transactions.some((t) => !t || typeof t.tx !== 'string' || t.tx.trim() === '')) refuse('NOT_A_TRANSACTION', 'a built step carries no transaction');

  // 6. Decode every instruction of every transaction against the intent.
  const verify = () => {
    try {
      return deps.verifyBuilt({ transactions, verb, expect: { ...expect, lookupTables: ctx.chain.lookupTables } });
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message, detail: error.detail };
      return { ok: false, code: 'UNKNOWN_INSTRUCTION', message: `decode failed: ${error?.message ?? String(error)}` };
    }
  };
  let verdict = verify();
  // A v0 page loads accounts from the NAV table; when this process's copy
  // of the table is behind (the keeper extended it since the last tick) the
  // decoder cannot resolve an account it must assert. One refresh, one
  // retry — never a pass.
  if (!verdict?.ok && isLookupMiss(verdict) && typeof ctx.chain.refreshLookupTables === 'function') {
    try {
      await ctx.chain.refreshLookupTables();
      verdict = verify();
    } catch (error) {
      ctx.log?.('warn', 'lookup-table-refresh-failed', { error: scrubText(error?.message) });
    }
  }
  if (!verdict?.ok) refuse(verdict?.code ?? 'UNKNOWN_INSTRUCTION', verdict?.message ?? 'the built payload did not verify', verdict?.detail);

  // 7. Sign.
  let signed;
  try {
    signed = await ctx.signer.sign(transactions.map((t) => t.tx));
  } catch (error) {
    refuse(error instanceof Refusal ? error.code : 'NOT_A_TRANSACTION', error?.message ?? 'signing failed');
  }

  // 8. Send.
  const sent = await sendSigned(ctx, deps, verb, signed, refuse);

  // 9. Journal, then the verb's own bookkeeping.
  const record = journalAppend(ctx, {
    kind: 'verb',
    ...base,
    ok: true,
    signatures: sent.signatures,
    deploymentId: payload.deploymentId ?? null,
    steps: transactions.map((t) => t.step ?? null),
    ...(spec.record?.({ payload, sent, pre, snapshot }) ?? {}),
  });
  spec.after?.({ payload, sent, pre, snapshot, nowSecs, record });
  return spec.result({ payload, sent, pre, snapshot, record, transactions });
}

/** A client error into a refusal: the api's own codes that the loop reacts to keep their names. */
function refuseFromClient(error, refuse) {
  if (error instanceof Refusal) {
    const apiCode = String(error.detail?.code ?? '');
    if (error.code === 'BUILD_REFUSED' && /NO_PENDING|NOTHING_PENDING/i.test(apiCode)) refuse('NO_PENDING_CHANGE', error.message, error.detail);
    if (error.code === 'BUILD_REFUSED' && /MissingCustody|MISSING_CUSTODY/i.test(`${apiCode} ${error.detail?.message ?? ''}`)) refuse('MISSING_CUSTODY', error.message, error.detail);
    refuse(error.code, error.message, error.detail);
  }
  refuse('UPSTREAM', `build failed: ${error?.message ?? String(error)}`);
}

/**
 * A send failure named by program error where possible. The api's
 * "build it again" fix sentence is dropped and a `fix` field is never kept:
 * the loop decides on retries from the code and `expired`, not from prose.
 */
export function describeSendFailure(text, verb, deps, detail) {
  const stripped = scrubText(String(text ?? '').replace(FIX_SENTENCE, '').trim());
  let named = null;
  try {
    named = deps.nameProgramError(stripped, PROGRAM_OF_VERB[verb] ? { program: PROGRAM_OF_VERB[verb] } : {}) ?? null;
  } catch {
    named = null;
  }
  const { fix: _fix, ...rest } = detail && typeof detail === 'object' ? detail : {};
  const message = named?.name ? `${named.name} (${named.program} ${named.code}): ${stripped}` : (stripped || 'send failed');
  return {
    message,
    detail: {
      ...rest,
      ...(named ? { programError: named } : {}),
      expired: rest.status === 'expired' || /expired|blockhash/i.test(stripped),
    },
  };
}

async function sendSigned(ctx, deps, verb, signed, refuse) {
  let sent;
  try {
    sent = await ctx.client.send(signed);
  } catch (error) {
    if (error instanceof Refusal && error.code === 'UPSTREAM') refuse('UPSTREAM', error.message, error.detail);
    const text = error?.detail?.message ?? error?.message ?? String(error);
    const { message, detail } = describeSendFailure(text, verb, deps, error?.detail);
    refuse('SEND_FAILED', message, detail);
  }
  if (!sent || sent.status !== 'confirmed') {
    const text = sent?.error?.message ?? `the api reports the send as ${sent?.status ?? 'unknown'}`;
    const { message, detail } = describeSendFailure(text, verb, deps, { status: sent?.status ?? 'unknown', signatures: sent?.signatures ?? [] });
    refuse('SEND_FAILED', message, detail);
  }
  return { status: 'confirmed', signatures: Array.isArray(sent.signatures) ? sent.signatures : [] };
}

// ------------------------------------------------------------------- reads

/** GET /status — the README §2 status body. */
export async function status(ctx, args, meta) {
  const { snapshot, error } = await snapshotOrLast(ctx);
  return statusBody(ctx, snapshot, error);
}

/** The status body from a snapshot (the loop and /review reuse it). */
export function statusBody(ctx, snapshot, error = null) {
  const deps = depsOf(ctx);
  const nowSecs = nowSecsOf(ctx);
  const row = snapshot?.portfolioRow ?? null;
  const acct = snapshot?.portfolioAccount ?? null;
  let invariants = { ok: null, drift: [] };
  if (snapshot) {
    try {
      const check = deps.checkInvariants(snapshot, ctx.config, ctx.policy);
      const unverified = Array.isArray(check?.unverified) && check.unverified.length ? { unverified: check.unverified } : {};
      invariants = check?.ok ? { ok: true, drift: [], ...unverified } : { ok: false, drift: check?.drift ?? [], ...unverified };
    } catch (err) {
      invariants = { ok: null, drift: [], error: scrubText(err?.message) };
    }
  }
  const { state, deploymentId, effectiveAt, attempts, since, lastBlocker } = ctx.state.apply;
  const ledger = ctx.state.ledger ?? emptyLedger();
  return {
    ok: error === null && Boolean(snapshot),
    at: nowSecs,
    ...(error ? { error } : {}),
    paused: Boolean(ctx.state.paused),
    selfLocked: ctx.state.selfLocked ? { at: ctx.state.selfLocked.at, reason: ctx.state.selfLocked.reason } : null,
    operatorRequest: ctx.state.operatorRequest?.text ?? null,
    invariantsUnverified: Array.isArray(ctx.state.invariantsUnverified) && ctx.state.invariantsUnverified.length ? ctx.state.invariantsUnverified : null,
    apply: { state, deploymentId, effectiveAt, attempts, since, lastBlocker },
    portfolio: snapshot ? {
      mint: ctx.config.mint,
      symbol: row?.symbol ?? null,
      state: row?.state ?? plain(acct?.state) ?? null,
      priceState: row?.priceState ?? null,
      pendingPrice: row?.pendingPrice ?? null,
      withdrawalsPending: row?.withdrawalsPending ?? plain(snapshot.vaultAccount?.totalWithdrawalsPending) ?? null,
      curator: plain(acct?.curator) ?? row?.curator ?? null,
      pendingCurator: plain(acct?.pendingCurator),
      rebalanceDelaySecs: num(acct?.rebalanceDelaySecs) ?? row?.rebalanceDelaySecs ?? null,
      lastRebalanceAt: num(acct?.lastRebalanceAt),
      applyNextPage: num(acct?.applyNextPage),
      compositionLocked: acct?.compositionLocked ?? row?.compositionLocked ?? null,
      pendingTargets: row?.pendingTargets ?? null,
    } : null,
    signer: {
      wallet: ctx.signer.wallet,
      lamports: snapshot?.signer?.lamports ?? null,
      usdcBaseUnits: snapshot?.signer?.usdcBaseUnits ?? null,
      shares: snapshot?.signer?.shares ?? null,
    },
    invariants,
    ledger: {
      lastProposalAt: ledger.lastProposalAt ?? null,
      proposalsLast30d: ledger.proposalsLast30d ?? 0,
      depositsTodayUsd: ledger.depositsTodayUsd ?? 0,
      withdrawalsTodayUsd: ledger.withdrawalsTodayUsd ?? 0,
      writeAttemptsLastHour: writeAttemptsLastHour(ledger, nowSecs),
      lastDepositAt: ledger.lastDepositAt ?? null,
      topUpBudgetSpent: topUpBudgetSpentOf(ctx, ledger, nowSecs),
    },
    // `review` is the loaded threshold section, whole: `deriveReview` reads
    // `status.policy.review` and falls back to its own defaults without it, so
    // this is what makes the counts in force the document's (the ones GET
    // /policy serves and the digest names) rather than metrics.js constants.
    policy: { version: ctx.policy?.version ?? null, sha256: policyDigestOf(ctx), review: ctx.policy?.review ?? null },
    lastTick: ctx.state.lastTick,
  };
}

/**
 * Can this signer still top up today? `deriveReview` reads the answer as
 * `status.ledger.topUpBudgetSpent` for LEG_NEEDS_INFLOW: an asset that only
 * a deposit can heal is worth a wake only once the signer itself can no
 * longer deposit. Spent when the policy denies `deposit` outright, when the
 * day's cap is zero, or when today's deposits have reached it; the day's cap
 * is `launchDayCapUsd` on `policy.deposit.launchDay` and `dailyCapUsd`
 * otherwise, the same switch `evaluateDeposit` makes. The fields are read
 * defensively because a test ctx may carry a policy fixture; a cap that is
 * not a number reads as not spent, which only a fixture can produce
 * (`loadPolicy` refuses a document without it).
 */
function topUpBudgetSpentOf(ctx, ledger, nowSecs) {
  const doc = ctx.policy ?? {};
  const denied = Array.isArray(doc.verbs?.denied) && doc.verbs.denied.includes('deposit');
  if (denied) return true;
  const rules = doc.deposit ?? {};
  const today = policyMod.utcDay(nowSecs);
  const launchDay = typeof rules.launchDay === 'string' && rules.launchDay === today;
  const cap = num(launchDay ? rules.launchDayCapUsd : rules.dailyCapUsd);
  if (cap == null) return false;
  if (cap <= 0) return true;
  return (num(ledger?.depositsTodayUsd) ?? 0) >= cap;
}

/** GET /policy: the live policy document, its version and its digest. A read: never journaled, never a write attempt. */
export async function policy(ctx, args, meta) {
  return { version: ctx.policy?.version ?? null, sha256: policyDigestOf(ctx), policy: ctx.policy ?? null };
}

/** GET /review — deriveReview over a fresh snapshot. */
export async function review(ctx, args, meta) {
  meta = normMeta(meta);
  const deps = depsOf(ctx);
  const { snapshot, error } = await snapshotOrLast(ctx);
  const max = ctx.policy?.review?.briefMaxChars ?? 4096;
  if (!snapshot) {
    return { brief: `curator status unavailable: ${error}`.slice(0, max), triggers: [], wakeAgent: false, holdReason: 'STATUS_UNAVAILABLE' };
  }
  const body = statusBody(ctx, snapshot, error);
  const nowSecs = nowSecsOf(ctx);
  // Three cron scripts call this route: curator-review-gate.sh bare,
  // curator-universe.sh with `?mode=universe` and curator-weekly.sh with
  // `?mode=weekly`. Only the plain review may act (propose), so only the plain
  // review takes anything: it consumes an operator request, and it is the only
  // one that may advance and journal the review state below. Universe and
  // weekly read the same state and change nothing.
  const isPlainReview = !args?.mode || args.mode === 'review';

  // The notepad `deriveReview` carries between reviews (`drift_streak`, the
  // consecutive reviews an asset has sat under target; `risk_tiers`, the tier
  // each held pool had last time) is this signer's own journal, replayed into
  // `ctx.state.reviewState` at boot and after every plain review. Never a
  // request parameter: a streak the agent could send is a wake the agent could
  // grant itself. The last review record seeds the next review whatever its
  // age. A gap (a pod down for a week, a cron paused) does not reset the
  // streak, because nothing during the gap healed the asset; if it did, the
  // next review sees it on target and the streak drops to zero on its own.
  const stored = ctx.state.reviewState;
  const notepad = stored && typeof stored === 'object'
    ? { drift_streak: JSON.stringify(stored.driftStreak ?? {}), risk_tiers: JSON.stringify(stored.riskTiers ?? {}) }
    : {};
  // And only the daily gate advances it: a cron session, at most once per UTC
  // day, on a snapshot read this call. The agent's own `review` tool is this
  // same plain GET /review (the Claw Agent plugin sends no mode, and its skill
  // calls it on every owner message), so a review that advanced the streak on
  // every call would let the model mint a streak in seconds and would turn
  // "consecutive reviews" into "consecutive calls". A chat review therefore
  // never persists, whatever the day: if it did, an owner's 03:00 question
  // would become the day's record and the 09:00 gate would find a tier raised
  // overnight already stored and never wake on it. The session header is set
  // by the plugin, not the model, and claiming cron buys a caller nothing the
  // gate does not already have: one record a day. The model's tool call inside
  // the cron run reports cron too, and by then the gate script's review has
  // taken the day. A stale snapshot (the api or the RPC failed this call and
  // the last one was reused) reads but does not persist: a streak counted on
  // yesterday's weights is not a review. A stored record whose date cannot be
  // read counts as another day, so a damaged line cannot freeze the streak.
  const storedAt = Number(stored?.at);
  const storedDay = Number.isFinite(storedAt) ? policyMod.utcDay(storedAt) : null;
  const advancesState = isPlainReview && meta.session === 'cron' && error === null && storedDay !== policyMod.utcDay(nowSecs);
  const out = deps.deriveReview(snapshot.portfolioRow ?? null, snapshot.pools ?? [], snapshot.health ?? null, body, notepad, nowSecs) ?? {};
  const triggers = Array.isArray(out.triggers) ? out.triggers : [];
  // One request, one wake. Reporting it is what consumes it — the same shape as
  // /alerts marking what it just handed over — so an operator who sets a request
  // does not wake the agent every review until someone remembers to clear it.
  //
  // Only on the plain review, though. Universe emits no wake line at all (the
  // scheduler wakes it on output change), and weekly may not propose, so either
  // of them consuming a request would destroy it on behalf of a job that cannot
  // act on it, silently, hours before the review that could. They read; they
  // do not take.
  if (isPlainReview && ctx.state.operatorRequest && triggers.some((trigger) => trigger?.code === 'OPERATOR_REQUEST')) {
    const consumed = ctx.state.operatorRequest;
    ctx.state.operatorRequest = null;
    journalAppend(ctx, {
      kind: 'operator-request-consumed',
      caller: meta.caller,
      session: meta.session,
      tokenKind: meta.tokenKind,
      requestedAt: consumed.at ?? null,
    });
  }
  // Persist what the next review needs: the daily gate only (`advancesState`
  // above). A fake `deriveReview` that returns no metrics journals nothing:
  // there is nothing to carry. The journal is the source and memory follows
  // it, never the other way round: when the append fails the state stays as
  // it was, so a restart replays exactly what the agent was told.
  const driftStreak = out.metrics?.driftStreak;
  const riskTiers = out.metrics?.riskTiers;
  const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (advancesState && isMap(driftStreak) && isMap(riskTiers)) {
    const written = journalAppend(ctx, {
      kind: 'review',
      caller: meta.caller,
      session: meta.session,
      tokenKind: meta.tokenKind,
      driftStreak,
      riskTiers,
      triggers: triggers.map((trigger) => trigger?.code ?? null),
    });
    if (written) ctx.state.reviewState = { at: nowSecs, driftStreak, riskTiers };
  }
  return {
    brief: String(out.brief ?? '').slice(0, max),
    triggers,
    wakeAgent: Boolean(out.wakeAgent),
    holdReason: typeof out.holdReason === 'string' ? out.holdReason : '',
  };
}

/** GET /alerts — undelivered anomalies; marks them delivered. */
export async function alerts(ctx, args, meta) {
  const now = nowSecsOf(ctx);
  const out = [];
  for (const [key, entry] of ctx.state.alerts) {
    if (entry.delivered) continue;
    if (entry.resolvedAt) {
      out.push({ key, code: entry.code, at: entry.resolvedAt, message: `resolved: ${entry.message}`, resolved: true });
      ctx.state.alerts.delete(key);
      continue;
    }
    out.push({ key, code: entry.code, at: entry.at, message: entry.message, ...(entry.count > 1 ? { count: entry.count } : {}) });
    entry.delivered = true;
  }
  const since = ctx.state.alertsSince;
  ctx.state.alertsSince = now;
  return { since, alerts: out };
}

/** POST /simulate { targets, why? } — evaluateProposal + proposeGates; nothing built. */
export async function simulate(ctx, args, meta) {
  meta = normMeta(meta);
  const targets = parseTargets(args?.targets);
  const why = typeof args?.why === 'string' ? args.why : undefined;
  const deps = depsOf(ctx);
  const now = ctx.now();
  let snapshot;
  try {
    snapshot = await readSnapshot(ctx);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('UPSTREAM', `snapshot failed: ${scrubText(error?.message)}`);
  }
  const evaluated = deps.evaluateProposal({ policy: ctx.policy, targets, why, snapshot, ledger: ctx.state.ledger, now, session: meta.session }) ?? { ok: false, code: 'INPUTS_INCOMPLETE', message: 'no evaluation' };
  let refusals = evaluated.ok
    ? []
    : (Array.isArray(evaluated.refusals) && evaluated.refusals.length ? evaluated.refusals : [{ code: evaluated.code, message: evaluated.message }]);
  if (why === undefined) refusals = refusals.filter((r) => r.code !== 'WHY_REQUIRED');
  const gates = deps.proposeGates(snapshot, ctx.policy, Math.floor(now / 1000));
  if (gates && gates.ok === false) refusals.push(...(gates.blockers ?? []).map((b) => ({ code: b.code, message: b.message })));
  return { ok: refusals.length === 0, refusals, summary: evaluated.summary ?? null };
}

// ------------------------------------------------------------------ writes

/** POST /propose { targets, why } — announce a rebalance; arms the apply machine. */
export async function propose(ctx, args, meta) {
  meta = normMeta(meta);
  const targets = parseTargets(args?.targets);
  const why = whyOf(args);
  return runWrite(ctx, meta, 'propose', {
    args: { targets, why, ...(args?.mint !== undefined ? { mint: args.mint } : {}) },
    precheck: ({ snapshot, deps, now, nowSecs, refuse }) => {
      requireWhy(ctx, why, refuse);
      const evaluated = deps.evaluateProposal({ policy: ctx.policy, targets, why, snapshot, ledger: ctx.state.ledger, now, session: meta.session });
      if (!evaluated?.ok) {
        refuse(evaluated?.code ?? 'INPUTS_INCOMPLETE', evaluated?.message ?? 'refused by policy', {
          refusals: evaluated?.refusals ?? [], summary: evaluated?.summary ?? null,
        });
      }
      const gates = deps.proposeGates(snapshot, ctx.policy, nowSecs);
      if (gates && gates.ok === false) {
        const first = gates.blockers?.[0] ?? { code: 'TARGETS_PENDING', message: 'chain state blocks a proposal' };
        refuse(first.code, first.message, { blockers: gates.blockers ?? [] });
      }
      const delay = num(snapshot?.portfolioAccount?.rebalanceDelaySecs) ?? snapshot?.portfolioRow?.rebalanceDelaySecs ?? ctx.config.rebalanceDelaySecs;
      return { targets, summary: evaluated.summary ?? null, effectiveAt: nowSecs + Number(delay ?? 0) };
    },
    intent: () => ({ targets }),
    build: () => ctx.client.buildPropose(ctx.config.mint, { curator: ctx.signer.wallet, targets }),
    record: ({ pre }) => ({ effectiveAt: pre.effectiveAt, summary: pre.summary }),
    after: ({ payload, sent, pre, nowSecs }) => {
      const from = ctx.state.apply.state;
      ctx.state.apply = {
        ...initialApplyState(),
        state: 'ARMED',
        deploymentId: payload.deploymentId ?? null,
        effectiveAt: pre.effectiveAt,
        targets,
        proposedAt: nowSecs,
        since: nowSecs,
      };
      bumpLedger(ctx, (ledger) => {
        ledger.lastProposalAt = Math.max(ledger.lastProposalAt ?? 0, nowSecs);
        ledger.proposalsLast30d = (ledger.proposalsLast30d ?? 0) + 1;
        ledger.proposals.push({ at: nowSecs, effectiveAt: pre.effectiveAt, targets, signatures: sent.signatures, why });
      });
      journalAppend(ctx, { kind: 'apply', from, to: 'ARMED', deploymentId: payload.deploymentId ?? null, effectiveAt: pre.effectiveAt, blockers: [], attempts: 0, signatures: [] });
    },
    result: ({ payload, sent, pre, record }) => ({
      ok: true, verb: 'propose', deploymentId: payload.deploymentId ?? null, signatures: sent.signatures, effectiveAt: pre.effectiveAt, journalId: record?.id ?? null,
    }),
  });
}

/**
 * Was the announced change already applied (by us or a stranger)?
 * `done` when the holdings' target weights equal the proposal; `mismatch`
 * when `last_rebalance_at` moved past our proposal but the weights differ;
 * `cancelled` when nothing moved.
 */
export function appliedVerdict(applyState, snapshot) {
  if (!applyState || applyState.state === 'IDLE' || !Array.isArray(applyState.targets)) return { none: true };
  const onChain = currentTargetsOf(snapshot);
  const lastRebalanceAt = num(snapshot?.portfolioAccount?.lastRebalanceAt);
  if (onChain && targetsEqual(applyState.targets, onChain)) return { done: true };
  const advanced = lastRebalanceAt != null && applyState.proposedAt != null && lastRebalanceAt >= applyState.proposedAt;
  if (advanced) return { mismatch: true, onChain, lastRebalanceAt };
  return { cancelled: true };
}

async function applyAttempt(ctx, meta, { gated, transition, snapshot: given }) {
  return runWrite(ctx, meta, 'apply', {
    args: {},
    snapshot: given,
    precheck: ({ snapshot, deps, nowSecs, refuse }) => {
      const targets = pendingTargetsOf(snapshot) ?? ctx.state.apply.targets ?? undefined;
      if (!gated) return { targets };
      const gate = deps.applyGates(snapshot, ctx.policy, nowSecs) ?? { ok: false, blockers: [{ code: 'INPUTS_INCOMPLETE', action: 'wait', message: 'no gate result' }] };
      if (gate.ok) return { targets };
      const blockers = Array.isArray(gate.blockers) ? gate.blockers : [];
      const done = blockers.find((b) => b.action === 'done');
      if (done) {
        const verdict = appliedVerdict(ctx.state.apply, snapshot);
        const from = ctx.state.apply.state;
        if (verdict.done) {
          ctx.state.apply = { ...ctx.state.apply, state: 'DONE', since: nowSecs };
          journalAppend(ctx, { kind: 'apply', from, to: 'DONE', deploymentId: ctx.state.apply.deploymentId, blockers: ['NO_PENDING_CHANGE'], attempts: ctx.state.apply.attempts, signatures: ctx.state.apply.signatures ?? [] });
          clearApplyAlerts(ctx);
          return { stop: { ok: true, verb: 'apply', state: 'DONE', signatures: ctx.state.apply.signatures ?? [] } };
        }
        if (verdict.mismatch) {
          const message = 'the pending change is gone and the on-chain targets differ from the proposal';
          ctx.state.apply = { ...ctx.state.apply, state: 'ESCALATED', since: nowSecs, escalatedAt: nowSecs, lastBlocker: { code: 'APPLIED_MISMATCH', since: nowSecs, message } };
          journalAppend(ctx, { kind: 'apply', from, to: 'ESCALATED', deploymentId: ctx.state.apply.deploymentId, blockers: ['APPLIED_MISMATCH'], attempts: ctx.state.apply.attempts, signatures: [] });
          raiseAlert(ctx, 'apply:APPLIED_MISMATCH', 'APPLIED_MISMATCH', message);
          return { stop: withStatus({ ok: false, verb: 'apply', state: 'ESCALATED', blockers: [{ code: 'APPLIED_MISMATCH', action: 'escalate', message }] }, 409) };
        }
        refuse('NO_PENDING_CHANGE', done.message ?? 'nothing is pending on this portfolio');
      }
      const first = blockers[0] ?? { code: 'INPUTS_INCOMPLETE', message: 'pre-flight did not pass' };
      journalAppend(ctx, { kind: 'refusal', verb: 'apply', route: 'apply', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, args: {}, ok: false, code: first.code, message: scrubText(first.message), detail: { blockers } });
      return { stop: withStatus({ ok: false, verb: 'apply', state: ctx.state.apply.state, blockers }, REFUSAL_STATUS[first.code] ?? 422) };
    },
    build: () => ctx.client.buildApply(ctx.config.mint, { caller: ctx.signer.wallet }),
    after: ({ sent, nowSecs }) => {
      // The loop's send (transition: false) leaves the machine to applyOutcome, signatures included.
      if (!transition) return;
      const a = ctx.state.apply;
      const signatures = [...(a.signatures ?? []), ...sent.signatures];
      ctx.state.apply = { ...a, state: 'CONFIRM', attempts: a.attempts + 1, sendFailures: 0, lastSentAt: nowSecs, since: nowSecs, signatures };
      journalAppend(ctx, { kind: 'apply', from: a.state, to: 'CONFIRM', deploymentId: a.deploymentId, blockers: [], attempts: a.attempts + 1, signatures: sent.signatures });
    },
    result: ({ sent, transactions }) => ({ ok: true, verb: 'apply', state: 'SENT', signatures: sent.signatures, steps: transactions.map((t) => t.step ?? null) }),
  });
}

/** POST /apply — one forced attempt through applyGates; the loop does the same on its own. */
export async function apply(ctx, args, meta) {
  return applyAttempt(ctx, normMeta(meta), { gated: true, transition: true });
}

/** The loop's SEND step: build → verify → sign → send, gates already run on the loop's snapshot. */
export async function applySend(ctx, meta, { snapshot } = {}) {
  return applyAttempt(ctx, normMeta(meta), { gated: false, transition: false, snapshot });
}

/** POST /cancel { why } — allowed while paused, never while self-locked. */
export async function cancel(ctx, args, meta) {
  meta = normMeta(meta);
  const why = whyOf(args);
  return runWrite(ctx, meta, 'cancel', {
    args: { why },
    precheck: ({ refuse }) => {
      requireWhy(ctx, why, refuse);
      return {};
    },
    build: () => ctx.client.buildCancel(ctx.config.mint, { signer: ctx.signer.wallet }),
    after: ({ sent, nowSecs }) => {
      const from = ctx.state.apply.state;
      ctx.state.apply = { ...initialApplyState(), since: nowSecs };
      journalAppend(ctx, { kind: 'apply', from, to: 'IDLE', blockers: ['CANCELLED'], attempts: 0, signatures: sent.signatures });
      clearApplyAlerts(ctx);
    },
    result: ({ sent, record }) => ({ ok: true, verb: 'cancel', signatures: sent.signatures, journalId: record?.id ?? null }),
  });
}

/** POST /deposit { amountUsd } — from the signer's USDC ATA into WEAVR. */
export async function deposit(ctx, args, meta) {
  meta = normMeta(meta);
  const amountUsd = parseAmountUsd(args?.amountUsd);
  return runWrite(ctx, meta, 'deposit', {
    args: { amountUsd },
    precheck: ({ snapshot, deps, now, refuse }) => {
      const evaluated = deps.evaluateDeposit({ policy: ctx.policy, amountUsd, snapshot, ledger: ctx.state.ledger, now });
      if (!evaluated?.ok) refuse(evaluated?.code ?? 'CAP_HEADROOM', evaluated?.message ?? 'refused by policy', evaluated?.detail);
      const summary = evaluated.summary ?? {};
      if (summary.amountBaseUnits == null || summary.minShares == null) refuse('CAP_HEADROOM', 'deposit evaluation returned no amount');
      return { amountBaseUnits: String(summary.amountBaseUnits), minShares: String(summary.minShares) };
    },
    intent: ({ pre }) => ({ amount: pre.amountBaseUnits, minShares: pre.minShares }),
    build: ({ pre }) => ctx.client.buildDeposit(ctx.config.mint, { user: ctx.signer.wallet, amount: pre.amountBaseUnits, minShares: pre.minShares }),
    record: ({ pre }) => ({ amountBaseUnits: pre.amountBaseUnits, minShares: pre.minShares }),
    after: () => bumpLedger(ctx, (ledger) => { ledger.depositsTodayUsd = (ledger.depositsTodayUsd ?? 0) + amountUsd; }),
    result: ({ sent, pre }) => ({ ok: true, verb: 'deposit', amountBaseUnits: pre.amountBaseUnits, minShares: pre.minShares, signatures: sent.signatures }),
  });
}

/** POST /withdraw { amountUsd } — chat sessions only; to the signer's own ATA. */
export async function withdraw(ctx, args, meta) {
  meta = normMeta(meta);
  const amountUsd = parseAmountUsd(args?.amountUsd);
  return runWrite(ctx, meta, 'withdraw', {
    args: { amountUsd },
    precheck: ({ snapshot, deps, now, refuse }) => {
      const evaluated = deps.evaluateWithdraw({ policy: ctx.policy, amountUsd, session: meta.session, snapshot, ledger: ctx.state.ledger, now });
      if (!evaluated?.ok) refuse(evaluated?.code ?? 'WITHDRAW_DAILY_CAP', evaluated?.message ?? 'refused by policy', evaluated?.detail);
      const summary = evaluated.summary ?? {};
      if (summary.shares == null || summary.minAmountOut == null) refuse('WITHDRAW_DAILY_CAP', 'withdraw evaluation returned no shares');
      return { shares: String(summary.shares), minAmountOut: String(summary.minAmountOut) };
    },
    intent: ({ pre }) => ({ shares: pre.shares, minAmountOut: pre.minAmountOut }),
    build: ({ pre }) => ctx.client.buildWithdraw(ctx.config.mint, { user: ctx.signer.wallet, shares: pre.shares, minAmountOut: pre.minAmountOut }),
    record: ({ pre }) => ({ shares: pre.shares, minAmountOut: pre.minAmountOut }),
    after: () => bumpLedger(ctx, (ledger) => { ledger.withdrawalsTodayUsd = (ledger.withdrawalsTodayUsd ?? 0) + amountUsd; }),
    result: ({ sent, pre }) => ({ ok: true, verb: 'withdraw', shares: pre.shares, minAmountOut: pre.minAmountOut, signatures: sent.signatures }),
  });
}

/** POST /refresh-nav — crank the book when the keeper cannot. */
export async function refreshNav(ctx, args, meta) {
  meta = normMeta(meta);
  return runWrite(ctx, meta, 'refresh-nav', {
    args: {},
    build: () => ctx.client.buildRefreshNav(ctx.config.mint, { payer: ctx.signer.wallet }),
    result: ({ sent, transactions }) => ({ ok: true, verb: 'refresh-nav', pages: transactions.length, signatures: sent.signatures }),
  });
}

/** POST /pause { why? } — kill-switch step 1: disarm apply, refuse writes except cancel. Idempotent. */
export async function pause(ctx, args, meta) {
  meta = normMeta(meta);
  const why = whyOf(args);
  const was = ctx.state.paused;
  ctx.state.paused = true;
  journalAppend(ctx, { kind: 'pause', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, why: why || null, alreadyPaused: was });
  ctx.log?.('warn', 'paused', { caller: meta.caller, why: why || null });
  return { ok: true, paused: true };
}

/** POST /note { text ≤ 2 KB } — the LLM's lesson, journaled. */
export async function note(ctx, args, meta) {
  meta = normMeta(meta);
  const text = args?.text;
  if (typeof text !== 'string' || text.trim() === '') throw bad('text must be a non-empty string');
  if (Buffer.byteLength(text, 'utf8') > NOTE_MAX_CHARS) throw bad(`text must be at most ${NOTE_MAX_CHARS} bytes`);
  const record = journalAppend(ctx, { kind: 'note', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, text });
  return { ok: true, journalId: record?.id ?? null };
}

/** GET /journal?n= — the last n records, oldest first. */
export async function journal(ctx, args, meta) {
  const raw = args?.n;
  const parsed = raw === undefined || raw === '' ? JOURNAL_DEFAULT_N : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw bad('n must be a non-negative integer');
  const n = Math.min(parsed, JOURNAL_MAX_N);
  return { records: ctx.journal.tail(n) ?? [] };
}

/** POST /hermes-heartbeat — sets curator_hermes_heartbeat_ts. */
export async function hermesHeartbeat(ctx, args, meta) {
  meta = normMeta(meta);
  const at = nowSecsOf(ctx);
  ctx.state.hermesHeartbeatAt = at;
  journalAppend(ctx, { kind: 'heartbeat', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind });
  return { ok: true, at };
}

// ---------------------------------------------------------------- ops verbs

/**
 * POST /operator-request { text ≤ 200, why } or { clear: true } (ops).
 *
 * The one wake trigger a human can raise. `deriveReview` has always looked for
 * it (`OPERATOR_REQUEST`), but had nowhere to read it from on this side: the
 * review route passes no notepad and `statusBody` carried no field, so the
 * trigger could not fire in production however the agent host was configured.
 * This is that field. The ops token, not the agent's: asking the curator to
 * think is the operator's call, and the agent must not be able to wake itself.
 *
 * It is state, not a write to the chain — `resume` and `unlock` are the shape
 * to compare it against, and like them it is journalled and replayed on boot.
 */
export async function operatorRequest(ctx, args, meta) {
  meta = normMeta(meta);
  const why = whyOf(args);
  if (args?.clear === true) {
    const had = ctx.state.operatorRequest;
    ctx.state.operatorRequest = null;
    if (had) {
      journalAppend(ctx, {
        kind: 'operator-request-consumed',
        caller: meta.caller,
        session: meta.session,
        tokenKind: meta.tokenKind,
        requestedAt: had.at ?? null,
        why: why || null,
      });
    }
    return { ok: true, cleared: Boolean(had), text: null };
  }
  const text = typeof args?.text === 'string' ? args.text.trim() : '';
  if (text === '') throw bad('text must be a non-empty string, or pass clear: true');
  if (text.length > OPERATOR_REQUEST_MAX_CHARS) throw bad(`text must be at most ${OPERATOR_REQUEST_MAX_CHARS} characters`);
  const at = nowSecsOf(ctx);
  ctx.state.operatorRequest = { at, text };
  journalAppend(ctx, { kind: 'operator-request', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, text, why: why || null });
  ctx.log?.('info', 'operator-request', { caller: meta.caller, why: why || null });
  return { ok: true, at, text };
}

/** POST /resume (ops) */
export async function resume(ctx, args, meta) {
  meta = normMeta(meta);
  const why = whyOf(args);
  ctx.state.paused = false;
  journalAppend(ctx, { kind: 'resume', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, why: why || null });
  ctx.log?.('info', 'resumed', { caller: meta.caller, why: why || null });
  return { ok: true, paused: false };
}

/** POST /unlock { why } (ops) — refuses while the drift is still present. */
export async function unlock(ctx, args, meta) {
  meta = normMeta(meta);
  const why = whyOf(args);
  const base = { verb: 'unlock', route: 'unlock', caller: meta.caller, session: meta.session, tokenKind: meta.tokenKind, args: { why } };
  const refuse = (code, message, detail) => {
    journalAppend(ctx, { kind: 'refusal', ...base, ok: false, code, message, ...(detail !== undefined ? { detail } : {}) });
    const error = new Refusal(code, message, detail);
    error.journaled = true;
    throw error;
  };
  requireWhy(ctx, why, refuse);
  if (!ctx.state.selfLocked) return { ok: true, selfLocked: null, note: 'the signer was not locked' };
  let snapshot;
  try {
    snapshot = await readSnapshot(ctx);
  } catch (error) {
    refuse('UPSTREAM', `snapshot failed: ${scrubText(error?.message)}`);
  }
  const check = depsOf(ctx).checkInvariants(snapshot, ctx.config, ctx.policy);
  if (!check?.ok) refuse('INVARIANT_DRIFT', 'the drift is still present; fix it on chain before unlocking', { drift: check?.drift ?? [] });
  const locked = ctx.state.selfLocked;
  ctx.state.selfLocked = null;
  journalAppend(ctx, { kind: 'unlock', ...base, lockedAt: locked.at, reason: locked.reason });
  clearAlert(ctx, 'invariants');
  ctx.log?.('warn', 'unlocked', { caller: meta.caller, why });
  return { ok: true, selfLocked: null };
}

/**
 * POST /rotate-curator { newCurator, why } (ops) — `propose_curator` signed by
 * the current key. The accept must be signed by the new key, which is not on
 * this box, so the answer spells out the two remaining steps instead of
 * pretending to do them. The invariants drift on purpose after this
 * (pending_curator set, then curator changed): this process self-locks and is
 * replaced by one booted with the new key.
 */
export async function rotateCurator(ctx, args, meta) {
  meta = normMeta(meta);
  const newCurator = parsePubkey(args?.newCurator, 'newCurator');
  const why = whyOf(args);
  const mint = ctx.config.mint;
  return runWrite(ctx, meta, 'rotate-curator', {
    args: { newCurator, why },
    precheck: ({ refuse }) => {
      requireWhy(ctx, why, refuse);
      if (newCurator === ctx.signer.wallet) refuse('BAD_REQUEST', 'newCurator is already the curator');
      return {};
    },
    intent: () => ({ newCurator }),
    build: () => ctx.client.buildProposeCurator(mint, { signer: ctx.signer.wallet, newCurator }),
    result: ({ sent }) => ({
      ok: true,
      verb: 'rotate-curator',
      signatures: sent.signatures,
      newCurator,
      next: {
        step: 'accept_curator',
        signedBy: 'the new curator key, outside this process',
        build: { method: 'POST', path: `/v1/portfolios/${mint}/curator/accept`, body: { signer: newCurator } },
        send: { method: 'POST', path: '/v1/transactions/send', body: { signed: ['<base64 transaction signed by the new key>'] } },
        then: [
          'this signer self-locks on its next tick (pending_curator, then curator, drift from the expected key)',
          'rotate CURATOR_KEYPAIR_JSON to the new key in 1Password, force-sync the ExternalSecret, roll the curator pod',
          'POST /unlock (ops) on the new process once curator == its wallet and pending_curator == null',
        ],
      },
    }),
  });
}

/** POST /set-delay { rebalanceDelaySecs, why } (ops) — REST /v1/portfolios/:mint/rebalance-delay. */
export async function setDelay(ctx, args, meta) {
  meta = normMeta(meta);
  const secs = typeof args?.rebalanceDelaySecs === 'string' ? Number(args.rebalanceDelaySecs) : args?.rebalanceDelaySecs;
  if (!Number.isInteger(secs) || secs < 0) throw bad('rebalanceDelaySecs must be a non-negative integer');
  const why = whyOf(args);
  return runWrite(ctx, meta, 'set-delay', {
    args: { rebalanceDelaySecs: secs, why },
    precheck: ({ refuse }) => {
      requireWhy(ctx, why, refuse);
      return {};
    },
    intent: () => ({ rebalanceDelaySecs: secs }),
    build: () => ctx.client.buildRebalanceDelay(ctx.config.mint, { curator: ctx.signer.wallet, rebalanceDelaySecs: secs }),
    result: ({ sent }) => ({
      ok: true,
      verb: 'set-delay',
      rebalanceDelaySecs: secs,
      signatures: sent.signatures,
      ...(secs !== ctx.config.rebalanceDelaySecs ? {
        warning: `the invariant expects rebalanceDelaySecs == ${ctx.config.rebalanceDelaySecs}; this signer self-locks on its next tick until the policy/env is updated or the delay is set back`,
      } : {}),
    }),
  });
}

/** POST /set-metadata { uri, why } (ops) — REST /v1/portfolios/:mint/metadata. */
export async function setMetadata(ctx, args, meta) {
  meta = normMeta(meta);
  const uri = args?.uri;
  if (typeof uri !== 'string' || uri.trim() === '') throw bad('uri must be a non-empty string');
  if (uri.length > METADATA_URI_MAX_CHARS) throw bad(`uri must be at most ${METADATA_URI_MAX_CHARS} characters`);
  const why = whyOf(args);
  return runWrite(ctx, meta, 'set-metadata', {
    args: { uri, why },
    precheck: ({ refuse }) => {
      requireWhy(ctx, why, refuse);
      return {};
    },
    intent: () => ({ uri }),
    build: () => ctx.client.buildMetadata(ctx.config.mint, { signer: ctx.signer.wallet, uri }),
    result: ({ sent }) => ({ ok: true, verb: 'set-metadata', uri, signatures: sent.signatures }),
  });
}

/** Route name → verb. */
export const VERBS = Object.freeze({
  status,
  review,
  policy,
  alerts,
  simulate,
  propose,
  apply,
  cancel,
  deposit,
  withdraw,
  'refresh-nav': refreshNav,
  pause,
  note,
  journal,
  'hermes-heartbeat': hermesHeartbeat,
  resume,
  unlock,
  'rotate-curator': rotateCurator,
  'set-delay': setDelay,
  'set-metadata': setMetadata,
  'operator-request': operatorRequest,
});

/** Verbs the ops token alone may call. */
export const OPS_VERBS = Object.freeze(new Set(['resume', 'unlock', 'rotate-curator', 'set-delay', 'set-metadata', 'operator-request']));

/** Verbs that sign and send (counted against RATE_LIMITED, refused when paused or self-locked). */
export const WRITE_VERBS = Object.freeze(new Set([
  'propose', 'apply', 'cancel', 'deposit', 'withdraw', 'refresh-nav', 'rotate-curator', 'set-delay', 'set-metadata',
]));
