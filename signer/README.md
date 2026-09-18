# The weavr curator signer

The signer is the process that holds a curator key. It refuses under a
policy document, asks weavr's api to build each transaction, verifies the
built bytes against what it asked for, signs, sends through the api and
journals every write. The agent (Hermes, the Claw Agent fork) is its HTTP
client and never sees the key. `packages/curator/README.md` is the signer's
own page: environment, routes, refusal codes, the shapes it shares, the
tests. This page is about the workspace around it and the image.

```
signer/
  packages/curator/   the signer: src/, bin/start.mjs (the image entrypoint), scripts/create_portfolio.mjs, test/
  packages/chain/     @composable-portfolios/chain, the subset of the backend's chain package the signer imports (its README names the gate)
  deploy/             manifest.json (the program ids) and the five IDLs chain.js reads
  Dockerfile          the image; .github/workflows/signer.yml builds and publishes it
```

## The image

`intothefathom/curator-public` on Docker Hub, public, built from this
directory by the workflow on every push to `main` that touches `signer/`.
Three tags per build:

| Tag | Meaning |
|---|---|
| `<version>` | `package.json` `version` here; immutable: the workflow refuses to push a version that is already published, so a change to the signer that reaches `main` bumps it |
| `sha-<short>` | the commit built |
| `latest` | the newest build |

`curator/compose/curator.yml` pins the version tag as its default
`CURATOR_SIGNER_IMAGE`; `weavr-curator init` writes that default into
`compose.env`, and `weavr-curator doctor` accepts a tag the registry serves
as well as a local image. Pin the version tag on a real host; `latest` moves.

Locally: `docker build -t curator-public:local signer` from the repository
root, then set `CURATOR_SIGNER_IMAGE=curator-public:local` in `compose.env`.

The image runs as root, as the backend image it replaces did: the compose
stack bind-mounts a 0600 key file owned by the host user, which a fixed
unprivileged uid could not read on every host. The key is the only thing
the container reads that is not in the image or its environment.

## The key

Two ways in, and `bin/start.mjs` handles both:

- **A mounted file** (the compose stack): `CURATOR_KEYPAIR=/keys/curator.json`,
  the file bind-mounted read-only. Nothing else happens before boot.
- **The environment** (a Kubernetes deployment with the key in a secret):
  `CURATOR_KEYPAIR_JSON` holds the 64-byte JSON array. The entrypoint writes
  it to `$COMPOSABLE_PORTFOLIOS_KEY_DIR/solana/curator.json` (default
  `/app/.keydir`) at 0600, points `CURATOR_KEYPAIR` at it unless the
  deployment set that too, and removes the variable from Node's environment
  so no child inherits it. The kernel's record of the starting environment
  keeps it, as with any secret delivered that way; the compose stack's
  mounted file is the tighter of the two.

The value is never parsed, logged or printed here; `src/keys.js` judges it
once at boot and refuses with a reason that never quotes it.

## Tests

```bash
cd signer && npm ci && npm test     # both packages
node --test 'test/*.test.js'        # inside a package (Node 24: quote the glob)
```

Three of the signer's suites are not in this repository. `decode`, `create`
and `integration.contract` verify the decoder and the create CLI against
transactions the weavr api's real builders produce, and those builders are
private. They live in the backend as the api's curator contract suite and
run against this repository at the commit the backend pins, so a builder
change the decoder would refuse fails there before it ships.

The chain subset is mirrored, not maintained here: the ops repo's
`scripts/dev/sync_signer_chain.mjs --check` fails when a mirrored file, the
manifest or an IDL differs from the backend's, or when one of the three
hand-carried definitions in `packages/chain/src/subset.js` gives a different
value. An edit to those files is made in the backend and carried over.
