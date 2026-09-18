/**
 * Pre-flight (plan §4.5): what the chain and the api say right now, and
 * whether an apply or a propose may go ahead. The gates mirror the checks in
 * `targets.rs` (`apply_targets_handler`, `validate_proposal`) so a refusal is
 * predicted here instead of discovered as a failed transaction — and read
 * `last_rebalance_at`, `apply_next_page`, caps and recipients from the
 * accounts directly, because the REST row does not carry them.
 *
 * `readSnapshot` is the only impure function in this file; everything else is
 * a pure function of a snapshot so each blocker row has a faked test.
 *
 * Two rules every gate follows:
 *
 * - Unknown is never fine. An optional read that failed is `null` in the
 *   snapshot and a gate answers `wait` for it (the api will be back), never
 *   `ok`. The two required accounts (`Portfolio`, `VaultConfig`) throw.
 * - Per pool means per pool. The api's book-level `priceState` tolerates a
 *   parked pool mark when the last-good one is fresh (`catalogue.js
 *   bookPriceState`), which is exactly the `PoolPricePending` trap: the
 *   program checks each pool's own `pending_price`. So the leg gates read
 *   `pools[].pendingPrice` / `pools[].priceState`, never the book's.
 */

/** Solana's target slot time; a slot wait is expressed in seconds for the loop. */
const SECS_PER_SLOT = 0.4;

/** The on-chain `apply_targets` wait after a half-done paged apply (`APPLY_MAX_SLOTS`). Policy must wait at least this. */
const CHAIN_APPLY_MAX_SLOTS = 300;

/** Anchor decodes `u64`/`i64` as BN; the api serialises them as strings. */
const num = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
};

const big = (value) => {
  if (value == null) return null;
  try {
    return BigInt(typeof value === 'bigint' ? value : value.toString());
  } catch {
    return null;
  }
};

/** A PublicKey or a base58 string → base58; `null` stays `null` (an Anchor `Option<Pubkey>` that is `None`). */
const b58 = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return value.toBase58?.() ?? String(value);
};

/** An Anchor enum decodes as `{ live: {} }`; the api serialises it as `'live'`. */
const variant = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return Object.keys(value)[0] ?? null;
};

