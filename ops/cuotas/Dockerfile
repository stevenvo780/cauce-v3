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
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*

# Los tres clientes que Steven puede querer autenticar en un espacio: Claude, Gemini y
# Codex. Van los tres en la misma imagen para que "cualquier cliente" sea verdad y no haya
# que rehacer la imagen cuando cambie de opinion. Ojo: esto INSTALA el CLI de codex; no lo
# ejecuta. Quien lo autentica es Steven por terminal, dentro de su propio contenedor, con
# su propia sesion. Ningun agente lo invoca.
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex @xai-official/grok \
 && npm cache clean --force

# Usuario sin privilegios. La imagen de node ya trae uno con uid 1000 ("node"): reutilizo
# ese en vez de crear otro. Intentar crear uno nuevo con el mismo uid falla en silencio y
# deja el contenedor sin poder arrancar — me paso al primer intento.
USER node
WORKDIR /home/node
ENV HOME=/home/node

COPY --chown=node:node leer-cuota.mjs /usr/local/bin/leer-cuota.mjs
COPY --chown=node:node leer-cuota-grok.mjs /usr/local/bin/leer-cuota-grok.mjs
# La misma sonda de Codex que usa el VPS (copiada tal cual): lee un CODEX_HOME y devuelve el
# contrato que el colector ya sabe parsear. Nunca refresca ni reescribe el auth.json.
COPY --chown=node:node codex-http-probe.py /usr/local/bin/codex-http-probe.py

# El contenedor no hace nada por si mismo: se queda quieto y espera a que le pidan la lectura
# o a que Steven entre a autenticarlo. Asi no consume ni CPU ni memoria entre medidas.
CMD ["sleep", "infinity"]
