FROM docker.io/library/node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates dbus dbus-user-session docker-cli docker.io iproute2 openssl \
      procps python3 python3-yaml systemd systemd-sysv util-linux \
    && command -v docker && command -v dockerd \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1500 --shell /bin/bash --groups docker cauce \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && systemctl enable docker.service containerd.service \
    && mkdir -p /etc/docker \
    && printf '%s\n' '{"default-address-pools":[{"base":"10.240.0.0/16","size":24}],"bip":"10.241.0.1/24","log-driver":"local"}' > /etc/docker/daemon.json
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
