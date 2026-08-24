# HANDOFF zeus — 2026-08-24 (fin de sesion, contexto reiniciado por Steven)

Steven reinicia el contexto porque NO logré el objetivo que más le importa: **que el modal de
directiva muestre las capas 2 y 3 (CLAUDE.md y memoria)**. Sigue sin funcionar. Todo lo demás
que hice hoy es secundario frente a eso.

## 1. EL OBJETIVO PENDIENTE, y exactamente dónde está trabado

El modal «Directiva de <alias>» pinta «NO SE PUDO MIRAR» en Capa 2 y Capa 3 porque el gateway
responde **404** a `GET /v3/console/agents/:tenant/:alias/directive`.

La cadena ESTÁ ESCRITA Y PROBADA (55 pruebas que corrí YO, no informes de nadie):
- pty-agent lee el fichero dentro del contenedor (lista blanca CLAUDE.md/AGENTS.md, contención en
  HOME, rechazo de symlinks, NEVER_SERVE de credenciales, truncado 256 KB).
- terminal-relay expone `POST /v3/terminal/relay/read` (Bearer + mTLS) → `requestFileRead`.
- gateway: `HttpGovernanceRelayClient` + la ruta montada en `terminal/plugin.ts`.
- Rama: **`fix/directive-contenido-20260824`** (commit `ec2709c`), empujada a `kratos`.

**EL BLOQUEO REAL, medido:** intenté desplegar por CIRUGÍA (copiar los ficheros compilados dentro
de la imagen que ya corre) y el gateway NO ARRANCÓ:

```
SyntaxError: The requested module './authority.js' does not provide an export named 'FLEET_PLACEMENTS'
```

Porque **producción corre un código DISTINTO del que usé de base**: prod = `7b88c1e8`
(tag `cauce-v3-runtime:20260824-live`), mi rama sale de `eeb9e08`. Los ficheros NO son
intercambiables entre esas dos versiones. Tumbé el gateway ~2 min y **revertí** (borrar el
override + recrear). Servicio sano: consola 200, gateway healthy, flota entregando.

**LO QUE HAY QUE HACER (única vía correcta):** rebasar `fix/directive-contenido-20260824` sobre el
código que REALMENTE corre en producción y construir la **imagen COMPLETA** del runtime (no
parchear ficheros sueltos). Luego desplegar gateway + terminal-relay juntos y ABRIR EL MODAL.

**Ya resuelto y NO hay que volver a preguntarlo:** la config del gateway hacia el relay. Todo el
material ya estaba montado en el contenedor (cert, llave, CA y el testigo del relay). Es PURA
CONFIGURACIÓN y ya está escrita en `/etc/cauce-v3/prod.env` (respaldo:
`prod.env.bak-directiva-20260824`):
```
CAUCE_TERMINAL_RELAY_URL=https://terminal-relay:8446
CAUCE_TERMINAL_RELAY_CLIENT_CERT_FILE=/run/secrets/gateway_tls_cert
CAUCE_TERMINAL_RELAY_CLIENT_KEY_FILE=/run/secrets/gateway_tls_key
CAUCE_TERMINAL_RELAY_CA_FILE=/run/secrets/gateway_tls_ca
```
Probado por efecto: con ESE certificado el relay acepta el saludo TLS (antes daba
`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`). NO hace falta crear ni mover ninguna credencial.

## 2. DATO QUE CAMBIA EL PROBLEMA: los agentes SÍ tienen contexto

Steven cree que la flota falla por falta de contexto. **Medido dentro de cada contenedor, es falso**:
argos 8.339 B · atlas 12.942 · gaia 1.143 · hegel 12.322 · heraclito 10.763 · iza 18.775 ·
janus 19.463 · jarvis 23.762 · kratos 12.942 · socrates 12.942 · zeus 10.733.
**11 de 14 tienen su fichero de arnés con contenido real.** Huecos reales: **tales** NO tiene
`/home/claw/.codex/AGENTS.md`; **kant** y **salva** viven en kratos y no los medí desde vpstn.
Lo que falla es que la CONSOLA no sabe leerlos, no los agentes.

Rutas correctas por arnés (del propio resolver del gateway): claude → `~/.claude/CLAUDE.md`,
codex → `~/.codex/AGENTS.md`, openclaw → `~/.openclaw/openclaw.json`. **OJO**: el generador
`/workspace/scripts/genera-contexto-harness.sh` está MAL (escribe `<home>/CLAUDE.md` para todos y
dice hacer copia de seguridad pero NO la hace). NO lo ejecutes con `--apply` sin arreglarlo.

## 3. DESPLEGADO HOY Y VERIFICADO EN NAVEGADOR (no tocar)

- **Consola** (`cauce-console@sha256:a14f379c…`, override `prod.env`, respaldo
  `prod.env.bak-terminal-20260824`): landing pública sin sesión; `/config` con enums en castellano
  (adaptador/agente/operador); Terminal SIN la UI informativa (se fue a «Señales y auditoría» con
  las 6 tarjetas + Capability gates + Transport plane); Terminal ya no desborda la ventana y su
  estado vacío se ve y está en castellano. 0 violaciones de CSP.
