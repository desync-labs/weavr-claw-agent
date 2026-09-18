# @composable-portfolios/chain, the signer's subset

The weavr backend has one chain package shared by every service: it reads
the generated IDLs and the manifest, decodes accounts, builds the keeper's
and the oracle's instructions and wraps the RPC connection. The curator
signer imports ten names from it. This package serves those ten from six of
the backend's files, copied byte for byte, plus `src/subset.js`, which
restates one constant and two small functions whose home files (the keeper's
NAV crank and lookup-table builders) are not carried.

| Here | In the backend | Why |
|---|---|---|
| `src/chain.js` | `packages/chain/src/chain.js` | `connect`, `idlFor`, `programId`, `fetchDecoded`, `factoryConfigKey`, `tokenBalanceMany` |
| `src/spl.js` | `packages/chain/src/spl.js` | `associatedTokenAddress` |
| `src/confirm.js`, `src/rateLimit.js`, `src/metrics.js`, `src/prometheus.js` | the same paths | what `chain.js` imports |
| `src/subset.js` | `navCrank.js`, `lookupTable.js` | `PAGE_LEGS`, `applyScratchPda`, `readNavLookupTableAddress` |
| `../../deploy/manifest.json`, `../../deploy/idls/*.json` | `deploy/` | what `chain.js` reads three directories above itself |

`src/index.js` is this package's own: it re-exports the files above and
nothing else, so a name the signer starts using that the subset lacks fails
at import.

The backend stays the source. Nothing in the six mirrored files is edited
here; a change lands in the backend and is carried over by the ops repo's
`scripts/dev/sync_signer_chain.mjs`, whose `--check` is a CI gate there: the
six files, the manifest and the IDLs must be byte for byte the backend's, and
the three definitions in `subset.js` must give the backend's values
(`PAGE_LEGS`, the PDA of a fixed key, the lookup-table read under a fixed
environment). `SOURCE.json` records the backend commit the copy was taken
from.

`npm test` here proves the subset resolves in this layout: the ten names,
the five IDLs and the manifest, the factory's synthesised event table, and
the three carried values as they were on the day they were carried.
