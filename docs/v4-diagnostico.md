# Diagnóstico V4: inventario de uso real de auditoría y diagnóstico

Medido el 12-oct-2026 en producción V3 (VPS del gateway) **en solo lectura**: `SELECT` sobre
PostgreSQL, `systemctl list-timers/show`, `journalctl`, API de Prometheus y `ls`/`wc` sobre ficheros.
Ninguna escritura, DDL ni reinicio. El documento solo contiene conteos, nombres de acciones y rutas de
código: ni mensajes, ni identificadores de personas, ni secretos.

Contexto de lo medido: producción aún está en el esquema V3 (la tabla `audit_events` no tiene
`company_id`), así que las columnas V4 no se pudieron medir; los conteos son de V3.

## Resumen y decisiones

| Mecanismo | Uso real medido | Decisión |
|---|---|---|
| `audit_events` (tabla) | 41 659 filas, 57 MB, desde el 22-jul; ~8 MB/mes | **Conservar sin poda por edad** (es candado de idempotencia y fuente de linaje) |
| Acciones de `audit_events` sin lector ni productor | 3 acciones sin productor localizado en el código | Conservar las filas; no hay nada que podar por edad. Documentar como histórico |
| JSONL de decisiones | 1 904 líneas en 1,4 MB; último uso 12-oct; **producción no escribe la tabla** | **Fusionar**: PG es la fuente; el JSONL pasa a ser opcional y nunca escribe si PG falla |
| Alertas de Prometheus (46 reglas) | 12 reglas distintas dispararon en 15 días; 1 firing ahora; **nadie las lee** | **Conservar reglas; cablear un único consumidor** (`cauce-alertas-al-bus.py` o equivalente) |
| `cauce-v3-medico-monitor` | Timer **disabled** desde el 8-sep (34 días sin correr) | **Podar** (retirar tras trasladar a V4 lo que aún se necesite) |
| `cauce-guardia-nocturna` | Corre cada 15 min, resultado correcto | Conservar un solo vigilante de entrega trabada; documentar o apagar (ver contradicción) |
| Telemetría OTel | Receptor OTLP sin una sola métrica aceptada | **Podar** receptor OTLP y exportador `debug`; conservar Prometheus directo |
| Telemetría de cuotas | 8 022 recolecciones, última hace segundos | **Conservar** (alimenta «Mis cuotas») |
| Cinco guardias de credenciales | Dos cadenas activas, una **falla en cada ejecución** | **Fusionar** en una sonda por host + un agregador + una CLI de acción |

## 1. `audit_events`

### Medición

- Total: 41 659 filas; primera 2026-07-22, última 2026-10-12. Por mes: jul 6 071, ago 10 892,
  sep 16 320, oct (12 días) 8 377.
- Toda la tabla cae dentro de la ventana de 90 días. El saneador (`observability_pruned`) borra
  `delivery.ack` con 30 días de antigüedad (`DISPOSABLE_AUDIT_ACTIONS`, `observability/policy.ts`);
  en las últimas 48 h `audit_events` borrados = 0, coherente con que la fila más antigua de
  `delivery.ack` es del 13-sep.
- Regla para V4: **no se poda por edad**. Las filas de `delivery.replay` y `agent_output.response` son
  estado que otras consultas necesitan (ver tabla). Ampliar la lista desechable es un cambio de código
  revisable, no una variable de entorno.

### Acciones en 90 días: conteo, último uso, productor y lector

«Lector lógico» = una consulta decide algo con la fila. «Solo listado» = únicamente la vista de
auditoría (`listAudit`, `packages/store/src/repository/observability.ts:78`, expuesta en
`services/gateway/src/routes/console.ts:595` y mostrada en `console/src/features/audit/AuditPanel.tsx`).

