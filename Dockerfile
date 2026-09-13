# syntax=docker/dockerfile:1

# --------------------------------------------------------------------------
# Stage 1: install production dependencies only.
# node:22-bookworm-slim carries glibc, so argon2 installs from a prebuilt
# binary; build-essential is present as a fallback for architectures without
# one and is thrown away with this stage.
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# --------------------------------------------------------------------------
# Stage 2: the runtime image.
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=40437 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY migrations ./migrations
COPY seeds ./seeds
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Uploads are written at runtime and are the only writable path in the image.
RUN mkdir -p /app/public/uploads \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chown -R node:node /app/public/uploads

USER node

EXPOSE 40437

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:40437/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
