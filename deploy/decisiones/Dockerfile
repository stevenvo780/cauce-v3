# Decisions service image: one bundled file plus the catalog, nothing else from the repo.
# Built from a `git archive` of one commit (see desplegar.sh), never from a live working tree.
ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819
FROM ${CAUCE_NODE_BASE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY console/package.json ./console/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@cauce/decisiones..."
RUN pnpm --filter @cauce/protocol build && pnpm --filter @cauce/decisiones build

FROM ${CAUCE_NODE_BASE} AS runtime
ARG CAUCE_NODE_BASE
ARG CAUCE_RELEASE_COMMIT=desconocido
LABEL org.opencontainers.image.revision=${CAUCE_RELEASE_COMMIT} \
  org.opencontainers.image.base.name=${CAUCE_NODE_BASE} \
  io.cauce.servicio=decisiones
ENV NODE_ENV=production
WORKDIR /app
# A fresh named volume copies this ownership, so the audit log is writable by uid 1000.
RUN mkdir -p /var/lib/cauce-decisiones && chown node:node /var/lib/cauce-decisiones
COPY --from=build --chown=node:node /app/services/decisiones/dist/decisiones.mjs ./dist/decisiones.mjs
COPY --from=build --chown=node:node /app/services/decisiones/catalogo ./catalogo
USER node
EXPOSE 8447
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8088/health/ready').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/decisiones.mjs"]