| Acción | Filas | Último | Productor | Lector lógico |
|---|---:|---|---|---|
| `message.publish` | 9 031 | 12-oct | `repository/messages/publishing.ts:444` | `messages/author.ts:32`, `messages/agent-roots.ts:87,105,149`, `human-message-lineage.ts:103` |
| `delivery.ack` | 7 806 | 12-oct | `repository/deliveries/acks.ts` | ninguno; es la única desechable (30 d) |
| `agent_document.denied` | 7 449 | 11-oct | rutas `services/gateway/src/console/agent-*.routes.ts` | solo listado |
| `agent_output.materialize` | 5 589 | 12-oct | `agents/chain-control/outputs.ts`, `materialization/persistence.ts` | solo listado |
| `agent_output.response` | 5 212 | 12-oct | `agents/chain-control/outputs.ts` | `observability/chain-sweep.ts:396,435`, `agents/fanin.ts:169`, `human-message-lineage.ts` |
| `agent_output.fanin` | 1 351 | 12-oct | `agents/fanin/materialization.ts` | solo listado |
| `egress.notify` | 1 171 | 12-oct | `agents/notifications.ts:126,382` | solo listado |
| `dlq.reconcile` | 696 | 2-sep | **sin productor en el código actual** (solo en `specs/001-orquestador-multi-harness/auditoria-propuesta.md`) | solo listado |
| `terminal.session.request/consume/close/revoked/input/resume/extended/authz_denied`, `terminal.control_taken/released` | 489/389/358/302/166/1/2/9/113/113 | 12-oct (`authz_denied` 7-oct) | `services/gateway/src/terminal/audit.ts` y `relay-proxy/*` | solo listado |
| `console.publish.head/prepare/confirm/expire` | 442/221/220/1 | 12-oct | `repository/messages.ts`, `config/publish-policy.ts` | `repository/messages.ts:410` (colisión de claves), `health/schema-console-publish-intent.ts` |
| `config.change` | 150 | 9-oct | `packages/store/src/configuration.ts` | `audit-summary.ts` (resumen en listado) |
| `agent_document.write/read` | 77/1 | 4-oct / 8-sep | rutas de consola y `agent-context-reconcile.ts` | solo listado |
| `delivery.replay` | 57 | 28-sep | `repository/messages.ts` (replay) | **candado de idempotencia** + detector de ciclos (`agent-roots.ts`, `chain-control/materialization/lineage.ts`) |
| `delivery.ack_timeout` | 57 | 8-sep | `observability/maintenance.ts` | solo listado (evidencia de por qué murió una entrega) |
| `delivery.progress` | 34 | 29-sep | `services/gateway/src/routes/agent-emission.ts` / `agent-emission.ts` | solo listado |
| `delivery.cancel` | 32 | 30-sep | rutas de cola de la consola | solo listado |
| `agent_chain.silence_sweep` | 29 | 23-sep | `observability/chain-sweep.ts:505` | solo listado |
| `delivery.parked_no_consumer` | 25 | 23-ago | `observability/maintenance.ts` | solo listado |
| `agent_profile.desired/adopted/write` | 19/7/3 | 5-sep / 8-sep / 5-sep | `agent-profile*.ts`, `repository/agents.ts` | `agent-profile-source.ts:45` (`desired`) |
| `delivery.lease_cap` | 14 | 23-sep | `observability/maintenance.ts` | solo listado |
| `agent_appearance.set` | 10 | 8-oct | `agent-preferences.ts` | solo listado |
| `delivery.late_result` | 6 | 23-ago | `repository/deliveries/acks.ts:549` | solo listado |
| `delivery.invariant_repair` | 2 | 5-sep | **sin productor localizado** | solo listado |
| `mcp.client_delegation.create` | 2 | 8-oct | **sin productor localizado con `rg`** (probable ruta en SQL o código fuera de `packages/`/`services/`) | solo listado |
| `blob.grant` | 1 | 29-sep | `repository/blob-entitlements.ts:87` | solo listado |
| `migration.dead_letter_backfill`, `outbox.reconcile.legacy_console_v1` | 1/1 | 30-jul / 28-ago | migración `018` y `deploy/runtime/reconcile-stale-console-outbox-core.mjs` | solo listado (históricas, una sola vez) |

### Problemas detectados

1. **Lectura limitada a lo propio.** `listAudit` filtra por el actor (y su sala/entregas), así que un
   dueño no ve a sus agentes; el filtro por trace actúa en el navegador. Ya es tarea P0 de §9
   (lectura por empresa y filtros en servidor).
