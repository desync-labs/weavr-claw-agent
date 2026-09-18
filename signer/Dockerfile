# The curator signer image, published as intothefathom/curator-public by
# .github/workflows/signer.yml. Build context: this directory.
#
#   docker build -t curator-public:local signer
#
# The image carries the signer package, the chain subset it imports and
# deploy/ (the manifest and the five IDLs chain.js reads). It runs as root,
# like the backend image it replaces: the compose stack bind-mounts a 0600
# key file owned by the host user, which a fixed unprivileged uid could not
# read on every host.
FROM node:20-bookworm-slim

# tini is PID 1: it reaps zombies and forwards SIGTERM/SIGINT to node; the
# signer stops its loop and closes its server on either.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY deploy ./deploy
RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production
EXPOSE 8091

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/curator/bin/start.mjs"]