- **terminal-relay** (`cauce-v3-runtime:relay-directiva-20260824`… OJO: tras la reversión quedó en
  `cauce-v3-runtime:terminal-minrows-20260824`, override `/etc/cauce-v3/compose-overrides/terminal-minrows.yaml`):
  arreglo de `rows:1` — una tercera terminal ya NO mata las dos vivas.

## 4. TRAMPA DE INFRA QUE HAY QUE SABER

En producción conviven **TRES imágenes distintas del runtime**: gateway+dispatcher `7b88c1e8`,
terminal-relay (la mía), telegram-bridge `2b65ff3e`. **Recrear un servicio con el pin de
`prod.env` le cambia el código de paso.** Por eso los despliegues aquí van con override por
servicio (`compose-overrides/*.yaml`), que es además la reversa: borrar el fichero y recrear.
El puente de Telegram además lleva parches locales que NO están en `main`.

## 5. LO QUE ESPERA A STEVEN (no lo decidas vos)

**Despliegue de pos-back** (7 commits, rama `main` de pos-back, `2355d10`). Lo pidió heraclito.
Toca DINERO y LEGAL: un cron que ahora puede ACTIVAR suscripciones (= cobrarle a clientes reales)
y la facturación electrónica DIAN. Se lo pedí 3 veces y no dio el OK explícito.
**No hay incendio**: la fuga del P0 #36 está contenida en el borde.
Ancla de reversa ya creada: `pos-back:rollback-20260824-zeus`.
heraclito tiene un SQL de sólo lectura para inventariar las 14 apiKey filtradas; pedírselo.

## 6. Contención del POS #36 (hecha y probada)

Bloqueo en Caddy (`/etc/caddy/pos.saldantia.cloud.caddy`, host `2.25.89.230`) de
`POST /api/mercadopago/sync` **y su sufijo** (`path /api/mercadopago/sync /api/mercadopago/sync/*`).
El matcher exacto original dejaba pasar `/sync/`, `/sync//` y `/sync/?x=1` (llegaban al backend
con 401). Verificado con 8 variantes → todas `403` cuerpo vacío; controles positivos: `/api/health`
200, portada 200, webhook 200, `/api/otra-ruta` 404.

**Centinela** (pedido por argos): `/usr/local/bin/pos-sentinel-mp-sync.sh` +
`/etc/cron.d/pos-sentinel-mp-sync`, cada 5 min. Si la regla cae, la RESTAURA desde
`pos.saldantia.cloud.caddy.BUENO-20260824` y recarga Caddy; exige `/api/health`=200 como control
positivo. Log: `/var/log/pos-sentinel/centinela.log`; si NO logra taparlo escribe
`/var/log/pos-sentinel/ALERTA-ACTIVA`. **Probado rompiendo la regla a propósito** (las 4 variantes
pasaron a `401|71` y volvieron a `403|0`). NO verificado todavía: verlo dispararse solo por cron.
**Limitación real:** un cron NO puede avisar a un humano en esta flota (no hay herramienta de
alerta; el CLI `cauce` no publica ni notifica). Por eso auto-repara.

## 7. Otros frentes

- **iza**: NO estaba rota. Reinicié su contenedor (llevaba 11 días) y respondió a una sonda en 7 s.
  El «no le llegan mensajes» era MÍO: dos turnos míos murieron por plazo y un turno muerto no emite
  nada. Control negativo con janus: las dos entregas cerraron `done`.
- **jarvis**: contenedor `claw` reiniciado (05:55Z); WhatsApp con `dmPolicy:open`, `allowFrom:["*"]`
  y escuchando. Falta la prueba end-to-end: que alguien escriba al **+573023954534**.
  Si sigue mudo, sospechoso: plugin whatsapp 2026.5.22 vs 2026.6.6 → `openclaw plugins update`.
- **OpenClaw sin TUI**: NO es que no tengan TUI, es que **no tienen tmux** (`tmux: command not found`
  en `claw`). Rama `fix/openclaw-tui-stream-20260824` (`d0666f9`) añade un modo «actividad» que lee
  el JSONL de sesión real (verifiqué que el fichero existe y que el lector saca sólo metadatos, y
  que sin fuente devuelve error 3 — nunca verde falso). **Sus pruebas de consola NUNCA se
  ejecutaron** y toca el lanzador del pty-agent en TODOS los contenedores: NO desplegar sin correrlas.

## 8. Cómo trabajar acá (lo que me costó caro hoy)

1. **Mis turnos largos matan mis propios mensajes.** Un turno que vence el plazo no emite NI
   respuesta NI `messages`. Turnos cortos.
2. **Nada de subagentes se da por bueno sin verificar.** Hoy: uno dijo «1091 tests pasan» (falso: 53
   de 84 ficheros fallan en este entorno por un React roto — preexistente, no es tuyo); otro dijo que
   implementó la ruta y **no la había montado**; otro propuso un «forwarder» que sólo encendía el
   botón verde sin transportar bytes.
3. **Abrí la UI en el navegador.** El «panel blanco vacío» de Terminal no era contenido faltante:
   el texto estaba dibujado 1.300 px más abajo, fuera de pantalla.
4. **Control negativo siempre.** Rompé la cosa a propósito y comprobá que tu guardia lo caza.
