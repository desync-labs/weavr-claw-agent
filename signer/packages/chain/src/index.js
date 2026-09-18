/**
 * What `@composable-portfolios/chain` means inside the signer image. The
 * backend's index re-exports fifteen modules; the signer imports ten names,
 * and this index serves them from the six files the mirror carries plus
 * `subset.js`. A name the signer starts using that is not here is an import
 * error at boot, never a silent fallback.
 */
export * from './chain.js';
export * from './spl.js';
export * from './confirm.js';
export * from './rateLimit.js';
export * from './subset.js';
