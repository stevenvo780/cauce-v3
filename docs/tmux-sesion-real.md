# La terminal y Telegram, una sola conversación

**Qué está encendido hoy:** `<agent-alias>` (harness **claude**, contenedor `<private-host>`) y `<agent-alias>`
(harness **codex**, contenedor `<private-host>`). `<agent-alias>` no se tocó.

---

## El comando

```sh
cauce <agent-alias>          # o: cauce <agent-alias>
```

Eso es todo. Se ejecuta en **<agent-alias>** (es `~/.local/bin/cauce`).

Para ver el estado de toda la flota, sin entrar a ninguno:

```sh
cauce
```

La columna **MODO** dice en cuál de los tres estados está cada alias:

| MODO | Qué significa |
|---|---|
| `compartida` | la TUI REAL del agente, y la MISMA conversación que Telegram |
| `aparte` | TUI real, pero conversación nueva: **no** comparte con Telegram |
| `—` | su adaptador está parado |

---

## Qué vas a ver

Al entrar te aparece **el binario de verdad**, no una imitación: el panel de Claude Code (o el de
Codex), tu historial, y los `/comandos` funcionando dentro. Comprobado el <private-date> con `/status`
en los dos: en claude abre el panel de Settings/Status con el ID de sesión, el modelo y los MCP; en
codex abre su recuadro con el modelo, el directorio y la cuenta.

**Lo que llegue por Telegram entra por esa misma conversación y se ve EN VIVO en el panel.** Vas a
ver el pedido completo (con su bloque de contexto de entrega) y debajo la respuesta del agente, en
el mismo hilo en el que vos escribís.

Para salir **sin cerrarla**: `<private-host> d`. La sesión queda viva y el agente sigue atendiendo el bus.

### Si algo se rompió mientras no mirabas

Al entrar, antes de engancharte, `cauce <alias>` lista los avisos pendientes. Un turno que **no**
pasó por la terminal se avisa en cuatro sitios a la vez:

1. dentro de la respuesta que te llega por Telegram (`⚠ CAUCE — SESIÓN COMPARTIDA CAÍDA`, con el
   motivo y cómo restablecerlo);
2. un mensaje en la barra de tmux y la barra de estado en rojo (el nombre de la ventana **no** se
   toca: renombrarla dejaba al adaptador sin encontrarla nunca más);
3. `cauce <alias>` te los lee al entrar;
4. `shared_session_degraded` en el journal del adaptador.

El aviso lo escribe **el adaptador después de validar el sobre**, nunca el modelo.

Hay un segundo tipo de aviso, por los mismos cuatro sitios pero **sin** rojo: el turno **sí** pasó
por tu terminal, pero su memoria cambió — la terminal se reinició, no había ninguna y hubo que
crearla, hiciste `/clear` (o `/new` en codex), o el propio harness compactó el contexto. Ahí no se
degrada nada: se dice, con las cifras cuando el evento las trae, y en el caso de codex el bus pasa a
seguir el hilo **nuevo**, que es el que estás mirando.

---

## Qué NO se puede hacer todavía

- **`/clear` y `/compact` vacían el contexto que el bus cree compartir, y eso no se detecta.** Si los
  usás, el agente sigue contestando por Telegram pero ya no recuerda lo que hablaron en la terminal,
  y nadie te avisa. Es la limitación más importante que queda abierta.
- **Si la TUI se muere, no se resucita sola.** El aviso sale (`tui_absent`) y el bus se sigue
  atendiendo por el camino de siempre, pero para recuperar la sesión compartida hay que cerrarla y
  volver a abrirla:
  `docker exec --user dev <contenedor> tmux -L cauce kill-session -t cauce-<alias>` y después
  `cauce <alias>`.
- **En codex, el app-server es punto único de fallo** para las dos puertas (tu TUI y el bus), y los
  dos subcomandos que usa están marcados `[experimental]` por OpenAI.