/** RFC 3339 or unix seconds (number, string, BN) → unix seconds. */
const secs = (value) => {
  if (value == null) return null;
  if (typeof value === 'string' && /[^0-9]/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return num(value);
};

const blocker = (code, action, message, extra = {}) => ({ code, action, message, ...extra });

const escalateSecs = (policy, key, fallback) => {
  const table = policy?.apply?.escalateAfterSecs ?? {};
  return table[key] === undefined ? fallback : table[key];
};

/** The pending header from the chain (the truth) with the target set from the row (the header carries timestamps only). */
function pendingChange(snapshot) {
  const header = snapshot.portfolioAccount?.pendingTargets ?? null;
  if (!header) return null;
  const rowPending = snapshot.portfolioRow?.pendingTargets ?? null;
  const targets = rowPending?.targets ?? null;
  return {
    proposedAt: num(header.proposedAt) ?? secs(rowPending?.proposedAt),
    effectiveAt: num(header.effectiveAt) ?? secs(rowPending?.effectiveAt),
    targets,
    newSet: targets ? new Set(targets.map((target) => target.poolId).filter(Boolean)) : null,
  };
}

/** Pool rows by poolId; `null` when the catalogue read failed. */
function poolIndex(pools) {
  if (pools == null) return null;
  const list = pools instanceof Map ? [...pools.values()] : pools;
  return new Map(list.map((pool) => [pool.poolId, pool]));
}

/**
 * The held ∪ new leg set the program walks, with what we know of each: the
 * custody balance (the `shares` of the holdings row) and whether an unwind is
 * pending (`snapshot.pendingUnwinds`, an array of poolIds, or `null` when
 * unknown — the api row keeps it non-enumerable today).
 */
function legSet(snapshot, pending) {
  const row = snapshot.portfolioRow;
  const holdings = row?.holdings?.legs ?? null;
  const heldIds = holdings ? holdings.map((leg) => leg.poolId) : (row?.positions ?? null);
  if (heldIds == null) return null;
  const unwinds = Array.isArray(snapshot.pendingUnwinds) ? new Set(snapshot.pendingUnwinds) : null;
  const legs = new Map();
  for (const poolId of heldIds) {
    if (!poolId) continue;
    const holding = holdings?.find((leg) => leg.poolId === poolId) ?? null;
    legs.set(poolId, {
      poolId,
      held: true,
      inNewSet: pending.newSet ? pending.newSet.has(poolId) : null,
      custody: holding ? big(holding.shares) : null,
      unwindPending: unwinds ? unwinds.has(poolId) : null,
    });
  }
  for (const poolId of pending.newSet ?? []) {
    if (!legs.has(poolId)) {
      legs.set(poolId, { poolId, held: false, inNewSet: true, custody: 0n, unwindPending: false });
    }
  }
  return [...legs.values()];
}

/** The keeper row of `/health`: `processes.keeper.status === 'ok'`; `null` when the api or the row is missing. */
function keeperOk(health) {
  if (health == null) return null;
  if (typeof health.keeper?.ok === 'boolean') return health.keeper.ok;
  const status = health.processes?.keeper?.status;
  return status == null ? null : status === 'ok';
}

/**
 * Blockers for an apply, in evaluation order (README §5 table). Each blocker
 * carries an action: 'wait' (re-run next tick), 'blocked' (the LLM must
 * cancel and re-propose), 'escalate' (alert now), 'done' (nothing pending —
 * the loop checks whether a stranger applied our proposal). Every blocker is
 * collected, not only the first, so `/apply` can show the LLM the whole list;
 * `NO_PENDING_CHANGE` alone short-circuits because nothing else means
 * anything without a pending change.
 *
 * Mirror of `apply_targets_handler`: TargetsNotEffective → NOTICE_NOT_ELAPSED,
 * VaultPaused → VAULT_PAUSED, PortfolioPriceStale → BOOK_NOT_FRESH,
 * PortfolioPricePending → BOOK_PENDING_PRICE, PendingWithdrawalsBlockTargets →
 * WITHDRAWALS_PENDING, ApplyInFlight → APPLY_IN_FLIGHT, and per held-or-new
 * leg (unless retirable: omitted from the new set, custody 0, no pending
 * unwind) RequiredPoolPaused / PoolNotActive → LEG_NOT_ACTIVE, PoolPriceStale →
 * LEG_STALE, PoolPricePending → LEG_PENDING_PRICE (Pyth-cranked pools wait,
 * publisher-marked pools escalate at once: nobody cranks those), and
 * MissingCustodyForNewPool → MISSING_CUSTODY when `snapshot.custody` knows.
 * @param {object} snapshot README §4.2
 * @param {object} policy loadPolicy() result (`apply.*` timings)
 * @param {number} now unix secs
 * @param {number} [slot] current slot; defaults to `snapshot.slot`
 * @returns {{ ok: true } | { ok: false, blockers: Array<{ code: string, action: 'wait' | 'blocked' | 'escalate' | 'done', waitSecs?: number, escalateAfterSecs: number | null, message: string }> }}
 */
export function applyGates(snapshot, policy, now, slot = snapshot?.slot ?? null) {
  const account = snapshot?.portfolioAccount;
  const vault = snapshot?.vaultAccount;
  if (!account || !vault) throw new Error('preflight: portfolioAccount and vaultAccount are required');
  const apply = policy?.apply ?? {};
  const tickSecs = apply.tickSecs ?? 30;
  const blockers = [];

  const pending = pendingChange(snapshot);
  if (!pending) {
    return {
      ok: false,
      blockers: [blocker('NO_PENDING_CHANGE', 'done', 'no targets change is pending on chain', { escalateAfterSecs: null })],
    };
  }

  const { effectiveAt } = pending;
  const windowSecs = apply.windowAfterEffectiveSecs ?? 21600;
  if (effectiveAt != null && now > effectiveAt + windowSecs) {
    blockers.push(blocker('WINDOW_CLOSED', 'escalate',
      `the apply window closed ${now - effectiveAt - windowSecs} s ago (effectiveAt + ${windowSecs} s)`,
      { escalateAfterSecs: escalateSecs(policy, 'WINDOW_CLOSED', 0), effectiveAt }));
  }
  if (effectiveAt == null) {
    blockers.push(blocker('NOTICE_NOT_ELAPSED', 'wait', 'effectiveAt unknown: pending header unreadable',
      { waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'BOOK_NOT_FRESH', 1800) }));
  } else if (now < effectiveAt) {
    blockers.push(blocker('NOTICE_NOT_ELAPSED', 'wait', `notice elapses in ${effectiveAt - now} s`,
      { waitSecs: effectiveAt - now, escalateAfterSecs: null, effectiveAt }));
  }

  if (vault.paused) {
    blockers.push(blocker('VAULT_PAUSED', 'blocked', 'the book vault is paused (VaultPaused); only governance unpauses',
      { escalateAfterSecs: escalateSecs(policy, 'VAULT_PAUSED', 0) }));
  }

  const row = snapshot.portfolioRow ?? null;
  const pools = poolIndex(snapshot.pools);
  const legs = row ? legSet(snapshot, pending) : null;
  if (!legs) {
    blockers.push(blocker('BOOK_NOT_FRESH', 'wait',
      'portfolio row unavailable (api unreachable): legs and price state unknown',
      { waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'BOOK_NOT_FRESH', 1800) }));
  } else {
    for (const leg of legs) {
      // The program's exemption: an omitted position with nothing in custody and
      // no unwind in flight is retired without looking at its pool at all.
      const omitted = leg.inNewSet === false;
      const retirable = omitted && leg.custody === 0n && leg.unwindPending === false;
      if (retirable) continue;
      const unwindUnknown = omitted && leg.custody === 0n && leg.unwindPending == null;

      const pool = pools?.get(leg.poolId) ?? null;
      if (!pool) {
        blockers.push(blocker('LEG_STALE', 'wait',
          `${leg.poolId}: ${pools ? 'no catalogue row' : 'catalogue unavailable'} — pool state unknown`,
          { poolId: leg.poolId, waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'LEG_STALE', 1800) }));
        continue;
      }
      if (pool.status !== 'active') {
        const reason = leg.inNewSet ? 'PoolNotActive' : 'RequiredPoolPaused';
        blockers.push(blocker('LEG_NOT_ACTIVE', unwindUnknown ? 'escalate' : 'blocked',
          unwindUnknown
            ? `${pool.symbol ?? leg.poolId} is ${pool.status} and omitted with empty custody, but its unwind state is unknown; confirm no unwind is pending, then force POST /apply`
            : `${pool.symbol ?? leg.poolId} is ${pool.status} (${reason}); cancel and re-propose without it`,
          { poolId: leg.poolId, status: pool.status, escalateAfterSecs: escalateSecs(policy, 'LEG_NOT_ACTIVE', 0) }));
        continue;
      }
      const parked = pool.pendingPrice != null || pool.priceState === 'pending_acceptance';
      if (parked) {
        const pyth = Boolean(pool.pythFeedId);
        blockers.push(blocker('LEG_PENDING_PRICE', pyth ? 'wait' : 'escalate',
          pyth
            ? `${pool.symbol ?? leg.poolId} has a parked mark (PoolPricePending); Pyth-cranked, the oracle accepts it within minutes`
            : `${pool.symbol ?? leg.poolId} has a parked mark (PoolPricePending); publisher-marked, nobody cranks it — a human must accept or reject`,
          {
            poolId: leg.poolId,
            source: pyth ? 'pyth' : 'publisher',
            ...(pyth ? { waitSecs: tickSecs } : {}),
            escalateAfterSecs: escalateSecs(policy, pyth ? 'LEG_PENDING_PRICE_PYTH' : 'LEG_PENDING_PRICE_PUBLISHER', pyth ? 600 : 0),
          }));
        continue;
      }
      if (pool.priceState !== 'fresh') {
        blockers.push(blocker('LEG_STALE', 'wait',
          `${pool.symbol ?? leg.poolId} mark is ${pool.priceState ?? 'unknown'} (PoolPriceStale); the keeper cranks within 600 s`,
          { poolId: leg.poolId, priceState: pool.priceState ?? null, waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'LEG_STALE', 1800) }));
      }
    }
  }

  // Book mark: the program's own staleness rule first (vault clock vs its
  // window), then the api's view for anything the chain cannot see (a quiet
  // book reads 'inactive'). A parked book mark is its own blocker below.
  const lastMark = num(vault.lastPriceUpdateTimestamp);
  const maxStale = num(vault.maxPriceStalenessSecs);
  const chainStale = lastMark == null || maxStale == null ? true : now - lastMark > maxStale;
  const rowState = row?.priceState ?? null;
  const rowStale = row ? !(rowState === 'fresh' || rowState === 'pending_acceptance' || rowState === 'paused') : false;
  if (chainStale || rowStale) {
    const ageSecs = lastMark == null ? null : now - lastMark;
    const refreshAfter = apply.refreshNavWhenBookStaleSecs ?? 900;
    const staleFor = ageSecs == null || maxStale == null ? null : ageSecs - maxStale;
    const refreshNav = staleFor != null && staleFor > refreshAfter && keeperOk(snapshot.health) === false;
    blockers.push(blocker('BOOK_NOT_FRESH', 'wait',
      chainStale
        ? `book mark is ${ageSecs ?? '?'} s old, window ${maxStale ?? '?'} s (PortfolioPriceStale); waiting for the keeper`
        : `book priceState is ${rowState}; waiting for the keeper`,
      { waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'BOOK_NOT_FRESH', 1800), ageSecs, refreshNav }));
  }
  if (vault.pendingPrice != null) {
    blockers.push(blocker('BOOK_PENDING_PRICE', 'wait',
      'book mark awaits acceptance (PortfolioPricePending); the oracle accepts or the operator rejects',
      { waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'BOOK_PENDING_PRICE', 1200) }));
  }

  const withdrawals = big(vault.totalWithdrawalsPending);
  if (withdrawals == null || withdrawals > 0n) {
    blockers.push(blocker('WITHDRAWALS_PENDING', 'wait',
      withdrawals == null
        ? 'total_withdrawals_pending unreadable'
        : `${withdrawals.toString()} shares queued for withdrawal (PendingWithdrawalsBlockTargets); the keeper fulfils FIFO`,
      { waitSecs: tickSecs, escalateAfterSecs: escalateSecs(policy, 'WITHDRAWALS_PENDING', 3600), pendingShares: withdrawals?.toString() ?? null }));
  }

  const nextPage = num(account.applyNextPage) ?? 0;
  if (nextPage !== 0) {
    const waitSlots = Math.max(apply.applyInFlightWaitSlots ?? 320, CHAIN_APPLY_MAX_SLOTS + 1);
    const started = num(snapshot.applyScratch?.startedSlot);
    const remaining = started != null && slot != null ? Math.max(0, started + waitSlots - slot) : waitSlots;
    blockers.push(blocker('APPLY_IN_FLIGHT', 'wait',
      `a paged apply stopped at page ${nextPage} (ApplyInFlight); page 0 is accepted again ${remaining} slots from now`,
      {
        waitSecs: Math.ceil(remaining * SECS_PER_SLOT),
        waitSlots: remaining,
        escalateAfterSecs: null,
        maxAttempts: apply.applyInFlightMaxAttempts ?? 3,
        nextPage,
      }));
  }

  if (snapshot.custody && pending.newSet) {
    for (const poolId of pending.newSet) {
      if (snapshot.custody[poolId] === false) {
        blockers.push(blocker('MISSING_CUSTODY', 'wait',
          `${poolId}: custody ATA missing (MissingCustodyForNewPool); the api prepends create_custody — confirm it, retry once`,
          { poolId, waitSecs: tickSecs, escalateAfterSecs: null, retries: apply.missingCustodyRetries ?? 1 }));
      }
    }
  }

  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}

