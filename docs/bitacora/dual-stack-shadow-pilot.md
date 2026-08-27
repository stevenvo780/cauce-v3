# Plan dual-stack, shadow y cutover progresivo de 15 agentes

## Invariantes

- V2 sigue autoritativo durante shadow/canary. En cutover por alias su owner lo
  drena y confirma V2=0 antes de que los scripts inicien V3.
- Primero solo tenant `Steven`, agents `jarvis` y `socrates`, entra en allowlist piloto.
- `kant`, `argos`, `zeus` y todos los tenants Miguel/Isa/Jhon/Pablo siguen 100% V2.
- Un único sistema puede producir side effects/ACK/wake por mensaje.
- IDs de correlación se preservan; payloads no se copian a observabilidad.
- Kill switch revierte el **ruteo**, no tumba procesos ni borra colas.

## Arquitectura de transición

1. Colocar el `shadow-router` versionado después de autenticación/ACL existente;
   su socket Unix privado es el único ingress y no le entrega identidad ni sesión V2.
2. Mantener ruta primaria V2. El owner externo encola una copia asíncrona con
   `source_event_id` y correlation/idempotency estables. En `shadow|compare`, el
   router invoca solo preview con `allow_harness=false` y `allow_human_reply=false`;
   el guard del mismo profile detecta cualquier side effect inesperado.
3. Comparar decisiones en un sink: route count, destinatario, lane, ACL y
   latencias. V3 shadow no emite ACK, wake ni mensajes al agent.
4. Usar outbox transaccional o log append-only para la copia; nunca dos writes
   independientes sin reconciliación.

## Fases y gates

### 0 — baseline

Medir siete días de V2: volumen, ACK P50/P99, reconexión, duplicates, no_route,
retries y DLQ por los dos agents. Crear dashboard y kill switch probado.
Capturar además relay `sent|failed`, expiraciones de lease y backlog exacto por
lane. Ausencia de serie se considera UNKNOWN, no cero.

### 1 — shadow read-only

Allowlist exacta `steven/{jarvis,socrates}`. Muestrear 1%, 10%, 50%, 100% de
sus mensajes hacia V3 shadow. Gate mínimo: cero side effects V3, 100% ACL
equivalente, IDs correlacionables y divergencia de ruta explicada.

### 2 — doubles y replay

Ejecutar el harness con dobles Hermes/OpenCode/ClaudeCode/Codex contra V3.
Reproducir mensajes sanitizados/sintéticos, incluyendo reconnect, ACK faults,
fairness y DLQ. No reproducir tokens, sesiones ni payloads reales.
Separar evidencia: contract/mock y adapters con fake executables son dobles;
`smoke-cli` solo acredita version/help. Ninguno acredita un prompt auténtico.

### 3 — piloto activo Jarvis↔Sócrates

Habilitar solo conversaciones nuevas con flag por `conversationId`; no mover
una conversación en vuelo. Router elige V3 como único primario para el par y
conserva V2 como fallback frío, sin envío duplicado. Empezar 1%, luego 10%, 50%
y 100%, con hold de al menos dos ventanas de lease/retry por escalón.

### 4 — soak y expansión a los 15 agentes

Mantener 48–72 h del par. Luego expandir en cuatro lotes, cada uno como cambio
separado de configuración con preview, revisión, audit y rollback probado:

1. `Steven`: `jarvis`, `socrates` (piloto) y después `kant`, `argos`, `zeus`;
2. `Isa/Jhon`: `salva`, `hegel`;
3. `Miguel`: `kratos`, `janus`, `iza`, `atlas`;
4. `Pablo`: `dedalo`, `midas`, `seneca`, `vulcano`.

Para **cada alias** seguir `alias-cutover.md`: snapshot fresco, preflight, drain
V2 externo, `cutover.sh`, exactamente un consumer/poller/lease owner V3,
round-trip auténtico y gate wake/outbox/relay/ACK/DLQ. Habilitar watchdog y
reconciler. Hold mínimo: dos ventanas de lease/retry; abortar el lote completo
ante cualquier gate rojo.

### 5 — gate HA (antes de cualquier cutover sostenido)

Seguir `ha.md`: PostgreSQL con failover ensayado y TLS verificado, al menos dos
gateways detrás de health routing, fencing de consumer probado y dispatchers
con `SKIP LOCKED`. Exigir `test-restarts` sin critical skips, backup restaurado,
RPO/RTO medidos, provider auth/TLS productivo seleccionado y origin relay egress real.
La mera existencia del código no aprueba el gate: certificados, identity maps, allowlists,
receiver idempotente y build de imagen por digest deben validarse en el entorno destino.

### 6 — cierre del cutover

Solo después de los cuatro lotes: verificar 15/15 aliases online con epochs únicos,
colas/retries/DLQ en umbral, config revision y SHA de artefactos archivados. V2 queda
en fallback frío durante la ventana acordada; su retiro es un cambio posterior, no
parte de este runbook.

## Abort automático

Volver el flag del par a V2 si ocurre cualquiera:

- duplicate side effect o dos consumidores;
- ACL divergence/cross-tenant route;
- pérdida no recuperada o DLQ sostenida;
- P99 ACK > 2× baseline durante 10 min;
- readiness inestable o fallback fallido.

Al abortar: congelar nuevas rutas V3, dejar completar/expirar inflight con
idempotency, reconciliar por ID, y conservar V3 arriba para diagnóstico. No
apagar V2, no drenar tenants ajenos y no re-drive sin idempotency key.