2. **Tres acciones sin productor localizado** (`dlq.reconcile`, `delivery.invariant_repair`,
   `mcp.client_delegation.create`): vienen de código retirado o de operaciones manuales. No bloquean nada;
   documentarlas como históricas.
3. La mayoría de las acciones (la mayoría) solo las lee el listado: su valor es forense. Eso no justifica
   podarlas: las dos filas que sí son estado (`delivery.replay`, `agent_output.response`) se mezclan con
   ellas en la misma tabla, por eso la política es por lista blanca de acciones y no por edad.

### Decisión

**Conservar** la tabla y todas sus acciones. No añadir poda por edad. Mantener `delivery.ack` como única
acción desechable (30 días). Añadir para V4 `company_id`/`actor_human_id` (ya hechos) y el diagnóstico por
cadena (§9 P1).

## 2. JSONL de decisiones frente a su tabla PG

- **Dónde se escribe**: `services/decisiones/src/audit.ts` (`JsonlAudit`, 0600, rota a `.1` a 50 MiB;
  ruta configurada en `deploy/decisiones/compose.yaml:45` y `services/decisiones/src/config.ts:120`).
  El cableado está en `services/decisiones/src/server.ts:48-57`: primero `PostgresAudit.write` y después
  `jsonl.write`.
- **Medido en producción**: `auditoria.jsonl` con 1 904 líneas, 1,4 MB, de 2026-09-23 a 2026-10-12
  (origen `jev` 1 903, `prefiltro` 1). **Producción corre una imagen anterior que solo escribe el JSONL**:
  `audit_events` no contiene ninguna fila `decision.resolved` ni `decision.failed` (no aparecen entre las
  acciones de los últimos 90 días). La tabla PG de decisiones es, por tanto, código nuevo sin uso real aún.
- **Consumidores**: ninguno en el repositorio lee el JSONL (solo `tail` manual en
  `services/decisiones/README.md:316`). La única lectura de la versión PG es una prueba
  (`services/decisiones/test/company-isolation-postgres.test.ts:146`).
- **Problema**: en el código actual el orden es PG primero y JSONL después; si `PostgresAudit.write`
  lanza, el JSONL no se escribe. Eso es lo deseado como candado, pero hoy es una doble escritura sin que
  nadie use la segunda. Además el JSONL contiene `tenant`, `alias` y el digest del estado: duplica en
  un fichero por contenedor lo que PG ya guarda con empresa y host.
- **Decisión: fusionar.** PG es la única fuente. El JSONL pasa a ser opcional (por variable, apagado por
  defecto) y, si se mantiene, se escribe solo tras el éxito de PG. Retirar el `tail` del README a favor de
  `cauce diagnose`/consulta de `audit_events`.

## 3. Timers y servicios de guardia

### VPS (12-oct, 21:31 UTC)

Hay 57 timers de sistema, 16 de ellos de Cauce. Estado por los de Cauce con relación a guardia o
diagnóstico:

| Timer / servicio | Cadencia | Último disparo | Resultado |
|---|---|---|---|
| `cauce-cred-guard` | 30 min | 21:17 | **FALLA en cada ejecución** (código 1; 144 fallos en 3 días) |
| `cauce-cred-descompartir` | 10 min | 21:30 | correcto |
| `cauce-guardia-nocturna` | 15 min | 21:26 | correcto («ok: sin problemas») |
| `cauce-bootstrap-guard` | 1 h | 20:58 | **FALLA** (código 2) |
| `cauce-openclaw-gateway-guard` | 2 min | 21:30 | correcto |
| `cauce-openclaw-fallback-guard` | 15 min | 21:23 | correcto |
| `cauce-conversaciones-paralelas` | 1 h | 21:17 | correcto |
| `cauce-maintenance-observer` | 2 min | 21:30 | correcto |
| `cauce-v3-fleet-watchdog` | 10 min | 21:30 | correcto |
| `cauce-v3-host-backup-monitor` | diario | 18:46 | correcto |
| `cauce-v3-ci-local` | diario | 05:30 | **FALLA** |
| `cauce-v3-control-plane-backup` | diario | 03:33 | **FALLA** (destino NAS lleno) |
| `cauce-revividor-de-colas`, `cauce-panel-cadenas`, `cauce-fleet-v35-controller` | — | — | deshabilitados |
| `mcp-expansion` | — | 12-sep | sin próxima ejecución |

