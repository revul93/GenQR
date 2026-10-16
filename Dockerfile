# syntax=docker/dockerfile:1.7
#
# GenQR container image.
#
#   docker build -t genqr .
#   docker run -d --name genqr -p 3000:3000 -e ENCRYPTION_KEY=... \
#     -v genqr-data:/app/data -v genqr-config:/app/config --restart unless-stopped genqr
#
# The code is owned by root and read-only to the app, which runs as the unprivileged
# `node` user and writes only to the volumes (/app/data, /app/config, /app/logs, /app/backups).

ARG NODE_IMAGE=node:22-bookworm-slim

# --- Build: install everything, compile the server, bundle the client --------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

# --- Runtime dependencies: server only, no dev tools; plus the pinned database drivers ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# server/node_modules exists even when npm hoists everything, so the COPY below never fails.
RUN mkdir -p server/node_modules \
 && npm ci --omit=dev --workspace server --include-workspace-root --no-audit --no-fund \
 && npm cache clean --force
# PostgreSQL and MySQL/MariaDB drivers are baked in (versions from drivers.manifest.json), so
# switching databases needs no network access and nothing is installed at run time.
COPY drivers.manifest.json ./
RUN mkdir -p drivers && echo '{"name":"genqr-drivers","private":true}' > drivers/package.json \
 && node -e "const m=require('./drivers.manifest.json');console.log(['mysql','pg'].map(k=>m[k].package+'@'+m[k].version).join(' '))" \
    | xargs npm install --prefix drivers --save-exact --no-audit --no-fund --omit=dev \
 && npm cache clean --force

# --- Final image -----------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG GENQR_COMMIT=unknown
ARG GENQR_VERSION=0.0.0
LABEL org.opencontainers.image.title="GenQR" \
      org.opencontainers.image.description="Branded QR code generator with editable short links and click analytics" \
      org.opencontainers.image.source="https://github.com/revul93/GenQR" \
      org.opencontainers.image.revision="${GENQR_COMMIT}" \
      org.opencontainers.image.version="${GENQR_VERSION}"

ENV NODE_ENV=production \
    GENQR_ROOT=/app \
    GENQR_RUNTIME=container \
    GENQR_COMMIT=${GENQR_COMMIT} \
    # The app exits on purpose to restart (e.g. after a database switch); run the container
    # with a restart policy such as --restart unless-stopped.
    GENQR_SUPERVISED=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    # Trust X-Forwarded-* from private networks (a reverse-proxy container on the same Docker network).
    TRUST_PROXY="loopback, linklocal, uniquelocal" \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/drivers ./drivers
COPY --from=build /src/package.json /src/drivers.manifest.json ./
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/client/dist ./client/dist
COPY --from=build /src/config/database.example.json ./config/database.example.json
COPY scripts/docker-cli.sh /usr/local/bin/genqr

RUN chmod 0755 /usr/local/bin/genqr \
 && mkdir -p data config logs backups \
 && chown node:node data config logs backups \
 && chmod 0750 data config logs backups

USER node
VOLUME ["/app/data", "/app/config", "/app/logs", "/app/backups"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