/**
 * Chain-state blockers before a propose that are not policy, mirroring
 * `validate_proposal` in order: CompositionLocked → COMPOSITION_LOCKED,
 * WrongPortfolioState → WRONG_PORTFOLIO_STATE, TargetsChangePending →
 * TARGETS_PENDING, RebalanceTooSoon (now − last_rebalance_at <
 * rebalance_delay_secs, the on-chain floor; the 7-day cadence is policy's
 * PROPOSAL_TOO_SOON) → REBALANCE_TOO_SOON; then the README's APPLY_IN_FLIGHT
 * and VAULT_PAUSED, which the program does not check at propose time but
 * which make the proposal un-applyable. Same blocker shape as applyGates,
 * always 'blocked'.
 * @param {object} snapshot
 * @param {object} policy
 * @param {number} now unix secs
 * @returns {{ ok: true } | { ok: false, blockers: Array<object> }}
 */
export function proposeGates(snapshot, policy, now) {
  const account = snapshot?.portfolioAccount;
  const vault = snapshot?.vaultAccount;
  if (!account || !vault) throw new Error('preflight: portfolioAccount and vaultAccount are required');
  const blockers = [];
  const blocked = (code, message, extra) => blockers.push(blocker(code, 'blocked', message, { escalateAfterSecs: 0, ...extra }));

  if (account.compositionLocked) {
    blocked('COMPOSITION_LOCKED', 'composition_locked is set (CompositionLocked): this portfolio never rebalances');
  }
  const state = variant(account.state);
  if (state !== 'live') {
    blocked('WRONG_PORTFOLIO_STATE', `portfolio state is ${state ?? 'unknown'}, not live (WrongPortfolioState)`, { state });
  }
  if (account.pendingTargets) {
    const effectiveAt = num(account.pendingTargets.effectiveAt);
    blocked('TARGETS_PENDING', `a targets change is already pending (TargetsChangePending), effective at ${effectiveAt ?? '?'}; cancel it first`, { effectiveAt });
  }
  const last = num(account.lastRebalanceAt);
  const delay = num(account.rebalanceDelaySecs);
  if (last == null || delay == null) {
    blocked('REBALANCE_TOO_SOON', 'last_rebalance_at or rebalance_delay_secs unreadable');
  } else if (now - last < delay) {
    blocked('REBALANCE_TOO_SOON', `last rebalance ${now - last} s ago, delay ${delay} s (RebalanceTooSoon); ready at ${last + delay}`, { readyAt: last + delay });
  }
  const nextPage = num(account.applyNextPage) ?? 0;
  if (nextPage !== 0) {
    blocked('APPLY_IN_FLIGHT', `a paged apply stopped at page ${nextPage}; let it finish or expire before proposing`, { nextPage });
  }
  if (vault.paused) {
    blocked('VAULT_PAUSED', 'the book vault is paused; a proposal could not be applied');
  }
  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}