Unidades en estado `failed` además de las anteriores: `cauce-v4-backup-20261011`, `demeter-backup`,
`dumps-flota-offsite`, `vps-humanizar-backup`, `xenia-crm-offsite` (copias hacia el NAS; ya
documentado: el NAS está lleno).

### kratos (host manager, systemd de usuario)

Activos: `cred-guard.timer` (30 min, último 16:21 hora local, `rc=0 problemas=0`), `cauce-quien-consume`
(10 min), `cauce-audio-guard`, `cauce-v3-pr-hourly`, `cauce-respaldo-drive`, `polidin-guard`.
**Deshabilitados**: `cauce-v3-medico-monitor`, `cauce-cred-guard-kratos`, `cauce-ai-live`,
`cauce-attach-guard`, `cauce-v3-panel-guard`.

### Problemas detectados

1. **Los fallos de guardia no avisan a nadie.** `cauce-cred-guard`, `cauce-bootstrap-guard` y
   `cauce-v3-ci-local` están en `failed` sin `OnFailure=` ni consumidor: el único rastro es el journal.
2. **Contradicción documentada.** `DESACTIVADO-cauce-guardia-nocturna.md` (en `/etc/cauce-v3` del VPS) la
   declara desactivada el 6-ago porque el médico era un superconjunto; hoy la nocturna **sí corre** y el
   médico lleva 34 días apagado. Quedó un solo vigilante de entrega trabada y la documentación dice lo
   contrario.
3. `ops/guardias/README.md` lista 26 guardias; la mitad son manuales o están deshabilitadas en el host
   donde deberían correr, por lo que el README describe un diseño y no el estado real.

### Decisión

- **Conservar** los guardias que corren y acertaron: `openclaw-gateway-guard`, `openclaw-fallback-guard`,
  `fleet-watchdog`, `maintenance-observer`, `host-backup-monitor`, `conversaciones-paralelas`,
  `quien-consume`, `polidin-guard`.
- **Corregir** los tres que fallan siempre: o se arreglan o se retiran; un guardia que falla en cada
  vuelta es ruido. Añadir `OnFailure=` hacia el consumidor único de alertas (sección 4).
- **Podar** los deshabilitados sin uso desde hace semanas (`cauce-revividor-de-colas`,
  `cauce-panel-cadenas`, `mcp-expansion`) tras comprobar dependencias con `rg`.
- Reconciliar `ops/guardias/README.md` con esta tabla.

## 4. Alertas de `ops/observability`

- **Reglas**: 46 en 7 grupos (`ops/observability/alerts.yaml`): despachador 5, pasarela 7, arrendamientos y
  relay 3, colas 7, telegram 5, terminal 4, outbox 15. Las 46 evalúan con salud `ok`.
- **Disparos medidos** (Prometheus local, retención 15 días, serie `ALERTS`): dispararon 12 reglas
  distintas: `CauceBatchDeliveryBacklogAgeHigh`, `CauceDeliveryDlqGrowing`,
  `CauceGatewayWakePumpErrors`, `CauceInteractiveDeliveryBacklogAgeHigh`,
  `CauceOriginOutboxDlqActionableStale`, `CauceOutboxDlqUnclassified`,
  `CauceProfileRuntimeExpectationsDegraded`, `CauceTelegramLoopErrors`, `CauceTelegramPollerStale`,
  `CauceTelegramTargetDown`, `CauceTerminalPresenceStale`, `CauceWakeOutboxStalled`. **Ahora hay una en
  `firing`: `CauceProfileRuntimeExpectationsDegraded`.** Las 7 sondas (`up`) están sanas.
- **Consumidor**: ninguno. `ops/observability/prometheus.yaml` no tiene bloque `alerting:` (se retiró
  Alertmanager). El puente previsto, `ops/guardias/cauce-alertas-al-bus.py` (timer en
  `ops/guardias/systemd/cauce-alertas-al-bus.timer`, cada 5 min), **no existe como unidad instalada** ni en
  el VPS ni en kratos. Es decir: 12 alertas reales en 15 días y ninguna llegó a un humano.
