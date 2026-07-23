FROM node:22.17.0-alpine3.22 AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ARG VITE_CAUCE_API_BASE=""
ARG VITE_CAUCE_DEV_AUTH="false"
ARG VITE_CAUCE_DEV_TENANT=""
ARG VITE_CAUCE_DEV_ALIAS=""
ENV VITE_CAUCE_API_BASE=${VITE_CAUCE_API_BASE} VITE_CAUCE_DEV_AUTH=${VITE_CAUCE_DEV_AUTH} \
    VITE_CAUCE_DEV_TENANT=${VITE_CAUCE_DEV_TENANT} VITE_CAUCE_DEV_ALIAS=${VITE_CAUCE_DEV_ALIAS}
RUN pnpm --filter @cauce/console build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
