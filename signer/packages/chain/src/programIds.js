/**
 * Production compile identity (ADR-0290). A signer image carries one id set.
 * Demo and the retired alpha cluster are FOREIGN_PROGRAM.
 */
export const PRODUCTION_PROGRAM_IDS = Object.freeze({
  stoken: 'DU83bnLZvD1GrRwXXYr5cGJ17RnZ1c7WJeNzxt3hh33r',
  accountant: 'AzVpJT7fWpnuFCTjkbtBi8P46zniPuAdMPtPL8g69wUn',
  asset_manager_escrow: 'Cay4w3Z3umsG7qUgTB55PT5N4tRsUvBY7LFseqErz6K',
  portfolio_factory: 'BJmFhsrASmQwSVMfBcPAPqEo9uSsW3EsTXjq2ALi4Zts',
  portfolio_allocator: 'Az9Mg3XFPPBimxHEYSSuEKpGXmohKEtcPnK6pkzCdh4D',
  portfolio_nav: 'GduZJt22NSJmdJ4yZdJjLb4QQXCVtzW86zALcGSddyXf',
  pyth_price_adapter: 'C34PzDzoMHYjPUUfgk5A7BAcuKPBtV81mX1CDcoqKQ4N',
  titan_adapter: '7PW4FpqwGa5T3tgUUGNzZLBKHBGP34GB6hrcBNj1aT78',
  jupiter_adapter: 'G7sny8vHv4YwWaMBYYg6oyHckwCBaTxsuftR1sDNNyZW',
  kamino_adapter: 'B7DFnGQUDM1zTVmGjuDkqDQHSjRYBNd26wAx7mwBy3CS',
  cctp_adapter: 'AtjgCQuvtCpzsGbN4uNyMieYkjsNy2ky5QVvyDcqnGJg',
});

export const DEMO_PROGRAM_IDS = Object.freeze([
  'CB1Tw9aB8ju66q9ZVcezyfCbwNJDVLAMn2RpU3K1tVn',
  'AUsqh1WMuRJqXAR4pc5JJ2PVp96a7WVnv4pq4Z5t2KV7',
  'GWVnx75Sk46CbMT6jPmY2dKnCeEM3G7MNWK2hCf3ePky',
  '84iktrtfvLZm5zD5puEPhVdYRWg8G7sJjqsLqnufDhAk',
  'GaJ8eAA2sDsUjU9Cy2di1vbTfc676o5McC48w1uAHorR',
  '2CwNQT3gDQ3c3iZCpofKGnC81FMwRAzbKHDEQZ3WQhjq',
  'GzwD9oA6x6BAyowmSGrW6n85bwUUR8kBukWyixui9A7u',
]);

export const RETIRED_ALPHA_PROGRAM_IDS = Object.freeze([
  '239NnyAR7QEEc3okZJSoUHa5aBQHdJdfpnYv3G2mA8qC',
  '4HC2woicNNFWEYJQ3ZW1B1wiHn6j6tPCDmg5neSWTyMw',
  'FCHR4tVk9877MAuG97BufC6p81cESvpwsqEouEkFpAKy',
  'ARUPnSxUoi3usbTUzQ1iD5HUQryjwS3M4X2mxt8ZiUpF',
  '3uAhHAngAj7fahZMCKNFB2N6dZ2PceVHQQJCVPc7iYvM',
  '46v6h2De7y3xDToKGj8auLkNSVRzL7QYLSi2ZrRKfsVY',
  '9qSmYegVmyuZRspJWcuVwsSfLRpa4WvQZA5YVe5Msk7H',
  '7jo3h9q8NzY4hbAFuG244pmVC7aiFpWFiJSXi6eZbSjE',
  'DsaEXwXDuZiz7ijXmJgr489PmDooVvwDyCkZnNQ9zyVX',
  '73oDFetcoQuer9CxrfCjw546i9rfwnUnJNVVkaHrXUTR',
  '7FbyZLsMLzkHG1B4VVzfHgqHEMf1gQBuZPTvo8gtn8SY',
]);

export function refuseForeignProgramId(id) {
  if (DEMO_PROGRAM_IDS.includes(id)) {
    throw new Error(`FOREIGN_PROGRAM: refusing demo program ${id}`);
  }
  if (RETIRED_ALPHA_PROGRAM_IDS.includes(id)) {
    throw new Error(`FOREIGN_PROGRAM: refusing retired alpha program ${id}`);
  }
}

export function assertProductionManifest(manifest) {
  if (manifest?.profile === 'demo' || manifest?.profile === 'alpha') {
    throw new Error(`FOREIGN_PROGRAM: refusing ${manifest.profile} program-id set`);
  }
  for (const repo of Object.values(manifest?.repos ?? {})) {
    for (const id of Object.values(repo.deployed_programs ?? {})) {
      refuseForeignProgramId(id);
    }
  }
}