- **Decisión: conservar las 46 reglas** (están medidas, sanas y algunas ya habrían avisado de problemas
  reales) y **cablear un único consumidor**: instalar el puente al bus como único canal de alertas y que
  `OnFailure=` de los guardias del apartado 3 apunte a él. No añadir otro receptor.

## 5. `cauce-v3-medico-monitor`

- **Productores**: script `ops/guardias/cauce-v3-medico-monitor` (≈220 kB) más
  `…-sondas-lib.py` y `…-reparacion-lib.py`; reutiliza `credential_health.py`
  (`cauce-v3-medico-monitor:49`).
- **Último uso medido**: estado y bitácora sin modificar desde el 8-sep (333 MB en el directorio de
  estado del médico, con decenas de copias `.bak` del ejecutable y de `evidencia-esperada.json`); timer
  `disabled`, `inactive (dead)`. 34 días sin correr sin consecuencia detectada.
- **Consumidores**: ninguno (escribe un libro de tareas y avisa por Telegram; nadie lo lee en código).
- **Problemas**: el ejecutable arrastra decenas de parches con respaldos junto a él, no hay prueba de que
  su superconjunto de detecciones siga siendo cierto, y la propia nocturna lo sustituye de hecho.
- **Decisión: podar.** Antes, extraer las detecciones que aún tengan sentido (poller trabado, DLQ,
  cuotas por agotarse) a reglas de Prometheus o a `cauce diagnose`; después borrar el ejecutable, sus dos
  librerías, su servicio/timer y la referencia en `ops/guardias/README.md`. `credential_health.py` se
  conserva (sección 7).

## 6. Telemetrías

| Telemetría | Medición | Decisión |
|---|---|---|
| Métricas Prometheus (`cauce-dispatcher`, `cauce-gateway`, `cauce-outbox`, `cauce-relay`, `cauce-telegram`) | 7 objetivos arriba, 1 091 series | **Conservar** (base de las 46 reglas) |
| OpenTelemetry collector (`ops/observability/otel-collector.yaml`, `deploy/compose.yaml:527`) | Receptor OTLP gRPC/HTTP sin métricas, spans ni logs aceptados; ningún servicio del repo exporta OTLP (`rg` solo lo encuentra en la propia config, el bootstrap del hospital y una prueba de configuración) | **Podar** receptor, exportador `debug` y el contenedor; si hace falta, mantener solo `health_check` y exportación Prometheus |
| Cuotas (`quota_collections` 8 022 filas, `quota_provider_reports` 34 719, `quota_window_samples` 89 523, `quota_window_state` 33) | Última recolección 12-oct 21:30; lectores en `packages/store/src/repository/quotas.ts` y `quota-accounts.ts` | **Conservar** |
| Tablas `respaldo_quota_kratos_zeus_20261005_*` | 4 tablas de respaldo puntual (790 a 7 880 filas) del 5-oct | **Podar** tras confirmar con el dueño que ya hay copia offsite (no son telemetría viva) |

## 7. Las cinco guardias de credenciales

| Pieza | Dónde corre | Qué produce | Quién consume |
|---|---|---|---|
| `credential_health.py` (166 líneas) | biblioteca en cada host que ejecuta una guardia | clasificación pura (vencimiento, huella, compartida) | `cred-guard.py`, `cauce-cred-guard-kratos.py`, `cauce-v3-medico-monitor:49`, `ops/tests/test_credential_health.py` |
| `cred-guard.py` (134 líneas) | VPS como `cauce-cred-guard` (sistema, 30 min) y kratos como `cred-guard.timer` (usuario, 30 min) | tabla por credencial y `problemas=N compartidas=M`; sale con 1 si hay muertas | solo humanos que lean el journal o `cred-guard.txt`; nadie en código |
| `cred-guard.sh` (10 líneas) | kratos (envuelve al anterior) | `cred-guard.txt` y línea en `cred-guard.log` (151 kB, sin rotar); **fuerza `exit 0`** | nadie |
| `cauce-cred-guard-kratos.py` (84 líneas) | hoy lo ejecuta el host server2 (el JSON remoto del VPS se renueva cada 15 min con `host: server2`); el timer de kratos está `disabled` | JSON de huellas y vencimientos en el VPS (`/var/lib/cauce-v3/cred-guard-kratos.json`) | `cred-guard.py` del VPS (lo lee como fila remota; STALE a los 60 min) |
| `cauce-credenciales` (165 líneas) + `ops/cli/cauce-credenciales.lib.sh` (699 líneas) | manual desde la CLI `cauce` (login, aprovisionar, retirar, renovar) | tabla y acciones de renovación | `ops/cli/cauce:745` carga la `lib`; el script suelto `ops/guardias/cauce-credenciales` solo lo ejecuta un humano |

