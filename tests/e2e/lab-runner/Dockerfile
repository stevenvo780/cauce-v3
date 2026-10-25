# Runner for e2e suites inside the docker-lab VM (scripts/e2e-lab.sh). The suites start their own PostgreSQL,
# gateway and Chromium containers and bind-mount sockets they create: the runner has to live on the same daemon
# and filesystem as those containers, so it runs in the VM instead of behind a forwarded socket.
FROM docker.io/library/docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli

FROM docker.io/library/node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client openssl procps python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN npm install --global --no-audit --no-fund pnpm@11.8.0
