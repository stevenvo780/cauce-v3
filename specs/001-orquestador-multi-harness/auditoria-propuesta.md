# T051 — Auditoría de mutaciones: estado actual y propuesta

Fecha: 2026-09-28. Idioma: español. Alcance: solo lectura del código + este fichero.
No se creó ninguna migración ni se tocó `packages/store/migrations`.

## Respuesta corta

Sí, la auditoría de mutaciones es consultable hoy (quién / qué / cuándo):

- **Qué**: casi todas las mutaciones dejan fila en `audit_events`, con
  `tenant_id`, `actor_alias`, `action`, `decision`, `trace_id`, `metadata`,
  `created_at`.
- **Cómo**: `GET /v3/console/audit` (paginación keyset `limit` + `before`) y
  la pestaña «Auditoría» de «Señales y auditoría» (`/observability`) en la
  consola. El alias `/audit` redirige ahí.
- **Límites**: sin filtros de servidor (la búsqueda es en el navegador sobre
  lo ya cargado), el `summary` es una allowlist que oculta el motivo escrito
  a mano, y dos mutaciones no dejan fila: creación de jobs e ingesta de
  cuotas. No falta ninguna tabla: ver §5.

## 1. Estado actual (con fichero:línea)

### 1.1 Store: tabla y escritura

- Esquema: `packages/store/migrations/001_initial.sql:194-208`.
  Columnas: `id bigserial PK`, `tenant_id`, `actor_alias`, `action NOT NULL`,
  `decision CHECK (allow,deny,info)`, `request_id`, `message_id`,
  `delivery_id`, `trace_id`, `metadata jsonb`, `created_at`.
  Índices: `audit_events_trace_idx (trace_id, created_at)` y
  `audit_events_tenant_idx (tenant_id, created_at DESC)` (:207-208),
  más BRIN sobre `created_at` (`014_observability_retention.sql:65-66`),
  índice `(delivery_id,id)` (`030_dlq_causal_reconciliation.sql:59-60`) y
  cuatro índices de expresión solo para `console.publish.*`
  (`037_console_publish_intent_indexes.sql:21-55`).
- Lectura: `packages/store/src/repository/observability.ts:48-114`
  (`listAudit`). Exige permiso `read`, `limit` 1–500, cursor `before` bigint
  canónico. Filtro de visibilidad por participante (:80-91): fila propia
  `(tenant_id, actor_alias)` del actor, o mensaje de una sala del actor, o
  delivery donde el actor es destinatario. Orden `id DESC`, `limit+1` para
  `next_cursor`.
- Resumen saneado: `packages/store/src/audit-summary.ts:49-71`
  (`safeAuditSummary`). Nunca devuelve el objeto original: allowlist
  `SAFE_SCALARS` (:5-19) + conteos de `recipients`/`cohort` (:21-24) +
  `summary` textual solo para `config.change`/`config.rollback` (:54-57).
  Todo lo demás (motivo manuscrito, hashes, rutas, cuerpos) se omite.
- Retención: `packages/store/src/repository/observability/policy.ts:110-146`.
  Solo `delivery.ack` es podable (`DISPOSABLE_AUDIT_ACTIONS`, :146):
  renovaciones 6 h, resto 30 d (:111-118). Cualquier otra acción, NUNCA
  (:77 de `014_observability_retention.sql`). Borrado por lotes en
  `packages/store/src/repository/observability/maintenance.ts:346-357`.
  `audit_events` es ESTADO del que dependen guardas (replay idempotente,
  correlación de respuestas), no un log; cita explícita en
  `policy.ts:124-145`.

### 1.2 Gateway: ruta de consulta

- `services/gateway/src/routes/console.ts:507-514`:
  `GET /v3/console/audit` → `principal` + `requirePermission('read')` +
  `parseAuditQuery` + `repository.listAudit` + `safeAuditPage`.
- `services/gateway/src/routes/console/helpers.ts:45-70` (`parseAuditQuery`):
  solo acepta `limit` (defecto 100) y `before`. Cualquier otro campo
  (`action`, `trace`, `actor`, …) → `invalid_input`. No hay filtro de
  servidor.