/**
 * The every-tick invariants: curator == expected, pending_curator == None,
 * rebalance_delay_secs == expected, accountant.recipient1 == treasury,
 * factory.guardian == expected, composition_locked == false. Any drift makes
 * the loop self-lock every write until an operator unlocks.
 *
 * An optional account that could not be read (`accountantAccount`,
 * `factoryConfig` at `null`) is not drift — a transient RPC failure must not
 * need an operator unlock — but it is not proof either: those invariants are
 * listed under `unverified` so the loop can hold writes and alert.
 * @param {object} snapshot
 * @param {{ expectedCurator: string, treasury: string, guardian: string, rebalanceDelaySecs: number }} config
 * @param {object} policy `invariants.*` overrides the expected delay / lock flag
 * @returns {{ ok: true, unverified: string[] } | { ok: false, drift: Array<{ invariant: string, expected: string, actual: string }>, unverified: string[] }}
 */
export function checkInvariants(snapshot, config, policy) {
  const account = snapshot?.portfolioAccount;
  if (!account) throw new Error('preflight: portfolioAccount is required');
  const expectations = policy?.invariants ?? {};
  const drift = [];
  const unverified = [];
  const check = (invariant, expected, actual) => {
    if (String(expected) !== String(actual)) drift.push({ invariant, expected: String(expected), actual: String(actual) });
  };

  check('portfolio.curator', config.expectedCurator, b58(account.curator));
  if (expectations.pendingCuratorMustBeNone !== false) {
    check('portfolio.pendingCurator', 'null', b58(account.pendingCurator) ?? 'null');
  }
  check('portfolio.rebalanceDelaySecs', expectations.rebalanceDelaySecs ?? config.rebalanceDelaySecs, num(account.rebalanceDelaySecs));
  check('portfolio.compositionLocked', expectations.compositionLocked ?? false, Boolean(account.compositionLocked));

  if (snapshot.accountantAccount) {
    check('accountant.recipient1', config.treasury, b58(snapshot.accountantAccount.recipient1));
  } else {
    unverified.push('accountant.recipient1');
  }
  if (snapshot.factoryConfig) {
    check('factory.guardian', config.guardian, b58(snapshot.factoryConfig.guardian));
  } else {
    unverified.push('factory.guardian');
  }
  return drift.length === 0 ? { ok: true, unverified } : { ok: false, drift, unverified };
}

