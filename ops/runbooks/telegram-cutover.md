# Runbook: activación y rollback del Telegram bridge V3 por alias

Deja el corte de Telegram V3 **turnkey y reversible por alias**. Enciende el poller
ingress + egress `origin_relay` del `telegram-bridge` para un alias reutilizando su
**bot existente** (mismo token que V2), con marcador anti-doble-poll y token `*_FILE`
0600. El paso humano es corto: preflight → provisionar → seleccionar → recrear →
verificar. Todo es por alias e incremental.

## Alcance y no-objetivos

- Este runbook solo gestiona la unidad V3 del **bridge** (poller/egress del bot). No
  detiene, arranca ni escribe la cola/estado interno de V2 salvo el paso explícito de
  apagar el poller V2 del alias (c) y su reactivación en rollback (g), que ejecuta el
  owner de V2 con su propio procedimiento.
- No toca `apps/console`, `packages/**`, `ops/container-*`.
- **Nunca** imprime, copia ni delega el token del bot. El token se mueve con tu
  mecanismo de secretos, encapsulado, sin pasar por la terminal ni logs.

## Prerrequisitos (una sola vez)

1. Migración aplicada: `005_channel_bridges.sql` (crea `channel_bridge_cursors`,
   `channel_bridge_leases`, `telegram_egress_effects`). Verificá con el `migrator`.
2. Imagen de runtime inmutable desplegada y el stack base (`gateway`, `dispatcher`,
   `outbox-metrics`) sano.
3. **Consumer V3 vivo del alias destinatario.** Con la política por defecto
   `recipients=self`, el DM al bot `<alias>` se entrega al harness de `<alias>`; ese
   harness debe estar conectado como consumer V3 (normalmente ya cortado según
   `alias-cutover.md`). Sin consumer, la entrega expira → `dead` → el egress devolverá
   "Error: ACK timeout" al humano.
4. Directorio de runtime en el host, p.ej. `export CAUCE_TELEGRAM_RUNTIME_DIR=/srv/cauce/telegram`.
   Compose lo monta read-only en `/run/cauce-telegram` y lee `config.json` de ahí.
   `config.json`, `<alias>.token` y `<alias>.disabled` viven **todos** en ese dir.

```sh
install -d -o 1000 -g 1000 -m 0750 "$CAUCE_TELEGRAM_RUNTIME_DIR"   # dueño = uid del servicio (compose user 1000:1000)
```

## Un solo bridge, un solo poller

- Corré **exactamente una** instancia de `telegram-bridge`. El egress reclama TODOS
  los `origin_relay` con adapter `telegram`; una segunda instancia con otro subconjunto
  mataría (a `dead`/DLQ) los relays de los alias que no sirve. Cambiar el conjunto de
  alias = **recrear la única instancia** con el nuevo `CAUCE_TELEGRAM_ALIASES`.
- `channel_bridge_leases` cerca por el ID real del bot (de `getMe`): dos pollers V3 no
  co-existen. V2 **no** comparte esa lease, por eso el orden "apagar V2 → crear marcador
  → encender V3" (c–e) es obligatorio para no tener doble poller sobre el mismo bot.

## Activación por alias

Variables del ejemplo (canary autorizado, alias no versionado):

```sh
ALIAS="${CANARY_ALIAS:?required}"
export CAUCE_TELEGRAM_RUNTIME_DIR=/srv/cauce/telegram
```

### (a) Generar e instalar `config.json`

Inyectá los IDs reales del humano de ese tenant con `--allowlist-file` (IDs, nunca
tokens). Los placeholders sentinela hacen que el poller **deniegue todo** el tráfico:
el preflight (paso siguiente) falla cerrado si quedaron.

```sh
# allowlist SOLO de IDs (sin secretos). chat_id == user_id en DMs privados de Telegram.
cat > /tmp/allow.$ALIAS.json <<JSON
{"aliases": {"$ALIAS": {"user_ids": ["<telegram_user_id>"], "chat_ids": ["<telegram_chat_id>"]}}}
JSON

# Config del subconjunto canary, validado contra services/telegram-bridge/src/config.ts.
python3 ops/scripts/generate-telegram-config.py \
  --aliases "$ALIAS" \
  --allowlist-file /tmp/allow.$ALIAS.json \
  --output "$CAUCE_TELEGRAM_RUNTIME_DIR/config.json"    # escritura atómica, modo 0644
chown 1000:1000 "$CAUCE_TELEGRAM_RUNTIME_DIR/config.json"
rm -f /tmp/allow.$ALIAS.json
```

