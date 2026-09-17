// Builders for the weavr rows the curator CLI reads: catalogue pools and a
// portfolio row with targets and holdings. Every key is Keypair.generate()
// by the test that uses it; nothing here is real.
export function poolRow(symbol, overrides = {}) {
  return {
    poolId: `${symbol}@solana`,
    symbol,
    asset: symbol.replace(/^p/, ''),
    chain: 'solana',
    status: 'active',
    riskTier: 2,
    maxWeightBps: 6000,
    maxExecutionLossBps: 50,
    trailingYieldBps: 120,
    priceState: 'fresh',
    pythFeedId: `0x${symbol.toLowerCase()}feed`,
    tvlUsdc: 250000,
    ...overrides,
  };
}

/** The catalogue the tests use: enough for both presets plus one symbol on neither allowlist. */
export function catalogue() {
  return [
    poolRow('pSOL'),
    poolRow('pCBBTC'),
    poolRow('pJITOSOL'),
    poolRow('pUSDS'),
    poolRow('pUSDT'),
    poolRow('pHYPE', { riskTier: 4 }),
    poolRow('pXAUT', { chain: 'ethereum', poolId: 'pXAUT@ethereum' }),
  ];
}

/** A portfolio row; `legs` is `[[symbol, weightBps], ...]`. */
export function portfolioRow({ mint, symbol = 'CLAWA1', name = 'Claw Alpha One', creator, curator, pendingCurator = null, feeRecipient, rebalanceDelaySecs = 60, legs = [['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]] }) {
  const pools = catalogue();
  const targets = legs.map(([s, weightBps]) => ({ poolId: pools.find((p) => p.symbol === s)?.poolId ?? `${s}@solana`, weightBps }));
  return {
    mint,
    portfolio: `${mint.slice(0, 8)}portfolio`,
    name,
    symbol,
    state: 'live',
    creator,
    curator,
    accountant: `${mint.slice(0, 8)}accountant`,
    feeRecipient,
    pendingFeeRecipient: null,
    pendingCurator,
    compositionLocked: false,
    creatorFeeBps: 20,
    driftBandBps: 200,
    idleTargetBps: 500,
    rebalanceDelaySecs,
    lastRebalanceAt: null,
    nextProposeAt: null,
    applyNextPage: 0,
    metadataUri: null,
    createdAt: '2026-09-01T00:00:00Z',
    price: 1.01,
    priceAsOf: '2026-09-17T09:00:00Z',
    priceState: 'fresh',
    pendingPrice: null,
    targets,
    holdings: {
      legs: targets.map((t, i) => ({ poolId: t.poolId, symbol: legs[i][0], targetWeightBps: t.weightBps, weightBps: t.weightBps, valueUsdc: t.weightBps / 100 })),
      idleWeightBps: 0,
    },
  };
}