- `services/gateway/src/facades.ts:144-168` (`safeAuditPage`): segunda
  allowlist para el navegador. Proyecta `event_id, at, tenant_id,
  actor_alias, action, decision, request_id, trace_id, summary`; revalida el
  `summary` contra `safeAuditSummary` (:129-136). Nunca refleja `metadata`
  cruda. No filtra por `tenant_id` porque el repositorio ya devuelve filas
  cruzadas de participante (:139-143).

### 1.3 Consola: render

- Cliente: `console/src/api/client/system-client.ts:43-60` (`listAudit`):
  valida `limit` 1–500 y cursor bigint canónico, pide
  `/v3/console/audit?limit&before`.
- Vista: `console/src/features/audit/AuditPanel.tsx`. Primera página
  `limit: 100` (:27), «Cargar anteriores» con cursor (:83), validación de
  cursor monótono (:86-91), deduplicación por `event_id` (:94-100).
- Búsqueda SOLO en navegador sobre 6 campos
  (`action, actor_alias, tenant_id, request_id, trace_id, summary`, :119-120)
  y SOLO sobre lo cargado; con páginas pendientes el aviso lo dice
  explícitamente (:121-123, :135, :144-148).
- Ubicación: pestaña «Auditoría» de `ObservabilityPage`
  (`console/src/features/observability/ObservabilityPage.tsx:20-24,138-139`);
  no pide el log hasta abrir la pestaña (test en
  `ObservabilityPage.test.tsx:208-215`). `/audit` reescribe a
  `/observability` conservando la pestaña (`console/src/App.tsx:111,242-246`;
  test `audit-enlace-directo.test.tsx:8-16`). Fila: icono por decisión,
  badge allow/deny/UNKNOWN, `readableAuditSummary`, tarjeta
  actor·tenant·request·trace·fecha (`AuditPanel.tsx:152-158`).

### 1.4 Qué mutaciones dejan fila (inventario)

