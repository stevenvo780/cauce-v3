# Contenedor minimo para leer cuotas SIN navegador.
#
# Por que existe: hasta el 2026-09-16 las cuotas de Claude se leian abriendo pestanas en
# navegadores con escritorio completo (nav-claude-*) en ils-server. Eso costaba un Chromium,
# un compositor Wayland y un servidor VNC por cuenta, se rompia cuando se caia el compositor,
# y dependia de una maquina que se cuelga. Aqui no hay navegador: solo el CLI de Claude, que
# guarda su propio token OAuth, y una llamada HTTP al mismo endpoint que usa el CLI.
#
# Cada cuenta vive en su propio contenedor con su propio volumen. Steven entra una vez por
# terminal a cada uno y hace `claude auth login`. Despues no hace falta tocarlo mas.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# CLI versions are pinned: a floating tag would let the login/update contract
# drift between builds. Bump deliberately and rebuild instead.
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.160.1
ARG GEMINI_CLI_VERSION=0.63.0
ARG GROK_VERSION=1.0.41

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*

# Los tres clientes que Steven puede querer autenticar en un espacio: Claude, Gemini y
# Codex. Van los tres en la misma imagen para que "cualquier cliente" sea verdad y no haya
# que rehacer la imagen cuando cambie de opinion. Ojo: esto INSTALA el CLI de codex; no lo
# ejecuta. Quien lo autentica es Steven por terminal, dentro de su propio contenedor, con
# su propia sesion. Ningun agente lo invoca.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@xai-official/grok@${GROK_VERSION}" \
 && npm cache clean --force \
 && claude --version | grep -q "${CLAUDE_CODE_VERSION}" \
 && codex --version | grep -q "${CODEX_VERSION}" \
 && gemini --version | grep -q "${GEMINI_CLI_VERSION}" \
 && grok --version | grep -q "${GROK_VERSION}"

# Usuario sin privilegios. La imagen de node ya trae uno con uid 1000 ("node"): reutilizo
# ese en vez de crear otro. Intentar crear uno nuevo con el mismo uid falla en silencio y
# deja el contenedor sin poder arrancar — me paso al primer intento.
USER node
WORKDIR /home/node
ENV HOME=/home/node

COPY --chown=node:node leer-cuota.mjs /usr/local/bin/leer-cuota.mjs
COPY --chown=node:node leer-cuota-grok.mjs /usr/local/bin/leer-cuota-grok.mjs
# La misma sonda de Codex que usa el VPS (copiada tal cual): lee un CODEX_HOME y devuelve el
# contrato que el colector ya sabe parsear. Solo refresca y reescribe el auth.json cuando el
# runtime de cuotas le pasa --refresh-own-session dentro de un entorno de sesion propia.
COPY --chown=node:node codex-http-probe.py /usr/local/bin/codex-http-probe.py
RUN chmod 0555 /usr/local/bin/codex-http-probe.py

# El contenedor no hace nada por si mismo: se queda quieto y espera a que le pidan la lectura
# o a que Steven entre a autenticarlo. Asi no consume ni CPU ni memoria entre medidas.
CMD ["sleep", "infinity"]
