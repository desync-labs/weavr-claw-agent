/**
 * Spoken share counts → the 6-decimal integer `withdraw_request` expects.
 *
 * Chat and the wallet flag say "4 shares". The HTTP flow and the program
 * want 4_000_000. A value already ≥ 1 share in base units is left alone so
 * this helper is safe against both today's pass-through MCP and a later
 * converter (ADR-0255).
 */
export const SHARES_DECIMALS = 6;
export const ONE_SHARE = 10n ** BigInt(SHARES_DECIMALS);
export const PRICE_PRECISION = 1_000_000n;
/**
 * Factory default for `vault.min_shares_to_mint` (0.001 shares). The program
 * reads the vault at request time; this is the preflight that matches every
 * Weavr-created book unless governance later changed the vault.
 */
export const MIN_PARTIAL_SHARES = 1000n;

export function toFixedBase(display, decimals = SHARES_DECIMALS) {
  const text = String(display ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    const err = new Error('amount must be a positive number');
    err.code = 'USAGE';
    throw err;
  }
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) {
    const err = new Error(`amount has at most ${decimals} decimal places`);
    err.code = 'USAGE';
    throw err;
  }
  return String(BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((frac || '0').padEnd(decimals, '0')));
}

/** Dollars → share base units at a vault mark (`price` is 1e6 = $1). */
export function sharesFromUsd(amountUsd, price) {
  const usdc = BigInt(toFixedBase(amountUsd, SHARES_DECIMALS));
  const p = BigInt(price);
  if (usdc <= 0n) {
    const err = new Error('amount must be greater than 0');
    err.code = 'USAGE';
    throw err;
  }
  if (p <= 0n) {
    const err = new Error('the portfolio has no price yet');
    err.code = 'USAGE';
    throw err;
  }
  return usdc * PRICE_PRECISION / p;
}

export function usdFromShares(sharesBase, price) {
  return Number(BigInt(sharesBase) * BigInt(price)) / 1e12;
}

export function formatUsd(amount) {
  const n = Number(amount);
  if (Number.isFinite(n) && n !== 0 && Math.abs(n) < 0.01) {
    return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Size a dollar withdrawal so the vault will accept it. If the request is
 * the whole position, or would leave dust the holder cannot exit, take
 * everything — the user asked for bucks, not a leftover position.
 */
export function sizeUsdWithdraw(amountUsd, { held, price, minPartial = MIN_PARTIAL_SHARES }) {
  const position = BigInt(held);
  const p = BigInt(price);
  if (position <= 0n) return { ok: false, error: 'NO_SHARES', detail: 'this wallet holds nothing in that portfolio' };
  if (p <= 0n) return { ok: false, error: 'NO_PRICE', detail: 'the portfolio has no price yet' };
  let want;
  try { want = sharesFromUsd(amountUsd, p); }
  catch (e) { return { ok: false, error: 'USAGE', detail: e.message }; }
  const minUsd = usdFromShares(minPartial, p);
  if (want >= position) {
    return { ok: true, fullExit: true, sharesBase: String(position), amountUsd: usdFromShares(position, p) };
  }
  if (want < minPartial) {
    return {
      ok: false,
      error: 'BELOW_MINIMUM',
      detail: `the smallest withdrawal is about $${formatUsd(minUsd)} at this price`,
      minUsd,
    };
  }
  const remaining = position - want;
  if (remaining < minPartial) {
    return { ok: true, fullExit: true, snapped: true, sharesBase: String(position), amountUsd: usdFromShares(position, p) };
  }
  return { ok: true, fullExit: false, sharesBase: String(want), amountUsd: usdFromShares(want, p) };
}

export function parseSpokenShares(input) {
  const raw = String(input ?? '').trim();
  if (/^all$/i.test(raw)) return { kind: 'all' };
  if (raw.includes('.')) {
    const sharesBase = displayToBase(raw);
    if (BigInt(sharesBase) <= 0n) {
      const err = new Error('shares must be greater than 0');
      err.code = 'USAGE';
      throw err;
    }
    return { kind: 'base', sharesBase };
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    const err = new Error('--withdraw <ticker> --shares <count|all> [--min-out <usd>]');
    err.code = 'USAGE';
    throw err;
  }
  const n = BigInt(raw);
  return { kind: 'base', sharesBase: n >= ONE_SHARE ? raw : String(n * ONE_SHARE) };
}

/** "4.99" → "4990000". Rejects more than 6 decimal places. */
export function displayToBase(display) {
  const sharesBase = toFixedBase(display, SHARES_DECIMALS);
  if (BigInt(sharesBase) <= 0n) {
    const err = new Error('shares must be greater than 0');
    err.code = 'USAGE';
    throw err;
  }
  return sharesBase;
}

export function formatShares(base) {
  const n = BigInt(base);
  const whole = n / ONE_SHARE;
  const frac = n % ONE_SHARE;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(SHARES_DECIMALS, '0').replace(/0+$/, '')}`;
}

/**
 * A partial exit must redeem and leave at least `MIN_PARTIAL_SHARES`.
 * A full exit (remaining == 0) is always allowed.
 */
export function assertPartialExit(held, redeem) {
  const h = BigInt(held);
  const r = BigInt(redeem);
  if (h <= 0n) return { ok: false, error: 'NO_SHARES', detail: 'this wallet holds no shares in that portfolio' };
  if (r > h) {
    return {
      ok: false,
      error: 'INSUFFICIENT_SHARES',
      detail: `this wallet holds ${formatShares(h)} shares; asked for ${formatShares(r)}`,
    };
  }
  const remaining = h - r;
  if (remaining === 0n) return { ok: true };
  if (r < MIN_PARTIAL_SHARES || remaining < MIN_PARTIAL_SHARES) {
    return {
      ok: false,
      error: 'DUST',
      detail: `a partial exit must redeem at least ${formatShares(MIN_PARTIAL_SHARES)} shares and leave at least ${formatShares(MIN_PARTIAL_SHARES)} (you hold ${formatShares(h)}). Use --shares all to exit in full.`,
    };
  }
  return { ok: true };
}