| Mutación (ruta / origen) | `action` | Escritura |
|---|---|---|
| `POST /v3/console/config/changes` | `config.change` | `packages/store/src/configuration.ts:183` (INSERT :338) |
| `POST …/config/revisions/:id/rollback` | `config.rollback` | `configuration.ts:242` (INSERT :338) |
| `PUT …/agents/:a/perfil` (capa store) | `agent_profile.desired`, `agent_profile.applied` | `packages/store/src/agent-profile.ts:184,241` (INSERT :277) |
| `PUT …/agents/:a/perfil` (capa ruta) | `agent_profile.write` / deny→`agent_document.denied` | `services/gateway/src/console/agent-profile.routes.ts:292` via `recordAudit` (`routes/console.ts:318`) |
| Lectura contenido real documento | `agent_document.read` (solo contenido real, no inventario) | `agent-documents.routes.ts:526` |
| `PUT …/documents/:kind/content` | `agent_document.write` | `agent-documents.routes.ts:755` |
| Denegaciones documentos | `agent_document.denied` | `agent-documents.routes.ts:364` |
| `POST …/context/reload` | allow→`agent_document.write`, deny→`agent_document.denied` | `agent-context-reload.routes.ts:272` (via `fila`, :265-276) |
| `POST …/context/reconcile/apply` | `agent_document.write` | `packages/store/src/repository/agent-context-reconcile.ts:159-160` |
| `POST /v3/console/messages` | `message.publish` | `messages/publishing.ts:351-352` |
| Intents consola (prepare / confirm / expire / head) | `console.publish.prepare`, `.confirm`, `.expire`, `.head` | `messages.ts:377`, `messages.ts:509`, `config/publish-policy.ts:537,437` |
| ACK aplicado | `delivery.ack` | `deliveries/acks.ts:213-214,443-445` |
| Resultado tardío | `delivery.late_result` | `deliveries/acks.ts:535-537` |
| `POST …/deliveries/:id/cancel` | `delivery.cancel` | `deliveries/control.ts:130-132` |
| `POST …/deliveries/:id/replay` | `delivery.replay` | `outbox/operator.ts:213-215` |
| Progreso agente | `delivery.progress` (info) | `agent-emission.ts:98-99` |
| Sin consumidor / techo lease / timeout ACK (barrido) | `delivery.parked_no_consumer`, `delivery.lease_cap`, `delivery.ack_timeout` | `observability/maintenance.ts:156-158,235-237` (literal :233) |
| Egress notify (admitido / denegado) | `egress.notify` allow/deny | `agents/notifications.ts:354-355,109-110` |
| Respuesta agente (fan-in) | `agent_output.response` allow/deny | `agents/fanin/response.ts:284-286,463-465,566-568` |
| Fan-in / materialización | `agent_output.fanin`, `agent_output.materialize` allow/deny | `fanin/materialization.ts:290-292`, `chain-control/outputs.ts:259-261`, `chain-control/materialization/persistence.ts:94-96` |
| Chain gates (abrir / responder / cancelar) | `agent_chain.gate_opened`, `.gate_answered`, `.gate_cancelled` | `chain-control/outputs.ts:104-106`, `chain-control.ts:200-202,265-267` |
| Barrido de silencio | `agent_chain.silence_sweep` (info) | `observability/chain-sweep.ts:495-497` |
| Adopción perfil runtime | `agent_profile.adopted` | `repository/agents.ts:166-168` |
| DLQ (reconciliar / reabrir / resolver sin replay) | `dlq.reconcile`, `dlq.reopen`, `dlq.resolve_without_replay` | `030_dlq_causal_reconciliation.sql:1285,1390,1876` (funciones SQL) |
| Backfill migración | `migration.dead_letter_backfill` | `018_terminal_recovery_backfill.sql:90` |
| Terminal: solicitar sesión (allow/deny) | `terminal.session.request` | `terminal/session-control.ts:214,280,424,525` |
| Terminal: consumir / reanudar / cerrar / input | `terminal.session.consume`, `.resume`, `.close`, `.input` | `terminal/relay-proxy/consume.ts:108,194`, `resume.ts:111,138,170`, `close.ts:89,128,147` |
| Terminal: extender / rotar dueño / revocar | `terminal.session.extended`, `.owner_rotated`, `.revoked` | `session-control/extend.ts:85`, `browser-owner.ts:66,157` |
| Terminal: tomar / soltar control TUI | `terminal.control_taken`, `.control_released` | `session-control/control.ts:54,233` |
| Escritor terminal genérico | (todas las anteriores + documentos) | `terminal/audit.ts:41-54`, `terminal/plugin.ts:243` (versión transaccional) |
| Secretos (publicar clave / grant / leer / revocar / denegar) | `secret.key_published`, `secret.granted`, `secret.read`, `secret.revoked`, `secret.denied` | `secret-handoff/routes.ts:262,378,439,483,226` via `auditOn` (:197-209), INSERT `secret-handoff/audit.ts:124-139` |

Notas:

- `decision` distingue `allow` / `deny` / `info`; los `deny` son
  denegaciones realas (documentos, reload, egress, respuestas, secretos),
  no errores de validación de shape.
- `secret.denied` lleva throttle por emisor y ventana (primera de cada
  motivo + potencias de 2): `secret-handoff/audit.ts:63-112`.
  Las denegaciones de secretos son MUESTRA, no censo.
- `agent_document.read` solo se escribe al leer contenido real
  (test `agent-documents.read.test.ts:438`); el inventario no deja fila.

## 2. Cómo se consulta hoy (quién / qué / cuándo)

- **Quién**: `tenant_id` + `actor_alias` de la fila = el principal
  autenticado que mutó (o el alias dueño en escrituras de sistema como
  `agent_output.*`, `delivery.*`). El operador/actor humano detrás de una
  sesión PTY viaja en `metadata.operator_id`, pero ese campo NO está en la
  allowlist del `summary` (ver H5).
- **Qué**: `action` + `decision` + `summary` (JSON allowlistado). El motivo
  escrito a mano (`reason`) queda en `metadata` cruda en Postgres, pero NO
  sale por la API ni se pinta en la consola.
- **Cuándo**: `at` (`created_at`), orden `id DESC`, paginación keyset con
  `next_cursor` (`observability.ts:95-113`).