### Problemas detectados

1. **El agregador del VPS falla en cada ejecución** (código 1, 144 fallos en 3 días): detecta una
   credencial Claude de un contenedor del VPS sin `refreshToken` y con un vencimiento que sale como
   «hace 497 733 h», es decir `expiresAt` ausente leído como 0. Hay un defecto de clasificación (un
   vencimiento ausente no debería contarse como «vencido hace 56 años») y nadie recibe el aviso.
2. **Solapamiento real**: `cred-guard.py` corre dos veces en hosts distintos con listas de objetivos
   distintas (`OBJETIVOS` en el fuente), y el README admite que hay que instalar una copia de
   `credential_health.py` por host. La parte «una sonda por host, un agregador» está bien pensada; la
   instalación a mano no.
3. **`cred-guard.sh` oculta el fallo** (`exit 0` explícito): su unidad nunca puede fallar ni alertar.
4. **`cauce-credenciales` duplica a `cauce-credenciales.lib.sh`**: ambos leen `container-aliases.json`,
   calculan huellas y detectan ficheros compartidos. La CLI `cauce` ya tiene `login`/`aprovisionar`/`retirar`
   sobre la lib, así que el script suelto es un segundo camino con lógica propia.
5. **La resolución de «quién gasta qué cuenta»** vive aparte en `cauce-quien-consume` (activo, 10 min);
   no es una de las cinco pero responde la pregunta que las anteriores no.
6. **Salva/server2**: la sonda remota está viva pero su timer de kratos no; el ejecutor real no está
   documentado en `ops/guardias/README.md`.

### Decisión

- **Fusionar** en tres piezas: (a) `credential_health.py` como única autoridad de clasificación (corregir
  el vencimiento ausente), (b) una sola sonda por host (hoy `cred-guard.py` + `cauce-cred-guard-kratos.py`
  son la misma lógica con distintos `OBJETIVOS`; unificarlas con la lista por host) cuyo resultado se
  empuja al agregador, (c) la acción de renovación solo en `ops/cli/cauce-credenciales.lib.sh`.
- **Podar**: `ops/guardias/cred-guard.sh` (envoltorio que oculta el código de salida),
  `ops/guardias/cauce-credenciales` (el script suelto) y su unidad. Antes: `rg` sobre
  `ops/guardias/systemd/cred-guard.service` (que lo invoca), `scripts/calidad-base.json:394-396,378`,
  `ruff.toml:9` y `ops/tests/shebang-discovery.test.mjs:40`, que referencian los ficheros.
- **Conservar** `credential_health.py` y `ops/tests/test_credential_health.py`.
- **Corregir antes de podar**: el aviso de credencial muerta debe llegar al consumidor único de alertas
  (sección 4) en vez de a un `exit 1` sin destinatario.

## Siguientes pasos

1. Cablear el puente de alertas y `OnFailure=` (sección 4); es lo que hace que lo demás sirva.
2. Corregir el vencimiento ausente en `credential_health.py` y fusionar las sondas (sección 7).
3. Podar médico, OTel, `cred-guard.sh`, `cauce-credenciales` suelto, units deshabilitadas y tablas
   `respaldo_quota_*` con `git diff --diff-filter=D` y `rg` sin referencias residuales.
4. Fusionar el JSONL de decisiones (sección 2) con una prueba de que, si falla PG, no se escribe JSONL.
5. Re-medir el uso de las acciones de `audit_events` tras el despliegue V4 con las columnas de empresa.

Fuera de este inventario: el «lector V3 de contextos» citado en `GOAL.md` §9 no se midió aquí; se
revisa con la tarea de contextos.