- **Codex pide confirmación cuando hay actualización disponible** y se queda esperándola: la TUI no
  llega a su caja de entrada hasta que alguien contesta ese diálogo. Si `cauce <agent-alias>` se queda
  clavado al abrir, mirá el panel y elegí *Skip until next version*.
- **Una segunda terminal más chica reflowea el panel para todos**: manda el cliente más pequeño.
- **El acoplamiento de claude es por teclas.** Un rediseño de su caja de entrada lo rompe.
- **La TUI de codex hereda el `$CODEX_HOME` del perfil del contenedor** (`~/.codex`), que no es
  necesariamente el que usaba el adaptador por su cuenta. Como ahora el turno del bus va por el
  app-server que lanza la TUI, manda la configuración de la TUI.

---

## Cómo revertir

Revertir es **quitar un interruptor**, no deshacer un despliegue: sin `SHARED_SESSION=1` el
adaptador se comporta byte a byte como antes.

### 1. Apagar la sesión compartida de un alias

En **<agent-alias>**, sobre `~/.config/cauce-v3/container-aliases/<alias>.env`, borrá estas dos líneas:

```
SHARED_SESSION=1
SHARED_SESSION_WORKSPACE=/workspace
```

y reiniciá su adaptador:

```sh
systemctl --user restart cauce-v3-container-<alias>.service
```

Hay copias con fecha al lado de cada `.env` (`<alias>.env.bak-antes-tmux-*`).

### 2. Volver al bundle anterior

```sh
# Los aliases afectados estaban antes en releases registrados en su backup privado.
# Restaurar `RELEASE_DIR` y `BUNDLE_SHA256` exactamente desde cada `.env.bak-antes-tmux-*`;
# no reconstruir esos valores desde memoria ni desde nombres de sesión.
```

Copiá el `.bak` sobre el `.env` y reiniciá la unit. Los bundles viejos siguen todos en
`~/.local/share/cauce-v3-adapter/releases/`; no se borró ninguno.

### 3. Volver al release de ops anterior

```sh
ln -sfn "$(cat ~/.local/share/cauce-v3/.ops-anterior-antes-tmux)" ~/.local/share/cauce-v3/ops
```

### 4. Sacar a <agent-alias> de Telegram otra vez

En **<private-host>**, `/etc/cauce-v3/prod.env`, quitar `,<agent-alias>` del final de
`CAUCE_TELEGRAM_ALIASES` y recrear el puente:

```sh
cd /opt/cauce-v3 && COMPOSE_PROFILES=observability,terminal,telegram docker compose \
  --env-file /etc/cauce-v3/prod.env -f deploy/compose.yaml -f deploy/compose.postgres.yaml \
  -f /etc/cauce-v3/compose-overrides/telegram-bridge.active.yaml \
  up -d --force-recreate --no-deps telegram-bridge
```

Hay copia con fecha: `/etc/cauce-v3/prod.env.bak-antes-<agent-alias>-telegram-*`.

---

## Tres trampas que costaron el despliegue, por si vuelven

1. **El digest del bundle incluye los permisos.** El supervisor normaliza el árbol dentro del
   contenedor con `chmod -R u=rX,go=rX` y vuelve a calcular el digest; si en el host los ficheros no
   están ya en esa forma exacta (444/555), el arranque muere con `copied active bundle digest
   differs` y `status=78/CONFIG`. Al construir un bundle: `chmod -R u=rX,go=rX` **antes** de calcular
   el digest.
2. **El release de ops vivo NO es `main`.** Le habían quitado `ensure_claude_binary` porque su
   versión fijada (<private-version>) ya no coincide con el binario del contenedor (<private-version>) y el arranque
   moría con exit 78, que además está en `RestartPreventExitStatus`. Un release de ops nuevo se
   construye **sobre el vivo**, no sobre el árbol del repo.
3. **`tmux display-message` miente.** Si la ventana pedida no existe, cae a la ventana actual y
   devuelve 0 — ni el prefijo `=` lo evita. Para saber si una ventana existe hay que enumerar con
   `list-windows` y comparar por igualdad exacta.
