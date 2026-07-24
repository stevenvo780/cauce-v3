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
- No toca `apps/console`, `packages/**`, `ops/container-*`, `services/relay-worker`.
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

Variables del ejemplo (canary `kant`):

```sh
ALIAS=kant
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
export CAUCE_TELEGRAM_ALIASES="$ALIAS"        # o "kant,jarvis,..." acumulando
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
   proceso. El caso **Janus 2026-07-23** (ver handoff
   `../../../docs/handoffs/HANDOFF-CAUCE-V3-TELEGRAM-CUTOVER-2026-07-23.md` §8)
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

## Estado live verificado 2026-07-23

> **Nota (2026-07-23):** Snapshot de evidencia live validada por MAIN. **No** se
> ejecuta SSH ni se leen tokens / sesiones / credenciales / `.env`. El detalle
> completo, incluyendo el incidente Janus y su remediación, está en
> `../../../docs/handoffs/HANDOFF-CAUCE-V3-TELEGRAM-CUTOVER-2026-07-23.md`.

- **Bridge productivo único:** `cauce-v3-prod-telegram-bridge-1`, `healthy`,
  `RestartCount=0`, readiness aliases expuestos = **12**.
- **Selector acumulativo activo** sobre los 12 manifest: `kant, argos, dedalo,
  jarvis, janus, midas, seneca, hegel, socrates, kratos, salva, vulcano`. El
  selector es siempre **acumulativo** (crece = sumar y recreate; reduce = recreate
  con lista restante; cero = STOP explícito del perfil, **nunca** recreate vacío).
- **Preflight secret-free PASS** sobre los 12 alias (reportado). La imagen
  productiva remota no incluye `ops/scripts/`, por lo que el live se ejecutó
  como **chequeos inline reportados** — **sin artefacto reproducible
  capturado** (los reports fueron efímeros en la sesión de MAIN). El source
  canónico (`../../ops/scripts/telegram-cutover-preflight.py`) **sí** contiene
  el script y es **reproducible** desde el repo, pero **no se corrió** contra
  el bundle remoto. Cada chequeo valida **sólo metadata** (archivo regular,
  no symlink, modo `0600`, ownership `uid 1000`, presencia bajo el mount,
  **`st_size > 0`** vía `stat`/`Path.stat` — **sin `read`/`open`** del
  contenido): no formato, contenido ni firma del token; la pertenencia la
  hace el bridge al arrancar contra `getMe`. El source canónico **exige
  `st_size > 0` sin leer el token** — esa garantía ya está vigente en el
  script versionado, **no** es un cambio pendiente; los chequeos live
  reportados reflejan la misma regla como metadata, sin abrir el archivo.
- **Métricas agregadas** (sin labels de tenant/alias/bot) sobre `/metrics` del
  bridge:

  Snapshots cronológicos de `poll_fenced` (semántica: **sólo ausencia de
  contención de lease V3** — dos pollers V3 no co-existen, lease cercada por
  el ID real del bot vía `getMe`; **no prueba ausencia de V2**, esa se hace
  en el lado V2):

  | Snapshot | Fecha | Lectura | Estado |
  |---|---|---|---|
  | **S1 (histórico)** | 2026-07-23 (corte inicial) | `poll_fenced` = 949, **estable 949→949** | valor base post-force-recreate del contenedor; remanente de contention tracking previo, no conflicto V3 activo |
  | **S2 (post-rollout, histórico)** | 2026-07-23 (post-rollout, sin hora específica — sólo fecha) | `poll_fenced` = 980, **estable 980→980** entre dos lecturas | sin incremento sostenido; sólo ausencia de contención de lease V3; mismo bot no tiene dos pollers V3 activos |
  | **S3 (cierre técnico, vigente al cierre del runbook)** | 2026-07-23 (post-reinicios, sin hora específica — sólo fecha) | `poll_fenced` = 986, **estable 986→986** en ventana 30 s | sin incremento sostenido en la ventana de cierre técnico; sólo ausencia de contención de lease V3 — **S3 es cierre técnico, no un valor fijo futuro**: durante pruebas humanas el contador puede avanzar como en S1→S2→S3 (mismo mecanismo: detecciones discretas entre lecturas, no contención viva) |

  > **Nota (2026-07-23):** Los tres snapshots son **lecturas del mismo contador
  > acumulativo** entre dos ventanas de lease. Las diferencias 949 → 980 →
  > 986 reflejan nuevas detecciones de contención V3 (lease reclamada por
  > otro proceso) entre el corte inicial, el post-rollout y el cierre
  > técnico post-reinicios — **NO** indican contención viva (que sería
  > sostenido, no puntos discretos). Si en una lectura posterior el valor
  > crece de forma sostenida entre dos ventanas consecutivas, **sí** hay
  > contención V3 — abrir investigación con `alias-cutover.md`. Los snapshots
  > S1 y S2 se conservan como referencia temporal; el snapshot S3 es **el
  > cierre técnico de este runbook**, no una cota superior: las pruebas
  > humanas en curso (validación per-alias por Steven, ver §Pendientes
  > reales) pueden seguir avanzando el contador como en S1→S2→S3, sin que
  > ello indique contención.

  Resto de series al **cierre técnico (S3)** (single point in time, mismo
  bridge — **contadores acumulativos que pueden avanzar durante las pruebas
  humanas en curso**, son la foto del cierre, no una cota):

  | Serie | Valor al cierre | Lectura | Notas |
  |---|---|---|---|
  | `updates_allowed` | **9** | 9 DMs humanos admitidos en lo que va del corte | acumulativo; sigue creciendo con cada DM autorizado en pruebas humanas |
  | `updates_denied` | **1** | **1 update rechazado por allowlist** — NO es error de entrega ni DLQ; es un update del lado ingreso que el filtro `user_id`/`chat_id` no aceptó. **Sin atribución por alias**: el bridge publica agregados sin labels, así que `updates_denied=1` cuenta *un* rechazo de allowlist sin identificar a qué alias correspondió. Acumulativo: si una prueba humana manda desde un `user_id` no permitido, sube |  |
  | `updates_duplicate` | **0** | ingress sin duplicados (re-ingress por reintento del cliente) | acumulativo |
  | `egress_sent` | **9** | 9 respuestas egresadas; 1:1 con `updates_allowed` al cierre (sin perder ninguna) | acumulativo |
  | `retry` | **0** | egress sin reintentos sostenidos | acumulativo |
  | `dead` | **0** | DLQ cerrada para este bridge | acumulativo |
  | `ambiguous` | **0** | ACK gate limpio (sin respuestas 2xx ilegibles / timeouts / 429→prepared) | acumulativo |

- **V2 Telegram = 0** sobre los 4 pendientes iniciales (`socrates`, `kratos`,
  `salva`, `vulcano`) tras un ciclo de watchdog y reselección de workers en el
  host `kratos`. tmux presente para los cuatro; ningún poller V2 quedó sobre los
  4 pendientes.
- **Topología Clawbus:** `socrates`=connector, `kratos`=native, `salva`=native,
  `vulcano`=connector (los 4 pendientes); `janus`=connector (`clawbus-oc`,
  post-remediación 2026-07-23); `kant` aparte (cc_connector + canal propio).
  MCP global Clawbus ausente en todos los launchers.
- **Runtime persistente** bajo `/datos/agent-v2/clawbus-runtime`; el wrapper
  `/datos/agent-v2/bin/ensure-cc-connectors.sh` apunta al bundle;
  `ensure-ut-workers.sh` y `ut-workers.tsv` apuntan a
  `/home/dev/.local/bin/<alias>`.

### Incidente y remediación 2026-07-23 — Janus

`janus` mantenía `channels.telegram.enabled=true` en su launcher OpenClaw
mientras V3 ya estaba activo sobre los 12 alias — riesgo de doble polling que
`poll_fenced` no detectaba. Remediación oficial vía CLI:

```sh
openclaw config set channels.telegram.enabled false --strict-json
```

Validación post: `openclaw config validate` PASS, hot reload
`configured=true,running=false`, **sin restart**, gateway healthy, `clawbus-oc`
connector Janus = **1**. Detalle completo e implicaciones operativas en
`../../../docs/handoffs/HANDOFF-CAUCE-V3-TELEGRAM-CUTOVER-2026-07-23.md` §8.

### Pendientes reales

- **Validación humana por alias** la está haciendo Steven en vivo. Es la única
  prueba que admite el release porque el bridge publica métricas **agregadas sin
  labels por alias** → `updates_allowed++` no atribuye el DM a un alias concreto.
  Sin esa confirmación explícita, la suite no acredita release del bridge para
  cada alias — incluye **Janus** post-remediación.
- **Métricas sin labels** se conservan a propósito (privacidad): para distinguir
  round-trip por alias hace falta el round-trip humano explícito.
- **`poll_fenced` estable no es, por sí solo, prueba de ausencia de V2.** El
  caso Janus lo demuestra. El valor de cierre técnico **S3 = 986→986** en
  ventana 30 s sólo refleja ausencia de contención de lease V3; el contador
  puede seguir avanzando durante las pruebas humanas con el mismo patrón
  (detecciones discretas entre lecturas, no contención viva).
- **Contadores acumulativos al cierre técnico (S3):** `updates_allowed=9`,
  `updates_denied=1` (allowlist, no error de entrega, sin atribución por
  alias), `updates_duplicate=0`, `egress_sent=9`, `retry=0`, `dead=0`,
  `ambiguous=0`. Estos son **la foto del cierre**, no una cota: cada DM
  autorizado en una prueba humana los mueve, y eso es esperado.
