FROM docker.io/library/docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli
# trixie: the release tooling needs Python >= 3.12 (tarfile extraction filters); tmux and jq are driven by the CLI suites.
FROM docker.io/library/node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
# Provider-login fixtures compile a static launcher and use the host Node path.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc git jq libc6-dev openssh-client openssl procps python3 tmux && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# The release tooling runs /usr/bin/docker by absolute path, as on the real hosts.
RUN ln -s /usr/local/bin/docker /usr/bin/docker && ln -s /usr/local/bin/node /usr/bin/node && npm install --global --no-audit --no-fund pnpm@11.8.0
