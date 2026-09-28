# Escenarios esenciales → casos del arnés

Mapeo de los 5 escenarios esenciales de `docs/flota-y-participantes.md`
(§ «Los 5 escenarios esenciales») a casos del arnés de `ops/harness/`.

Fuentes: `runner.mjs` (casos con nombre exacto entre comillas),
`adapter-roundtrip.mjs` (ejercido solo vía el caso fan-out del runner),
`fleet.mjs` (fixture `topology`, sin casos propios: no ejecuta nada).

Notas de lectura:

- Ningún caso del arnés menciona Telegram, TUI/CLI, OpenClaw, graf, demeter,
  recurrentes, ventas, Xenia, esfuerzos, credenciales ni rollouts.
- El arnés cubre el transporte genérico (publicar → entregar → ack → relay),
  no la semántica de negocio de cada escenario.
- Los casos de reinicio solo existen con `CAUCE_FAULT_MODE=compose`.
- El caso fan-out de adaptadores solo existe con
  `CAUCE_ADAPTER_ROUNDTRIP_CONFIRM=ephemeral-only` en loopback.

## Escenario 1 — Steven→argos por Telegram → argos delega → resultado por Telegram

Precondición: gateway real vivo (`runner.mjs --live`); `Steven/argos` existe en
`fleet.mjs` (`grp.steven`); `Steven/kant` como actor de consola/estado.

Pasos del arnés que lo ejercen:

- `asynchronous wake and push delivery` — `Steven/argos` publica, el
  destinatario recibe `wake` + `delivery` y confirma `done`.
- `origin relay uses authenticated context correlation` — el resultado del
  `ack done` queda correlacionado en `origin-relays`.
- `OpenCode adapter process fan-out, duplicate publish, and tenant isolation` —
  único caso con delegación real (fan-out a 2 ramas con adaptadores
  construidos, barrera concurrente y relay final correlacionado por nonce).
- `ACK accepted-started-done rejects duplicate and out-of-order` — ciclo de
  vida del ack del delegado (`accepted` → `started` → `done`, duplicados
  rechazados).
- `idempotency suppresses duplicate and rejects mutation` — publicación
  duplicada suprimida, mutación con la misma clave rechazada con 409.
- `complete Steven/Isa/Jhon/Pablo/Miguel ACL matrix` — permiso
  Steven→Steven y Steven→otros verificado en la matriz 5×5.
- `database restart preserves queued delivery` — publica `Steven/argos`→
  `Miguel/janus`; entrega preservada tras reinicio de PostgreSQL.

Efecto esperado en BD: mensaje persistido con `idempotency_key`; `delivery`
entregado y en estado `done`; relay en `origin-relays` con correlación
(`request_id`, `message_id`, `delivery_id`, `trace_id`); en fan-out, cadena con
2 aristas en estado `materialized` y contadores `open_branches: 0`,
`rejected_branches: 0`.

Huecos (lo que NO cubre ningún caso):

- Telegram, tanto entrada (Steven→argos) como salida (resultado por Telegram).
- La delegación propia de argos: a quién delega y con qué ramas; el fan-out
  del arnés usa alias QA (`qa-opencode`, `qa-reviewer-a/b`), no argos.
- El contenido de negocio (nuevo cliente / software / deploy).
- `Steven/argos` como receptor: ningún caso le entrega un mensaje válido
  (solo aparece como receptor en el camino negativo de
  `zero recipient is no_route and identity fields are rejected`).

## Escenario 2 — Miguel→janus (graf, demeter, recurrentes) → delega → Telegram

Precondición: gateway real vivo; `Miguel/janus` existe en `fleet.mjs`
(`grp.miguel`).

Pasos del arnés que lo ejercen:

- `ACK accepted-started-done rejects duplicate and out-of-order` —
  `Miguel/kratos`→`Miguel/janus`; janus recibe y completa el ciclo ack con
  resultado.
- `database restart preserves queued delivery` — `Steven/argos`→`Miguel/janus`;
  entrega durable a janus tras reinicio de PostgreSQL.
- `origin relay uses authenticated context correlation` — relay del resultado
  (con otros actores, mismo mecanismo).
- `OpenCode adapter process fan-out, duplicate publish, and tenant isolation` —
  delegación fan-out genérica (alias QA, mismo mecanismo de delegación).
- `complete Steven/Isa/Jhon/Pablo/Miguel ACL matrix` — Miguel→Miguel permitido;
  Miguel→Jhon/Isa/Pablo denegado con 403.

Efecto esperado en BD: `delivery` a janus en `done` con `result`; relay
correlacionado en `origin-relays`; publicaciones entre tenants no autorizadas
rechazadas sin escritura de mensaje.

Huecos (lo que NO cubre ningún caso):

- Telegram (entrada de Miguel y salida del resultado).
- La delegación propia de janus: janus solo aparece como receptor, nunca como
  emisor delegante en ningún caso.
- Los dominios graf, demeter y recurrentes: ningún caso los nombra ni publica
  cuerpo de negocio.
- Trabajos recurrentes o programados: sin cobertura.

## Escenario 3 — Jhon→hegel (ventas, Xenia) → delega → Telegram

Precondición: gateway real vivo; `Jhon/hegel` existe en `fleet.mjs`
(`grp.jhon`).

Pasos del arnés que lo ejercen:

- `asynchronous wake and push delivery` — `Steven/argos`→`Jhon/hegel`; hegel
  recibe `wake` + `delivery` y confirma `done`.
- `origin relay uses authenticated context correlation` — relay del resultado
  (con otros actores, mismo mecanismo).
- `OpenCode adapter process fan-out, duplicate publish, and tenant isolation` —
  delegación fan-out genérica (alias QA, mismo mecanismo de delegación).
- `complete Steven/Isa/Jhon/Pablo/Miguel ACL matrix` — Jhon→Jhon y
  Steven→Jhon permitidos; Jhon→Miguel/Isa/Pablo denegados con 403.

Efecto esperado en BD: mensaje y `delivery` a hegel persistidos, `delivery` en
`done`; relay correlacionado en `origin-relays`.

Huecos (lo que NO cubre ningún caso):

- Telegram (entrada de Jhon y salida del resultado).
- Ventas y Xenia: ningún caso los nombra ni publica cuerpo de negocio.
- hegel como emisor delegante: hegel solo aparece como receptor, nunca delega
  en ningún caso.
- La delegación hegel→tales/heraclito: `tales` y `heraclito` ni siquiera
  existen en `fleet.mjs`.

## Escenario 4 — Steven→jarvis personal por los canales configurados, sin bloquear OpenClaw

Precondición: gateway real vivo; `Steven/jarvis` existe en `fleet.mjs`
(`grp.steven`).

Pasos del arnés que lo ejercen:

- `offline durable queue delivers on connect` — `Steven/jarvis` publica a
  `Isa/salva`; entrega diferida al conectar con `attempt: 1` y `ack done`.
- `zero recipient is no_route and identity fields are rejected` —
  `Steven/jarvis` publica; lista vacía rechazada con 422 `no_route` e
  identidad forjada rechazada con 400.
- `gateway restart preserves queued PostgreSQL delivery` —
  `Steven/jarvis`→`Pablo/seneca`; entrega preservada tras reinicio del gateway
  (requiere `CAUCE_FAULT_MODE=compose`).
- `lane priority and bounded fairness on real dispatcher` — lo más cercano a
  «no bloquear»: prioridades y fairness acotada del dispatcher (ráfaga
  interactiva ≤ 3 antes de servir `batch`), pero sobre jobs de consola.
- `15 aliases and four harness kinds over real WS` — jarvis conecta por WS
  real como uno de los alias con presencia `online: true/false`.

Efecto esperado en BD: mensajes publicados por jarvis persistidos con
idempotencia; jobs con `lane`/`priority` y `claimed_at` ordenado por
prioridad dentro de `interactive`; presencia `online/offline` en estado.

Huecos (lo que NO cubre ningún caso):

- Los «canales configurados»: ningún caso nombra ni ejercita canales de
  entrada/salida de jarvis (Telegram u otros).
- OpenClaw y la no-interferencia: ningún caso nombra OpenClaw ni mide
  bloqueo, interferencia o concurrencia entre jarvis y otro trabajo.
- Steven→jarvis como receptor personal: jarvis solo actúa como emisor en los
  casos; ningún caso le entrega un mensaje.
- Lo «personal» (aislamiento respecto al tráfico de flota): sin cobertura.

## Escenario 5 — Operación por TUI/CLI (esfuerzos, destrabar, prioridades, credenciales, rollouts)

Precondición: consola `/v3/console` accesible con actor `Steven/kant`; gateway
y PostgreSQL reales vivos.

Pasos del arnés que lo ejercen:

- `console facades reflect real core state` — `GET` sobre
  `topology/messages/queues/jobs/adapters/audit` refleja estado real del núcleo.
- `retry backoff exhausts into DLQ` — reintentos `failed`+`retryable` con
  `attempt` 1→2→3 hasta `dead`; visible en `/v3/console/queues`.
- `lane priority and bounded fairness on real dispatcher` — `POST`/`GET`
  `/v3/console/jobs`; prioridades y fairness acotada (vía de «prioridades»).
- `lost ACK redelivers after reconnect` — redelivery con `attempt` mayor tras
  reconexión (destrabe por reconexión, con backoff de 30 s + espera de 45 s).
- `gateway restart preserves queued PostgreSQL delivery` y
  `database restart preserves queued delivery` — rescate por reinicio con
  entregas preservadas (requieren `CAUCE_FAULT_MODE=compose`).
- `presence derives from heartbeat lease` y
  `double consumer rejected and fencing retained` — presencia y fencing
  observables desde consola/estado.

Efecto esperado en BD: colas con estados `retry`/`dead` consultables;
jobs en `done` con orden de `claimed_at`; presencia derivada del lease de
heartbeat; entregas en cola preservadas tras reinicio de gateway o BD.

Huecos (lo que NO cubre ningún caso):

- La TUI/CLI como tal: ningún caso invoca interfaz de operación; todo es
  HTTP/WS directo.
- «Destrabar» manual: reencolar, forzar reintento, purgar o rescatar la DLQ;
  el estado `dead` solo se inspecciona, nunca se recupera.
- «Esfuerzos», «credenciales» (rotación) y «rollouts»: sin ningún caso.
- Re-priorizar o reordenar una cola atascada en caliente por un operador:
  sin cobertura (los jobs se crean ya priorizados).
