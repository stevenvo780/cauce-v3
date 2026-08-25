ARG CAUCE_NODE_BASE=node:22.17.0-alpine3.22
ARG CAUCE_SCHEMA_COMPATIBLE_THROUGH=029_reconcile_declared_fleet.sql
FROM ${CAUCE_NODE_BASE} AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/store/package.json ./packages/store/
COPY packages/adapter-sdk/package.json packages/adapter-sdk/tsconfig.json ./packages/adapter-sdk/
COPY packages/mcp-fleet-monitor/package.json packages/mcp-fleet-monitor/tsconfig.json ./packages/mcp-fleet-monitor/
COPY services/gateway/package.json ./services/gateway/
COPY services/dispatcher/package.json services/dispatcher/tsconfig.json ./services/dispatcher/
COPY services/relay-worker/package.json ./services/relay-worker/
COPY services/shadow-router/package.json ./services/shadow-router/
COPY services/telegram-bridge/package.json ./services/telegram-bridge/
COPY services/terminal-relay/package.json ./services/terminal-relay/
COPY apps/console/package.json apps/console/tsconfig*.json ./apps/console/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY services ./services
COPY apps/console ./apps/console
COPY vitest.config.ts ./
ARG VITE_CAUCE_API_BASE=""
ARG VITE_CAUCE_DEV_AUTH="false"
ARG VITE_CAUCE_DEV_TENANT=""
ARG VITE_CAUCE_DEV_ALIAS=""
ENV VITE_CAUCE_API_BASE=${VITE_CAUCE_API_BASE} \
    VITE_CAUCE_DEV_AUTH=${VITE_CAUCE_DEV_AUTH} \
    VITE_CAUCE_DEV_TENANT=${VITE_CAUCE_DEV_TENANT} \
    VITE_CAUCE_DEV_ALIAS=${VITE_CAUCE_DEV_ALIAS}
RUN pnpm build:core && pnpm build:adapter && pnpm build:console

FROM ${CAUCE_NODE_BASE} AS production-dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/store/package.json ./packages/store/
COPY packages/adapter-sdk/package.json ./packages/adapter-sdk/
COPY services/gateway/package.json ./services/gateway/
COPY services/dispatcher/package.json ./services/dispatcher/
COPY services/relay-worker/package.json ./services/relay-worker/
COPY services/shadow-router/package.json ./services/shadow-router/
COPY services/telegram-bridge/package.json ./services/telegram-bridge/
COPY services/terminal-relay/package.json ./services/terminal-relay/
RUN pnpm --filter @cauce/protocol \
  --filter @cauce/store \
  --filter @cauce/adapter-sdk \
  --filter @cauce/gateway \
  --filter @cauce/dispatcher \
  --filter @cauce/relay-worker \
  --filter @cauce/shadow-router \
  --filter @cauce/telegram-bridge \
  --filter @cauce/terminal-relay \
  install --prod --frozen-lockfile --ignore-scripts

FROM ${CAUCE_NODE_BASE} AS runtime
ARG CAUCE_SCHEMA_COMPATIBLE_THROUGH
LABEL io.cauce.schema.compatible-through=${CAUCE_SCHEMA_COMPATIBLE_THROUGH}
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache python3 \
  && mkdir -p /var/lib/cauce-adapter /var/lib/cauce-terminal \
  && chown node:node /var/lib/cauce-adapter /var/lib/cauce-terminal
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/packages ./packages
COPY --from=production-dependencies --chown=node:node /app/services ./services
COPY --from=build --chown=node:node /app/dist/services/gateway/src ./services/gateway/dist
COPY --from=build --chown=node:node /app/dist/services/dispatcher/src ./services/dispatcher/dist
COPY --from=build --chown=node:node /app/dist/services/relay-worker/src ./services/relay-worker/dist
COPY --from=build --chown=node:node /app/dist/services/shadow-router/src ./services/shadow-router/dist
COPY --from=build --chown=node:node /app/dist/services/telegram-bridge/src ./services/telegram-bridge/dist
COPY --from=build --chown=node:node /app/dist/services/terminal-relay/src ./services/terminal-relay/dist
COPY --from=build --chown=node:node /app/dist/packages/store/src ./packages/store/dist
COPY --from=build --chown=node:node /app/packages/store/migrations ./packages/store/migrations
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist/src ./packages/adapter-sdk/dist/src
COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist/bridge ./packages/adapter-sdk/dist/bridge
RUN chmod -R 0555 ./packages/adapter-sdk/dist/bridge
COPY --chown=node:node deploy/runtime-store.package.json ./packages/store/package.json
COPY --chown=node:node deploy/readiness-probe.mjs deploy/unix-readiness-probe.mjs deploy/postgres-tls.mjs deploy/migrate.mjs deploy/migration-integrity.mjs deploy/schema-version.mjs deploy/fleet-snapshot.mjs deploy/outbox-metrics.mjs deploy/outbox-metrics-core.mjs deploy/reconcile-stale-console-outbox.mjs deploy/reconcile-stale-console-outbox-core.mjs deploy/shadow-guard.mjs deploy/runtime-package-smoke.mjs ./deploy/
COPY --chown=node:node deploy/runtime-entrypoint.sh ./deploy/runtime-entrypoint.sh
RUN chmod 0555 ./deploy/runtime-entrypoint.sh
USER node
RUN node deploy/runtime-package-smoke.mjs
STOPSIGNAL SIGTERM
EXPOSE 8080 8082 8083 8084 8085 8086 8443 8445 8446
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "deploy/readiness-probe.mjs", "http://127.0.0.1:8081/health/ready", "ready"]
CMD ["node", "services/gateway/dist/main.js"]

FROM runtime AS qa-runtime
USER root
COPY --chown=node:node ops/harness/runner.mjs ./ops/harness/runner.mjs
RUN ln -s ../packages/adapter-sdk/node_modules/ws node_modules/ws
USER node
CMD ["node", "ops/harness/runner.mjs", "--live"]

FROM runtime AS authentic-harness
USER root
COPY --chown=node:node ops/harness/authentic-fixture-init.mjs ops/harness/authentic-external-server.mjs ops/harness/authentic-unix-target.mjs ./ops/harness/
RUN ln -s ../packages/adapter-sdk/node_modules/ws node_modules/ws
USER node
CMD ["node", "ops/harness/authentic-external-server.mjs"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS console-base
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
USER 101

FROM console-base AS console-dev
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

FROM console-base AS console
COPY deploy/nginx-console-tls.conf /etc/nginx/conf.d/default.conf
RUN chmod 0644 /etc/nginx/conf.d/default.conf
EXPOSE 8444
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/ || exit 1