Para el corte completo generá los 12 con un `--allowlist-file` que traiga
`aliases`/`tenants` de los 5 humanos; solo se encenderán los que listes en
`CAUCE_TELEGRAM_ALIASES` (paso e), así que podés instalar el config-12 una vez y
encender incrementalmente.

### (b) Provisionar el `token_file` (reusa el bot V2) — encapsulado

Escribí el **mismo token del bot** que usa V2 en `<alias>.token`, con tu mecanismo de
secretos, **sin** imprimirlo. Debe quedar archivo regular, no symlink, modo 0600 y
dueño uid 1000:

```sh
umask 077
# Ejemplo con un CLI de vault que escribe a stdout SIN eco en terminal/logs:
<tu-secret-tool> read "telegram/$ALIAS/bot_token" > "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.token"
chown 1000:1000 "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.token"
chmod 0600      "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.token"
```

No `cat`, no `echo`, no pegar el token. El bridge valida forma, modo 0600 y propiedad
al arrancar; si algo falla, **no** enciende (fail-closed).

### (c) Apagar el poller V2 del alias — gate de DRAIN

El owner de V2 detiene el poller/consumer V2 de **ese** bot y lo **drena**: sin
long-poll V2 activo contra el bot, sin ingress V2 nuevo, y su backlog propio settled.
Este es el gate crítico para no tener dos procesos haciendo `getUpdates` sobre el mismo
bot (Telegram entrega cada update a un solo lector; solaparse pierde o duplica).

### (d) Crear el marcador de shutdown

Contenido exacto `v2-poller-disabled:<alias>`, sin write de grupo/otros, no symlink.
Creación atómica:

```sh
umask 022
printf 'v2-poller-disabled:%s\n' "$ALIAS" > "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled.tmp"
chown 1000:1000 "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled.tmp"
chmod 0644      "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled.tmp"
mv -f "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled.tmp" "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled"
```

**Preflight (obligatorio) — sin secretos:**

```sh
python3 ops/scripts/telegram-cutover-preflight.py \
  --config "$CAUCE_TELEGRAM_RUNTIME_DIR/config.json" \
  --aliases "$ALIAS" \
  --runtime-dir "$CAUCE_TELEGRAM_RUNTIME_DIR"
```

Verifica (sin leer el token): config válido contra `config.ts`; alias presente;
token y marcador **bajo el mount**. Para el `token_file`: archivo regular, no
symlink, modo `0600`, owner `uid 1000` y tamaño > 0 — **metadata del archivo**,
**no** formato ni contenido del token. Para el marcador: archivo regular, no
symlink, sin write de grupo/otros y contenido exacto `v2-poller-disabled:<alias>`.
También verifica allowlists sin sentinela. Exit 0 = seguro encender. Cualquier
`FAIL` ⇒ **no** encender. La validación de **pertenencia** del token la hace el
bridge al arrancar contra `getMe`; el preflight no la hace.

### (e) Seleccionar el alias y recrear el bridge

Agregá el alias al selector (crecé la lista para encendido incremental) y recreá la
**única** instancia:

```sh
export CAUCE_TELEGRAM_ALIASES="$ALIAS"        # o lista autorizada construida desde el manifiesto privado
docker compose -f deploy/compose.yaml --profile telegram up -d --force-recreate telegram-bridge
```

Esperá readiness (loopback 8086) y arranque limpio:

```sh
docker compose -f deploy/compose.yaml ps telegram-bridge          # health = healthy
docker compose -f deploy/compose.yaml exec -T telegram-bridge \
  node deploy/readiness-probe.mjs http://127.0.0.1:8086/health/ready ready
```

Si un alias seleccionado no tiene token+marcador válidos, el proceso falla al arrancar
(fail-closed): revisá el preflight, no fuerces.

### (f) Verificar el round-trip humano — gates de ACK y DLQ

1. El humano autorizado envía un DM al bot `<alias>`.
2. Observá métricas (sin labels sensibles) en `/metrics`:

```sh
docker compose -f deploy/compose.yaml exec -T telegram-bridge \
  node -e "fetch('http://127.0.0.1:8086/metrics').then(r=>r.text()).then(t=>console.log(t))"
```

Gates esperados en `cauce_telegram_bridge_events_total{result=...}`:
- `updates_allowed` incrementa (si sube `updates_denied`, el allowlist no matchea al
  humano → corregí IDs en (a) y regenerá).
