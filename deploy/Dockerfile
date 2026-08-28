ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819
ARG CAUCE_PYTHON_BASE=docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6
ARG CAUCE_NGINX_BASE=docker.io/nginxinc/nginx-unprivileged@sha256:28d91bdce70ad09025ea901458fdd149259d8e05982ade79d4ef2c0d9470eb48
ARG CAUCE_SCHEMA_COMPATIBLE_THROUGH=037_console_publish_intent_indexes.sql
ARG CAUCE_TERMINAL_RELAY_INSTANCE_ID=""
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
COPY services/telegram-bridge/package.json ./services/telegram-bridge/
COPY services/terminal-relay/package.json ./services/terminal-relay/
COPY console/package.json console/tsconfig*.json ./console/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY services ./services
COPY console ./console
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
COPY services/telegram-bridge/package.json ./services/telegram-bridge/
COPY services/terminal-relay/package.json ./services/terminal-relay/
RUN pnpm --filter @cauce/protocol \
  --filter @cauce/store \
  --filter @cauce/adapter-sdk \
  --filter @cauce/gateway \
  --filter @cauce/dispatcher \
  --filter @cauce/telegram-bridge \
  --filter @cauce/terminal-relay \
  install --prod --frozen-lockfile --ignore-scripts

FROM ${CAUCE_PYTHON_BASE} AS python-runtime

FROM ${CAUCE_NODE_BASE} AS runtime
ARG CAUCE_NODE_BASE
ARG CAUCE_PYTHON_BASE
ARG CAUCE_SCHEMA_COMPATIBLE_THROUGH
ARG CAUCE_SOURCE_DIGEST
ARG CAUCE_RELEASE_COMMIT
ARG CAUCE_TARGET_PLATFORM=linux/amd64
LABEL io.cauce.schema.compatible-through=${CAUCE_SCHEMA_COMPATIBLE_THROUGH} \
  io.cauce.source.digest=${CAUCE_SOURCE_DIGEST} \
  io.cauce.base.node.repository-digest=${CAUCE_NODE_BASE} \
  io.cauce.base.python.repository-digest=${CAUCE_PYTHON_BASE} \
  io.cauce.target-platform=${CAUCE_TARGET_PLATFORM} \
  org.opencontainers.image.revision=${CAUCE_RELEASE_COMMIT} \
  org.opencontainers.image.base.name=${CAUCE_NODE_BASE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=python-runtime /usr/local /usr/local
RUN python3 -c 'import asyncio, json; assert asyncio and json' \
  && mkdir -p /var/lib/cauce-adapter /var/lib/cauce-terminal \
  && chown node:node /var/lib/cauce-adapter /var/lib/cauce-terminal
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/packages ./packages
COPY --from=production-dependencies --chown=node:node /app/services ./services
COPY --from=build --chown=node:node /app/dist/services/gateway/src ./services/gateway/dist
COPY --from=build --chown=node:node /app/dist/services/dispatcher/src ./services/dispatcher/dist
COPY --from=build --chown=node:node /app/dist/services/telegram-bridge/src ./services/telegram-bridge/dist
COPY --from=build --chown=node:node /app/dist/services/terminal-relay/src ./services/terminal-relay/dist
COPY --from=build --chown=node:node /app/dist/packages/store/src ./packages/store/dist
COPY --from=build --chown=node:node /app/packages/store/migrations ./packages/store/migrations
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist/src ./packages/adapter-sdk/dist/src
COPY --from=build --chown=node:node /app/packages/adapter-sdk/dist/bridge ./packages/adapter-sdk/dist/bridge
RUN chmod -R 0555 ./packages/adapter-sdk/dist/bridge
COPY --chown=node:node deploy/runtime/runtime-store.package.json ./packages/store/package.json
COPY --chown=node:node deploy/runtime/readiness-probe.mjs deploy/runtime/local-readiness-probe.mjs deploy/runtime/unix-readiness-probe.mjs deploy/runtime/postgres-tls.mjs deploy/runtime/migrate.mjs deploy/runtime/migration-integrity.mjs deploy/runtime/schema-version.mjs deploy/runtime/fleet-snapshot.mjs deploy/runtime/outbox-metrics.mjs deploy/runtime/outbox-metrics-core.mjs deploy/runtime/release-state-metrics.mjs deploy/runtime/reconcile-stale-console-outbox.mjs deploy/runtime/reconcile-stale-console-outbox-core.mjs deploy/runtime/runtime-package-smoke.mjs ./deploy/
COPY --chown=node:node deploy/runtime/runtime-entrypoint.sh ./deploy/runtime-entrypoint.sh
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

FROM ${CAUCE_NGINX_BASE} AS console-base
ARG CAUCE_NGINX_BASE
ARG CAUCE_SOURCE_DIGEST
ARG CAUCE_RELEASE_COMMIT
ARG CAUCE_TARGET_PLATFORM=linux/amd64
LABEL io.cauce.source.digest=${CAUCE_SOURCE_DIGEST} \
  io.cauce.base.nginx.repository-digest=${CAUCE_NGINX_BASE} \
  io.cauce.console.publish-journal=multi-intent-v1 \
  io.cauce.target-platform=${CAUCE_TARGET_PLATFORM} \
  org.opencontainers.image.revision=${CAUCE_RELEASE_COMMIT} \
  org.opencontainers.image.base.name=${CAUCE_NGINX_BASE}
COPY --from=build /app/console/dist /usr/share/nginx/html
USER 101

FROM console-base AS console-dev
COPY console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

FROM console-base AS console
USER root
COPY deploy/console/nginx-console-tls.conf /etc/nginx/conf.d/default.conf
RUN chmod 0644 /etc/nginx/conf.d/default.conf
USER 101
USER root
ARG CAUCE_TERMINAL_RELAY_INSTANCE_ID
RUN case "${CAUCE_TERMINAL_RELAY_INSTANCE_ID}" in \
      ""|*[!0-9a-f]*|?????????????????????????????????????????????????????????????????*) \
        test -z "${CAUCE_TERMINAL_RELAY_INSTANCE_ID}" ;; \
      *) test "${#CAUCE_TERMINAL_RELAY_INSTANCE_ID}" -eq 64 ;; \
    esac \
 && sed -i "s/\${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/g" /etc/nginx/conf.d/default.conf
LABEL io.cauce.terminal-relay.instance-id=${CAUCE_TERMINAL_RELAY_INSTANCE_ID}
USER 101
EXPOSE 8444
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD test -r /run/secrets/console_tls_ca && SSL_CERT_FILE=/run/secrets/console_tls_ca wget -q -O /dev/null https://console:8444/ || exit 1
