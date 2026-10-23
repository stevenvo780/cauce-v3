# Optional external Antigravity binary, supplied with
# --build-context agybin=<directory outside the repository>; empty by default.
FROM scratch AS agybin

FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# CLI versions are pinned: a floating tag would let the login/update contract
# drift between builds. Bump deliberately and rebuild instead.
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.160.1
ARG GROK_VERSION=1.0.41
ARG MUSE_VERSION=1.4.10-R6427.1
ARG MUSE_X86_LINUX_SHA256=decefc0fb33c48ee43419c3e72ac2dbc781743868611074c7292807f5960dfcf
ARG MUSE_AARCH64_LINUX_SHA256=2e5afa5e8560c1565185249af2d27b3e97aaf351d3d32275b8e410be702dce35
ARG AGY_VERSION=1.4.2
ARG AGY_X86_64_SHA256=085f43e0d0628a8a8dabe1e547067818fa2c0adc86cfac98a3c4492918f455ef

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@xai-official/grok@${GROK_VERSION}" \
 && npm cache clean --force \
 && claude --version | grep -q "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -q "${CODEX_VERSION}" \
 && grok --version | grep -q "${GROK_VERSION}" \
 && test ! -e /usr/local/bin/gemini \
 && test ! -d /usr/local/lib/node_modules/@google/gemini-cli

# Muse: the pinned binary comes from the public Meta channel manifest for
# MUSE_VERSION and is installed directly as /usr/local/bin/muse (the bash
# launcher would break the login process identity check); its digest is
# verified before anything runs.
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

# Antigravity (agy) has no pinned public package: supply the kratos binary in
# an external build context (--build-context agybin=<directory> holding
# agy-1.4.2-linux-x86-64, digest verified); without it the image carries a
# stub that fails every agy call.
COPY --from=agybin / /tmp/agy-bin/
RUN if [ -f /tmp/agy-bin/agy-${AGY_VERSION}-linux-x86-64 ]; then \
      echo "${AGY_X86_64_SHA256}  /tmp/agy-bin/agy-${AGY_VERSION}-linux-x86-64" | sha256sum -c - \
      && install -m 0555 "/tmp/agy-bin/agy-${AGY_VERSION}-linux-x86-64" /usr/local/bin/agy \
      && agy --version | grep -qx "${AGY_VERSION}"; \
    else \
      printf '%s\n' '#!/bin/sh' \
        'echo "agy is not installed in this image: rebuild with --build-context agybin=<directory holding agy-1.4.2-linux-x86-64 from kratos> (see docs/v4-cuotas.md)" >&2' \
        'exit 1' > /usr/local/bin/agy && chmod 0555 /usr/local/bin/agy; \
    fi \
 && rm -rf /tmp/agy-bin

USER node
WORKDIR /home/node
ENV HOME=/home/node
ENV MUSE_NO_AUTO_UPDATE=1

COPY --chown=node:node leer-cuota.mjs /usr/local/bin/leer-cuota.mjs
COPY --chown=node:node leer-cuota-grok.mjs /usr/local/bin/leer-cuota-grok.mjs
# Refresh is restricted to the runtime's own-session environments.
COPY --chown=node:node codex-http-probe.py /usr/local/bin/codex-http-probe.py
RUN chmod 0555 /usr/local/bin/codex-http-probe.py
COPY --chown=node:node verificar-muse.py /usr/local/bin/verificar-muse.py
RUN chmod 0555 /usr/local/bin/verificar-muse.py

CMD ["sleep", "infinity"]