- `egress_sent` incrementa y el humano recibe la respuesta.
- `poll_fenced` estable (ausencia de contención de lease **V3** sobre el mismo bot;
  **no** prueba ausencia de poller V2 — esa se valida fuera del bridge).
- **ACK gate:** `egress_ambiguous` = 0 y `egress_retry` no crece sostenido.
- **DLQ gate:** `egress_dead` = 0 y sin filas nuevas del alias en `outbox_dead_letters`
  / `dead_letters`. Si hay `dead`/`ambiguous`, inspeccioná con `getEffect()` y resolvé
  antes de subir tráfico; el reenvío solo es la acción manual cercada
  `manualReplayEffect` (ver `CONFIGURATION.md`), nunca reintento automático.

Sostené al menos dos ventanas de lease (`poll_lease_ms`, def. 60 s) antes de sumar más
alias o tráfico.

## Rollback por alias

Con el humano avisado y tráfico en pausa para ese alias:

1. **Drain:** dejá de enviar al bot y esperá a que las entregas y `origin_relay` del
   alias queden settled — sin inflight, sin ACK pendiente. Confirmá en `/metrics` que
   `egress_*` dejó de moverse y no hay `ambiguous`/`retry` colgados.
2. **Sacar del bridge:** quitá el alias del selector (`CAUCE_TELEGRAM_ALIASES`) y
   **recreá la única instancia** para que la lista actualizada tome efecto:

   ```sh
   export CAUCE_TELEGRAM_ALIASES="<resto-sin-$ALIAS>"
   docker compose -f deploy/compose.yaml --profile telegram up -d --force-recreate telegram-bridge
   ```

   **Branch explícito para el último alias:** si era el único alias del selector,
   **NO** se usa `CAUCE_TELEGRAM_ALIASES=""` ni se recrea con selector vacío — el
   selector vacío activa **TODOS** los del config (ver §"Advertencias operativas"
   punto 1). Se hace **STOP** explícito del perfil:

   ```sh
   docker compose -f deploy/compose.yaml --profile telegram stop telegram-bridge
   ```
3. **Quitar el marcador:** borralo para que V3 no pueda re-encender ese alias por error
   (arranca fail-closed sin marcador) y para no misrepresentar el estado:

   ```sh
   rm -f "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.disabled"
   ```

   El `token_file` podés retirarlo también si el rollback es definitivo (`rm -f
   "$CAUCE_TELEGRAM_RUNTIME_DIR/$ALIAS.token"`).
4. **Reactivar V2:** recién ahora el owner de V2 vuelve a arrancar su poller del bot con
   su procedimiento. Gate final: **un solo** poller sobre el bot (V3 ya detenido).

Orden invariante: V3 se detiene **antes** de reactivar V2 (nunca doble poller); el
marcador se elimina entre ambos pasos.

## Resumen de gates

| Fase | Gate |
|---|---|
| Antes de (e) | Preflight PASS; V2 drenado y apagado (c); marcador correcto (d); consumer V3 del destinatario vivo |
| Después de (e) | bridge `healthy`; lease V3 única por bot (ver §"Un solo bridge, un solo poller"); `poll_fenced` estable — **no** es prueba de ausencia de V2 (ver §"Advertencias operativas" punto 6) |
| (f) round-trip | `updates_allowed`↑, `egress_sent`↑; ACK gate (`ambiguous`=0), DLQ gate (`dead`=0, DLQ sin filas nuevas) |
| Rollback | drain settled → sacar del bridge → quitar marcador → reactivar V2; nunca doble poller |

## Advertencias operativas (duras)

Incumplirlas cambia el resultado del cutover. Esta sección las reúne en una sola
lista de referencia rápida; el detalle canónico está en el cuerpo del runbook.

1. **Selector vacío activa todos.** `CAUCE_TELEGRAM_ALIASES=""` **no** significa
   "apagar"; significa "seleccionar todos los alias del config". **Nunca** se
   recrea el bridge con selector vacío para "apagarlo" — para apagar se hace
   **STOP** explícito del perfil `telegram` (ver §"Rollback por alias" branch
   último alias).
2. **Selector siempre acumulativo.** Crecer el conjunto = sumar al string y
   recrear la única instancia (`CAUCE_TELEGRAM_ALIASES="a,b,c"`). Reducir =
   recrear con la lista restante; reducir a cero = STOP (no recreate vacío).
