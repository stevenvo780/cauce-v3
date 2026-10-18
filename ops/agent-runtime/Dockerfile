# Agent runtime of enrolled computers. The executor starts it as root with `sleep`, mounts the release read-only and
# runs the adapter as `node`; ops/scripts/build-host-release.sh pins each provider CLI it measures inside this image.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Same versions as ops/cuotas/Dockerfile: bump both deliberately. Hard links are split in the same layer because the
# adapter refuses a pinned provider command with more than one link.
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.160.1
ARG GROK_VERSION=1.0.41
ARG OPENCLAW_VERSION=2026.6.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
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
 && printf '%s  %s\n' '31f4f35423fa6d909eaa448612f06a2030d43f91872f90c07d11e4638bff2c90' \
      /usr/local/lib/node_modules/openclaw/dist/auth-list-oJF2Bhcx.js | sha256sum -c -

USER node
WORKDIR /home/node
ENV HOME=/home/node
CMD ["sleep", "infinity"]
