FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# CLI versions are pinned: a floating tag would let the login/update contract
# drift between builds. Bump deliberately and rebuild instead.
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.160.1
ARG GROK_VERSION=1.0.41

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
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

USER node
WORKDIR /home/node
ENV HOME=/home/node

COPY --chown=node:node leer-cuota.mjs /usr/local/bin/leer-cuota.mjs
COPY --chown=node:node leer-cuota-grok.mjs /usr/local/bin/leer-cuota-grok.mjs
# Refresh is restricted to the runtime's own-session environments.
COPY --chown=node:node codex-http-probe.py /usr/local/bin/codex-http-probe.py
RUN chmod 0555 /usr/local/bin/codex-http-probe.py

CMD ["sleep", "infinity"]
