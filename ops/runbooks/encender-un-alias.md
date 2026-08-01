# Encender un alias de Cauce V3, de a uno, y validarlo de verdad

Escrito el 2026-07-31, después de encender trece alias en un día. El límite de **uno por vez no es
de cuota: es de diagnóstico.** Encender varios juntos multiplica los errores y borra la atribución;
dos semanas de intentos «todo a la vez» rindieron menos que una tarde de uno en uno.

Cada paso de abajo existe porque su ausencia costó tiempo real ese día.

## 0. Antes de encender nada: cerrar las trampas de la TUI

Un agente del bus **no tiene a nadie que conteste una pregunta interactiva**. Si la TUI arranca con un
modal, el adaptador pega el mensaje encima del menú, nadie lo procesa, y a los **30 minutos** el
deadline de ACK mata la entrega. Lo que ve el dueño es un agente mudo, no un error. Hay tres:

| arnés | trampa | arreglo |
|---|---|---|
| claude | asistente de bienvenida + confianza de carpeta | en `$CLAUDE_CONFIG_DIR/.claude.json` (**no** `~/.claude.json`): `hasCompletedOnboarding: true` y `projects["/workspace"].hasTrustDialogAccepted: true`. Si el fichero no existe, **crearlo** sembrándolo de `~/.claude.json`. |
| codex | permiso de ejecución | `approval_policy = "never"` en `config.toml`. Contraintuitivo: **`sandbox_mode = "danger-full-access"` es lo que CAUSA la pregunta** — sin sandbox, codex pide permiso para cada comando «fuera del sandbox». Un contenedor privileged, con bwrap funcionando, no pregunta. |
| codex | aviso de actualización | en `~/.codex/version.json`, poner `dismissed_version` igual a `latest_version`. |

## 1. Comprobar que nadie más escucha su bot de Telegram

Telegram entrega cada update a **un solo** consumidor. Un bot que otro programa sondea se traga los
mensajes y el puente no ve nada: cursor en `0`, `updates_denied` en `0`, cero líneas de log.

```sh
docker stop cauce-v3-prod-telegram-bridge-1
for a in <alias> <alias-de-control>; do
  T=$(sudo cat /etc/cauce-v3/telegram-runtime/$a.token)
  curl -s -o /tmp/x.json -w "%{http_code}\n" --max-time 22 \
    "https://api.telegram.org/bot$T/getUpdates?timeout=12&limit=5"
done
docker start cauce-v3-prod-telegram-bridge-1
```

Con el puente **parado**, `409` = hay otro consumidor. **El bot de control es obligatorio**: un 409
con el puente encendido sólo dice que el puente hace su trabajo. Si aparece un rival, el arreglo no
exige encontrarlo — `/revoke` en BotFather mata el token viejo y lo deja fuera.

## 2. Encender y validar

```sh
cauce <alias> on          # exige proceso vivo Y sesion compartida present:true, y la crea
cauce probar <alias>      # entrega REAL por el gateway + la marca buscada en el panel
```

`cauce probar` mira el panel **mientras** corre el turno: la TUI de claude vive en pantalla alterna
con `history_size=0`, así que mirar sólo al final reporta un fallo sobre turnos que pasaron bien.

En **openclaw** no hay panel tmux —el arnés es un servidor y la TUI del dueño es otro cliente de la
misma conversación—, así que `probar` dice «openclaw no usa panel tmux» y remite a
`cauce <alias> sesiones`. Eso **no** es un fallo.

## 3. Lo que NO sirve para comprobar

- **systemd.** `disable --now` dejó un adaptador vivo 3 h 27 min con su socket al bus; el supervisor
  avisa `no signal was sent` y nunca mata. La verdad está en `/proc`, cruzando `environ` con
  `cmdline` (Docker no concede `CAP_SYS_PTRACE`: ni root lee el `environ` ajeno, 2 de 23 dentro de
  `claw`).
- **`cauce` diciendo `compartida`.** Llegó a decirlo con la ventana enclavada en `⚠ CAUCE-DEGRADADO`.
- **Una entrega `done`.** El turno `agent.fanin` lo sintetiza el SDK en local, sin tocar el arnés.
- **Sondear el token con `getUpdates` para «ver si hay poller».** Le corta el long-poll al puente.
  Para saber si el puente está vivo, mirar `channel_bridge_leases.lease_until`, que se renueva cada
  ~25 s (muestrear más de un minuto antes de declararlo muerto).

## 4. Al apagar

`cauce <alias> off` mata el adaptador **y** el proceso del panel (un `claude --resume` sobrevivió
51 min a un `off`, huérfano y con su session id tomado — que es lo que produce los `dead_letters` de
`Session ID ... is already in use`). Avisa, además, que **el agente PTY sigue vivo**: es otro canal,
con su propia unit, y mantiene una conexión TLS al relay. `off` no apaga al alias entero.