- **Visibilidad**: solo lo propio + mensajes de mis salas + deliveries
  donde soy destinatario (`observability.ts:80-91`). No hay rol «auditor
  global»: nadie ve todo el log desde la API.
- **Correlación**: `trace_id` y `request_id` se exponen y se filtran en el
  navegador; el botón «Ver auditoría» de un relay lleva el `trace_id` al
  filtro (`ObservabilityPage.tsx:125-126`). Pero si la traza está en páginas
  aún no cargadas, hay que pulsar «Cargar anteriores» a mano.

## 3. Huecos

1. **H1 — `POST /v3/console/jobs` no deja fila.** `jobs.ts:21` inserta en
   `jobs` sin `INSERT INTO audit_events`. `job.create` solo existe como
   cadena de capability (`routes/console/access.ts:35`), nunca como fila.
   Quién encoló un job interactivo no es consultable.
2. **H2 — `POST /v3/quotas/samples` no deja fila.** Cuatro `INSERT` en
   `quota_*` (`repository/quotas.ts:478,531,577,591`) sin auditoría.
   Ingesta máquina-a-máquina; al menos una fila `info` por colección
   (host, proveedor, ventanas) haría consultable «qué midió quién».
3. **H3 — Sin filtros de servidor.** `parseAuditQuery` rechaza todo lo que
   no sea `limit`/`before` (`helpers.ts:50-52`). Buscar por `action`,
   `trace_id`, `actor` o `delivery_id` exige paginar a mano y filtrar en
   el navegador. Para trazas viejas o actores ruidosos, la consulta es
   impracticable.
4. **H4 — Visibilidad ciega para secretos y terminal ajena.** Las filas
   `secret.*` llevan `tenant_id`/`actor_alias` del AGENTE emisor y ni
   `message_id` ni `delivery_id`; el filtro de `listAudit`
   (`observability.ts:80-91`) las oculta a cualquier operador humano que
   no sea ese alias. Igual para `terminal.session.*` creada por otro
   operador. Un operador no puede auditar el traspaso de secretos ni las
   sesiones PTY de otros.
5. **H5 — El «por qué» no sale por la API.** El motivo manuscrito
   (`reason`), `operator_id`, `label` del secreto y hashes viven en
   `metadata` cruda pero no están en `SAFE_SCALARS`
   (`audit-summary.ts:5-19`) ni en `SecretAuditFacts`→`summary`. La consola
   muestra quién autorizó, pero no el texto con el que lo justificó.
6. **H6 — Sin endpoint de detalle ni exportación.** No existe
   `GET /v3/console/audit/:eventId` ni volcado. Cada fila solo es visible
   dentro de la página que la contiene; no se puede enlazar una fila.
7. **H7 — Índice ausente para la consulta principal.** La consulta filtra
   `(tenant_id, actor_alias)` + `OR` + `JOIN`, pero solo existen
   `(trace_id, created_at)` y `(tenant_id, created_at)` más el BRIN
   (`001_initial.sql:207-208`, `014:65-66`). Falta
   `(tenant_id, actor_alias, id DESC)`; con volumen, el `ORDER BY id DESC
   LIMIT` sobre el `OR` se degrada.
8. **H8 — `secret.denied` es muestra, no censo** (`audit.ts:97-112`).
   Documentado y deliberado (anti-inundación), pero una investigación de
   denegaciones de secretos no puede contar intentos exactos; solo el
   `denials_in_window` del momento.
9. **H9 — Retención asimétrica asumida.** `delivery.ack` se poda (6 h / 30 d)
   y el resto nunca (`policy.ts:146`). Correcto como decisión (las guardas
   dependen de las filas), pero conviene que la propuesta lo deje por
   escrito: cualquier filtro nuevo sobre `delivery.ack` viejo debe asumir
   ausencia, no fallo.

No son huecos (verificado, no requieren acción):

- `dry_run=true` en config no audita: hace rollback y no guarda nada; es
  lo correcto.
- Los `GET` no auditan salvo `agent_document.read` de contenido real; es
  lo correcto.