3. **Una sola instancia de bridge.** El egress reclama TODOS los `origin_relay`
   con adapter `telegram`; una segunda instancia con subconjunto distinto
   mataría (a `dead`/DLQ) los relays de los alias que no sirve. Cambiar el
   conjunto de alias = **recrear la única instancia** (no sumar réplicas).
4. **Esperar dos ventanas de lease** (`poll_lease_ms`, default 60 s) antes de
   sumar más alias o tráfico. Cortar ventanas induce flicker en `poll_fenced`.
5. **No doble polling.** Cada bot es leído por **un** `getUpdates`. V3 ya tiene
   lease V3 cercada por el ID real del bot (`getMe`); V2 no la comparte → V2
   **debe** estar drenado y apagado para el alias antes de encender V3, y
   viceversa en rollback. Dos instancias V3 también colisionan.
6. **`poll_fenced` estable no prueba ausencia de V2.** Sólo prueba ausencia de
   contención de lease V3 sobre el mismo bot. La ausencia de poller V2 se
   valida en el lado V2: settings anti-Telegram en launchers (e.g.
   `channels.telegram.enabled=false`), telemetría V2 propia o ausencia del
   proceso. Un incidente histórico, cuyo detalle se conserva en evidencia privada no versionada,
   ilustra este modo de falla: `poll_fenced` estable y, sin embargo, el
   launcher conservaba `channels.telegram.enabled=true`.
7. **Preflight valida sólo metadata, no formato/contenido.** El preflight
   secret-free verifica metadata del `*.token` (archivo regular, no symlink,
   modo `0600`, ownership `uid 1000`, presencia bajo el mount, tamaño > 0).
   **No** lee ni valida el contenido del token, su formato ni su firma. La
   validación de pertenencia la hace el bridge al arrancar contra `getMe`.
8. **No leer el token.** El token se mueve con mecanismo de secretos, encapsulado,
   archivo regular `0600` dueño uid 1000 bajo el mount. **Nunca** `cat`, `echo`,
   pegar, ni delegar a un subagente. El preflight valida sin leerlo.
9. **No registrar MCP global Clawbus.** Un segundo cliente MCP global Clawbus con
   el mismo alias abre una segunda conexión al bus → respuestas perdidas y
   `clawbus_ask timed out`. Los `cc_connector` headless deben mantener su socket
   único; los launchers por identidad fijan settings anti-Telegram para evitar
   re-introducir el bug. El bridge V3 **no** depende del MCP Clawbus y no debe
   compartir socket con él.

## Snapshot histórico de Telegram V3

> La evidencia privada conserva el corte live validado, sus identidades, fecha, métricas exactas
> y paths operativos. Este repositorio sólo registra las conclusiones reutilizables y que durante
> esa validación no se ejecutó SSH ni se leyeron tokens, sesiones, credenciales o archivos de
> entorno.

- Se observó un único bridge saludable y un selector acumulativo. Un selector vacío activa toda
  la flota; para apagar el perfil se requiere un STOP explícito.
- El preflight secret-free validó exclusivamente metadata de archivos: regular, sin symlink,
  permisos/ownership esperados y tamaño no nulo. No leyó ni validó el contenido del token;
  la pertenencia se comprobó mediante la API del proveedor al arrancar.
- Las métricas eran agregadas y sin labels de identidad. Un `poll_fenced` estable sólo demuestra
  ausencia de contención entre pollers V3; no demuestra ausencia de V2.
- El corte histórico observó V2 drenado para el alcance medido, pero no es prueba actual. Antes
  de cualquier release hay que repetir el gate del lado V2 y el round-trip humano por alias.
- Un incidente histórico confirmó el riesgo: un launcher conservaba su canal Telegram activo
  mientras V3 ya operaba. La remediación desactivó ese canal con configuración validada y hot
  reload, sin restart. El detalle e identidad permanecen en evidencia privada no versionada.
- La topología y los paths del bus legado no se versionan aquí. El bridge V3 no depende de ese
  mecanismo y no debe compartir socket con él.

### Pendientes vigentes

- Las métricas agregadas no acreditan por sí solas cada alias; el release exige round-trip
  explícito y correlacionado para cada uno.
- Revalidar siempre ausencia de V2, leases, ACK, DLQ y progreso de outbox con evidencia fresca;
  ningún contador o estado de este snapshot histórico es una cota futura.
