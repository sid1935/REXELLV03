# ReXell — one image, five entrypoints.
#
# The API, the vault and the three static surfaces all run from this image and
# differ only in the command. Building five near-identical images to save a few
# megabytes would cost more in drift than it saves in disk.
#
# node:24 because `node:sqlite` is used directly and unflagged.

# ─── build ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

# Manifests first, so a dependency install is only redone when a manifest
# changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY packages/biometrics/package.json packages/biometrics/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/gate/package.json packages/gate/
COPY packages/risk/package.json packages/risk/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
COPY apps/fan/package.json apps/fan/
COPY apps/scanner/package.json apps/scanner/
COPY apps/vault/package.json apps/vault/

# The contracts workspace pulls Hardhat and solc, which are large and are not
# needed to serve traffic. They come in here so the build can typecheck, and do
# not survive into the runtime stage.
RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts

RUN npm run build

# Drop to production dependencies for what gets copied forward.
RUN npm prune --omit=dev

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV REXELL_ENV=production

# Databases live on a volume mounted here, never in the image layer.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps apps

# Never root. A path traversal in a static server is a different kind of
# problem when the process can read /etc/shadow.
USER node

# Overridden per service in compose. The API is the sensible default.
CMD ["node", "apps/api/dist/server.js"]
