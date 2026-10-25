ARG CLI_IMAGE
ARG BASE_IMAGE=cauce-c7-openclaw-real:2026.7.1-2
FROM ${CLI_IMAGE} AS dockercli
FROM ${BASE_IMAGE}
USER root
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd dbus-user-session uuid-runtime && rm -rf /var/lib/apt/lists/*
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
