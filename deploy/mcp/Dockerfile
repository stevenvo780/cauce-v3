ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819

FROM ${CAUCE_NODE_BASE} AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/store/package.json ./packages/store/
COPY packages/mcp-fleet-monitor/package.json packages/mcp-fleet-monitor/tsconfig.json ./packages/mcp-fleet-monitor/
RUN pnpm install --ignore-scripts --frozen-lockfile --filter @cauce/mcp-fleet-monitor...

COPY packages/protocol/src ./packages/protocol/src
COPY packages/store/src ./packages/store/src
COPY packages/mcp-fleet-monitor/src ./packages/mcp-fleet-monitor/src
COPY tests/terminal-pty/certs.mjs ./tests/terminal-pty/certs.mjs
COPY tests/terminal-pty/certs.d.mts ./tests/terminal-pty/certs.d.mts
RUN pnpm --filter @cauce/protocol build \
  && pnpm --filter @cauce/mcp-fleet-monitor build

FROM ${CAUCE_NODE_BASE} AS production-dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/store/package.json ./packages/store/
COPY packages/mcp-fleet-monitor/package.json ./packages/mcp-fleet-monitor/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
  --filter @cauce/mcp-fleet-monitor...

FROM ${CAUCE_NODE_BASE} AS runtime
ARG CAUCE_RELEASE_COMMIT
ARG CAUCE_SOURCE_DIGEST
ENV NODE_ENV=production
RUN node -e 'const [revision, digest] = process.argv.slice(1); if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) process.exit(1)' "$CAUCE_RELEASE_COMMIT" "$CAUCE_SOURCE_DIGEST"
LABEL org.opencontainers.image.revision=${CAUCE_RELEASE_COMMIT} \
  io.cauce.source.digest=${CAUCE_SOURCE_DIGEST}
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/mcp-fleet-monitor/dist ./packages/mcp-fleet-monitor/dist
COPY --chown=node:node deploy/mcp/healthcheck.mjs ./deploy/mcp/healthcheck.mjs
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "deploy/mcp/healthcheck.mjs"]
CMD ["node", "packages/mcp-fleet-monitor/dist/gateway-server.js"]