let chainLib = null;
/** The chain package, loaded once and only by the impure path so the gates stay import-free. */
async function loadChainLib() {
  chainLib ??= await import('@composable-portfolios/chain');
  return chainLib;
}

/**
 * REST + chain reads into the README §4.2 snapshot. An optional read that
 * fails leaves its field `null` (gates treat `null` as unknown ⇒ wait);
 * `portfolioAccount` and `vaultAccount` are required and their absence throws.
 *
 * The portfolio, vault and accountant keys come from the api row; the last
 * good set is cached in `ctx.state.snapshotKeys` so an api outage still lets
 * the loop read the chain (the mint alone cannot derive the vault PDA).
 * Tests inject `ctx.chain.lib` — the same names the chain package exports —
 * because a real `fetchDecoded` needs Borsh bytes, not fixtures.
 * @param {object} ctx README §4.1
 * @returns {Promise<object>} snapshot
 */
export async function readSnapshot(ctx) {
  const at = Math.floor(ctx.now() / 1000);
  const lib = ctx.chain.lib ?? await loadChainLib();
  const { connection } = ctx.chain;
  const { PublicKey } = await import('@solana/web3.js');
  const warn = (read, error) => ctx.log?.('warn', 'snapshot_read_failed', { read, error: error?.message ?? String(error) });
  const optional = async (name, fn) => {
    try {
      return await fn();
    } catch (error) {
      warn(name, error);
      return null;
    }
  };

  const [slot, portfolioRow, pools, health] = await Promise.all([
    optional('slot', () => connection.getSlot()),
    optional('portfolio', () => ctx.client.portfolio(ctx.config.mint)),
    optional('pools', () => ctx.client.pools()),
    optional('health', () => ctx.client.health()),
  ]);

  const keys = portfolioRow
    ? { portfolio: portfolioRow.portfolio, vaultKey: portfolioRow.vaultKey, accountant: portfolioRow.accountant ?? null }
    : (ctx.state?.snapshotKeys ?? null);
  if (!keys?.portfolio || !keys?.vaultKey) {
    throw new Error('snapshot: portfolio keys unknown (api unreachable and nothing cached)');
  }
  if (ctx.state) ctx.state.snapshotKeys = keys;

  const [portfolioAccount, vaultAccount] = await Promise.all([
    lib.fetchDecoded(connection, 'portfolio_factory', 'Portfolio', keys.portfolio),
    lib.fetchDecoded(connection, 'stoken', 'VaultConfig', keys.vaultKey),
  ]);
  if (!portfolioAccount) throw new Error('snapshot: Portfolio account unreadable');
  if (!vaultAccount) throw new Error('snapshot: VaultConfig account unreadable');

  const accountantKey = keys.accountant ?? b58(portfolioAccount.accountant);
  const [accountantAccount, factoryConfig] = await Promise.all([
    optional('accountant', () => (accountantKey ? lib.fetchDecoded(connection, 'accountant', 'Accountant', accountantKey) : null)),
    optional('factoryConfig', () => lib.fetchDecoded(connection, 'portfolio_factory', 'FactoryConfig', lib.factoryConfigKey())),
  ]);
  const applyScratch = (num(portfolioAccount.applyNextPage) ?? 0) !== 0 && typeof lib.applyScratchPda === 'function'
    ? await optional('applyScratch', () => lib.fetchDecoded(connection, 'portfolio_factory', 'ApplyScratch', lib.applyScratchPda(new PublicKey(keys.portfolio))))
    : null;

  const signerKey = new PublicKey(ctx.signer.wallet);
  const lamports = await optional('lamports', () => connection.getBalance(signerKey));
  const usdcMint = factoryConfig?.underlyingMint ?? vaultAccount.underlyingMint ?? health?.underlyingMint ?? null;
  const balances = await optional('balances', async () => {
    if (!usdcMint) return null;
    const atas = [
      lib.associatedTokenAddress(new PublicKey(b58(usdcMint)), signerKey),
      lib.associatedTokenAddress(new PublicKey(ctx.config.mint), signerKey),
    ];
    return lib.tokenBalanceMany(connection, atas);
  });

  return {
    at,
    slot,
    portfolioRow,
    portfolioAccount,
    vaultAccount,
    accountantAccount,
    factoryConfig,
    applyScratch,
    pools,
    health,
    pendingUnwinds: Array.isArray(portfolioRow?.pendingUnwinds) ? portfolioRow.pendingUnwinds : null,
    custody: null,
    signer: {
      lamports,
      usdcBaseUnits: balances ? balances[0].toString() : null,
      shares: balances ? balances[1].toString() : null,
    },
  };
}
