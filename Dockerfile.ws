# syntax=docker/dockerfile:1
################################################################
# aeolus-ws — y-websocket server with Postgres LISTEN/NOTIFY for
# compile-event fan-out. Built from the repo root:
#   docker build -f Dockerfile.ws .
################################################################
# Base images are pinned by digest (resolved 2026-09-13 from Docker Hub's
# manifest list; the tag beside the digest is documentation). Tectonic and
# Typst were already pinned by sha256; the base image is the larger surface.

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json turbo.json ./
COPY apps/ws/package.json apps/ws/
COPY apps/compile-worker/package.json apps/compile-worker/
COPY packages/db/package.json packages/db/
COPY packages/crdt/package.json packages/crdt/
COPY packages/auth/package.json packages/auth/
COPY packages/shared/package.json packages/shared/

# --prod drops every devDependency. tsx (the runtime entrypoint)
# is in dependencies on apps/ws so this layer keeps it.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile \
        --filter @aeolus/ws... \
        --prod

COPY packages/ packages/
COPY apps/compile-worker/ apps/compile-worker/
COPY apps/ws/ apps/ws/

################################################################
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# No database CA bundle is baked in. A managed Postgres reached over a network
# should be given one: mount your provider's root bundle into the container and
# set AEOLUS_DB_CA_FILE to it, with AEOLUS_DB_SSL=verify. The bundled compose
# stack keeps Postgres on a private network and sets AEOLUS_DB_SSL=disable.

RUN useradd --system --create-home --home-dir /home/ws --shell /usr/sbin/nologin ws \
    && mkdir -p /app && chown -R ws:ws /app

WORKDIR /app
COPY --from=deps --chown=ws:ws /repo /app

USER ws
# AEOLUS_PUBLIC_BASE_URL is the app's origin. The ws process checks the Origin
# header of every cookie-authenticated upgrade against it
# (apps/ws/src/server.ts), so set it at run time to the URL people actually
# visit. Left unset, upgrades are accepted from any origin and the process
# says so at boot.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    PATH="/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/ws
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["tsx", "src/bin/server.ts"]