- `delivery.ack_timeout` / `delivery.lease_cap` sí dejan fila
  (`maintenance.ts:233-237`), aunque nada las lea: son evidencia rara y
  barata, deliberadamente conservadas (`policy.ts:137-140`).

## 4. Propuesta (sin tabla nueva)

No se propone ninguna tabla ni migración de esquema salvo UN índice
opcional (texto en §5). Todo lo demás es código sobre `audit_events`:

1. **P1 — Fila `job.create`.** En la creación de jobs
   (`packages/store/src/repository/jobs.ts`, junto al `INSERT` de :21),
   insertar `('job.create','allow')` con `tenant_id`/`actor_alias` del
   autor y `metadata` mínima (`job_id`, `lane`, `kind`). Consultable de
   inmediato con la ruta actual.
2. **P2 — Fila `quota.sample` (info).** En la ingesta
   (`repository/quotas.ts`, tras el `INSERT` de colección :478), insertar
   una fila `info` por colección (`host`, `provider_count`,
   `window_count`, `collection_id`). Volumen: una por ejecución del
   colector, despreciable frente a `delivery.ack`.
3. **P3 — Filtros de servidor en `GET /v3/console/audit`.**
   Extender `parseAuditQuery` (`helpers.ts:45-70`) con `action`,
   `actor`, `trace_id`, `delivery_id` (todos opcionales, allowlist de
   formato como la existente) y aplicarlos en `listAudit`
   (`observability.ts:76-93`). La consola pasaría el filtro del relay
   (`ObservabilityPage.tsx:125-126`) al servidor en vez de paginar a mano.
   Mantener `limit`/`before` y `safeAuditPage` sin cambios.
4. **P4 — `reason` y `operator_id` en el `summary` (acotados).**
   Añadir a `SAFE_SCALARS` o como caso especial como `config.summary`
   (`audit-summary.ts:54-57`): `reason` (texto limpio, ≤180 caracteres,
   igual que `summary`) y `operator_id` (validado contra patrón de
   operador). Así la consola muestra el «por qué» sin exponer cuerpos,
   rutas de credencial ni bytes. `label` del secreto: NO (nombra la
   credencial; queda en metadata cruda para SQL directo).
5. **P5 — Rol lector de auditoría ajena (opcional, con decisión).**
   Para H4, dos caminos: (a) un permiso nuevo (p. ej. `audit`) que
   amplíe el `WHERE` de `listAudit` a todo el tenant del lector; (b)
   no hacer nada y documentar que secretos/terminal ajena solo se
   auditan vía SQL directo. Requiere decisión de producto; por defecto
   se propone (b) + documentar, porque (a) cambia el modelo de
   visibilidad participante-a-participante.
6. **P6 — Índice `(tenant_id, actor_alias, id DESC)`.** Ver §5.

Fuera de alcance explícito: endpoint de detalle por `event_id` (H6),
exportación/volcado, y cambios en retención (H9). Si se piden, son
propuestas separadas.

## 5. Spec aparte: migración (solo texto, no creada)

**Veredicto: NO falta ninguna tabla.** `audit_events` cubre quién/qué/cuándo
para todas las mutaciones existentes y las dos que faltan (P1, P2) son filas
nuevas, no tablas nuevas. No se crea ni se necesita migración de tabla.

La única migración de esquema que se propone, como texto y pendiente de
aprobación, es un índice para sostener P3 y la consulta principal (H7):

```sql
-- Propuesta (NO aplicada, NO creada como fichero de migración):
-- Sostiene el filtro (tenant_id, actor_alias) + ORDER BY id DESC de
-- listAudit (packages/store/src/repository/observability.ts:80-93)
-- y los futuros filtros de servidor P3.
CREATE INDEX IF NOT EXISTS audit_events_tenant_actor_id_idx
  ON audit_events (tenant_id, actor_alias, id DESC);
```

Criterio de aceptación: `EXPLAIN` de la consulta de `listAudit` con un
actor ruidoso usa el índice y evita ordenación externa; sin él, P3 igual
funciona pero H7 persiste. Si se rechaza el índice, el resto de la
propuesta (P1–P5) no lo necesita.
