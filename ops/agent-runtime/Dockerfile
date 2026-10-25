# The Muse bridge is supplied with --build-context musebridge=<ops/container-runtime>; empty by default.
FROM scratch AS musebridge
FROM scratch AS quotareaders

# Agent runtime of enrolled computers. The executor starts it as root with `sleep`, mounts the release read-only and
# runs the adapter as `node`; ops/scripts/build-host-release.sh pins each provider CLI it measures inside this image.
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Same versions as ops/cuotas/Dockerfile: bump both deliberately. Hard links are split in the same layer because the
# adapter refuses a pinned provider command with more than one link.
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.160.1
ARG GROK_VERSION=1.0.41
ARG OPENCLAW_VERSION=2026.7.1-2
ARG MUSE_VERSION=1.4.10-R6427.1
ARG MUSE_X86_LINUX_SHA256=decefc0fb33c48ee43419c3e72ac2dbc781743868611074c7292807f5960dfcf
ARG MUSE_AARCH64_LINUX_SHA256=2e5afa5e8560c1565185249af2d27b3e97aaf351d3d32275b8e410be702dce35
ARG MUSE_BRIDGE_SHA256=fc70c1d96a08abdc75e77ec90ba1a84a2134748691d9fa2ee675a09ca503ee84

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@xai-official/grok@${GROK_VERSION}" \
      "openclaw@${OPENCLAW_VERSION}" \
 && npm cache clean --force \
 && find /usr/local/lib/node_modules -type f -links +1 -exec sh -c 'cp -p "$1" "$1.single" && mv "$1.single" "$1"' sh {} \; \
 && claude --version | grep -q "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -q "${CODEX_VERSION}" \
 && grok --version | grep -q "${GROK_VERSION}" \
 && openclaw --version | grep -q "${OPENCLAW_VERSION}" \
 && printf '%s  %s\n' '3ef2fa38f32ce786f0bc499bae897aba68ad9c7595ef3064994b1634d13d1373' \
      /usr/local/lib/node_modules/openclaw/dist/auth-list-DlV7Wk-6.js | sha256sum -c -

# Muse: same pinned binary and digests as ops/cuotas/Dockerfile, installed
# directly as /usr/local/bin/muse (the bash launcher would break the login
# process identity check); its digest is verified before anything runs.
RUN case "$(uname -m)" in \
      x86_64) file=muse-x86-linux; expected=${MUSE_X86_LINUX_SHA256} ;; \
      aarch64) file=muse-aarch64-linux; expected=${MUSE_AARCH64_LINUX_SHA256} ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/bin/muse \
      "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${MUSE_VERSION}&file=${file}" \
 && echo "${expected}  /usr/local/bin/muse" | sha256sum -c - \
 && chmod 0555 /usr/local/bin/muse \
 && muse --version | grep -q "${MUSE_VERSION}"

# The Muse bridge (ops/container-runtime/muse-cauce) is the approved harness
# command inside this image; it must arrive through the musebridge context.
COPY --from=musebridge / /tmp/muse-bridge/
RUN if [ ! -f /tmp/muse-bridge/muse-cauce ]; then \
      echo "muse bridge is not installed in this image: rebuild with --build-context musebridge=<ops/container-runtime>" >&2; exit 1; \
    fi \
 && install -m 0555 /tmp/muse-bridge/muse-cauce /usr/local/bin/muse-cauce \
 && printf '%s  %s\n' "${MUSE_BRIDGE_SHA256}" /usr/local/bin/muse-cauce | sha256sum -c - \
 && rm -rf /tmp/muse-bridge

COPY --from=quotareaders --chmod=0555 /leer-cuota.mjs /leer-cuota-grok.mjs /codex-http-probe.py /usr/local/bin/

USER node
WORKDIR /home/node
ENV HOME=/home/node
CMD ["sleep", "infinity"]
