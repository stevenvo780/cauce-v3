# Shadow V2 → V3 sin tocar servicios vivos

## Invariantes

V2 sigue autoritativo hasta un cutover explícito por alias. V3 usa DB, certificados, tokens, DNS, state dirs y procesos propios. Nunca hay consumers/pollers V2 y V3 simultáneos para la misma identidad; shadow no emite wake, ACK, relay ni side effects.

## Fases

1. **Baseline V2 read-only:** métricas ACK/reconnect/duplicate/no_route/retry/DLQ por alias, sin payloads, sesiones ni headers.
2. **V3 aislado:** dev/test separados de producción; QA distingue transporte real, protocol doubles y CLI availability.
3. **Shadow ingress Unix:** el router identity-free recibe envelopes correlacionados por socket privado, persiste inbox/mapping de `005_channel_bridges.sql` y en `shadow|compare` solo llama preview con harness/respuesta humana deshabilitados. El mismo profile mantiene el guard de side effects; no lee secretos/sesiones V2 ni escribe V2 directamente.
4. **Comparación:** ACL, route count, lane, correlación y latencia. Divergencias generan evidencia; no corrigen V2.
5. **Release gate:** Compose v2, docker build, imágenes por digest, PostgreSQL TLS/restore, hashes y cero evidencia crítica faltante.
6. **Manifests:** validar exactamente 12 aliases con `ops/scripts/validate-manifests.py`; generar unidades sin iniciarlas.
7. **Canary:** nueva conversación Jarvis↔Sócrates, un solo productor de efectos, hold de dos ventanas lease/retry en 1/10/50/100%.
8. **Cutover por alias:** collector fresco → preflight → owner V2 bloquea/drain → snapshot con V2=0/V3=0 → `cutover.sh host-native|container` elige explícitamente una sola familia V3 → round-trip/lease/ACK/DLQ/outbox gates → watchdog/reconciler.
9. **Lotes:** `Steven {jarvis,socrates,kant,argos}` → `Isa/Jhon {salva,hegel}` → `Miguel {kratos,janus}` → `Pablo {dedalo,midas,seneca,vulcano}`.
10. **HA:** no expandir sin `ops/runbooks/ha.md`: failover DB, fencing, relay idempotente, métricas wake/outbox/relay y RPO/RTO ensayados.

## Rollback

`cutover-rollback.sh host-native|container` valida estado live, deshabilita/detiene solo la familia V3 elegida y exige V3/drain/ACK cero; container agrega check negativo del proceso. No arranca ni modifica V2; su owner lo restaura después del gate. Runtime rollback usa imagen anterior por digest. Schema es forward-only: restaurar backup V3 verificado en una DB nueva, nunca down migration.

## Evidencia mínima

- Reportes real/restarts, JUnit y SHA: `failed=criticalSkipped=0`; la suite
  restart además exige `skipped=0`.
- Build evidence que coincide con Dockerfile e imágenes publicadas por digest.
- TLS DB observado, backup restaurado y RPO/RTO.
- Timeline por alias: snapshot pre/drain/post/canary/rollback, lease epoch, ACK y outbox/relay/DLQ.
- Manifest/config sin valores secretos; certificados/tokens solo por PATH externo.

## Estado live 2026-07-23 — Telegram bridge V3

> **Nota (2026-07-23):** Estado live validado por MAIN sobre el bridge productivo
> único `cauce-v3-prod-telegram-bridge-1`. Detalle operativo en
> `../ops/runbooks/telegram-cutover.md` §"Estado live verificado 2026-07-23" y en
> `../../docs/handoffs/HANDOFF-CAUCE-V3-TELEGRAM-CUTOVER-2026-07-23.md` (éste
> contiene el incidente Janus y su remediación en §8). **No** modifica las
> invariantes de esta hoja; sólo anota progreso.

- Bridge único en `agora-storage`, `healthy`, `RestartCount=0`, readiness
  aliases = **12**.
- Selector acumulativo activo sobre los 12 manifest. Preflight secret-free
  PASS para los 12 (sólo metadata, no formato/contenido del token). Snapshots
  cronológicos de `poll_fenced` (semántica: **sólo ausencia de contención
  de lease V3**, no prueba ausencia de V2):

  | Snapshot | Fecha | Lectura | Estado |
  |---|---|---|---|
  | **S1 (histórico)** | 2026-07-23 (corte inicial) | `poll_fenced` = 949, **estable 949→949** | valor base post-force-recreate; remanente de contention tracking previo, no conflicto V3 activo |
  | **S2 (post-rollout, histórico)** | 2026-07-23 (post-rollout, sin hora específica — sólo fecha) | `poll_fenced` = 980, **estable 980→980** entre dos lecturas | sin incremento sostenido; sólo ausencia de contención de lease V3 |
  | **S3 (cierre técnico, vigente al cierre de esta hoja)** | 2026-07-23 (post-reinicios, sin hora específica — sólo fecha) | `poll_fenced` = 986, **estable 986→986** en ventana 30 s | sin incremento sostenido en la ventana de cierre técnico; sólo ausencia de contención de lease V3 — **S3 es cierre técnico, no valor fijo futuro**: durante pruebas humanas el contador puede avanzar como en S1→S2→S3 (mismo mecanismo: detecciones discretas entre lecturas, no contención viva) |

  S1 y S2 se conservan como referencia temporal; S3 es el cierre técnico de
  esta hoja, no una cota superior. Las diferencias 949 → 980 → 986
  reflejan detecciones discretas entre cortes, **NO** contención viva (que
  sería sostenida). Si en una lectura posterior el valor crece sostenido,
  **sí** hay contención V3 — abrir investigación con `alias-cutover.md`.

  Métricas agregadas al **cierre técnico (S3)** — **single point in time**,
  mismo bridge; **contadores acumulativos que pueden avanzar durante las
  pruebas humanas en curso**, son la foto del cierre, no una cota:

  | Serie | Valor al cierre | Lectura |
  |---|---|---|
  | `updates_allowed` | **9** | 9 DMs humanos admitidos en lo que va del corte |
  | `updates_denied` | **1** | **1 update rechazado por allowlist** — NO error de entrega ni DLQ; es un update del lado ingreso que el filtro `user_id`/`chat_id` no aceptó. **Sin atribución por alias**: el bridge publica agregados sin labels, así que `updates_denied=1` cuenta *un* rechazo de allowlist sin identificar a qué alias correspondió |
  | `updates_duplicate` | **0** | ingress sin duplicados |
  | `egress_sent` | **9** | 9 respuestas egresadas; 1:1 con `updates_allowed` al cierre |
  | `retry` | **0** | egress sin reintentos sostenidos |
  | `dead` | **0** | DLQ cerrada |
  | `ambiguous` | **0** | ACK gate limpio |
- V2 Telegram = **0** sobre los 4 pendientes iniciales (`socrates`, `kratos`,
  `salva`, `vulcano`) tras ciclo de watchdog. Topología observada:
  socrates=connector, kratos=native, salva=native, vulcano=connector; kant aparte;
  janus=connector (`clawbus-oc`) post-remediación 2026-07-23.
- **Incidente y remediación 2026-07-23 — Janus:** el launcher OpenClaw de
  `janus` conservaba `channels.telegram.enabled=true` mientras V3 ya estaba
  activo sobre los 12 alias — riesgo de doble polling que `poll_fenced` no
  detectaba. Remediación oficial: `openclaw config set
  channels.telegram.enabled false --strict-json`. Validación: config validate
  PASS, hot reload `configured=true,running=false`, sin restart, gateway
  healthy, `clawbus-oc` connector Janus = 1.
- **Pendientes reales:** validación humana por alias la está haciendo Steven
  en vivo; las métricas son agregadas sin labels por alias — el round-trip
  humano explícito es la única prueba que admite release del bridge por alias.
  Incluye **validación humana específica de Janus** posterior a la remediación.
  Los contadores acumulativos arriba (`updates_allowed`, `egress_sent`,
  `poll_fenced`, etc.) pueden avanzar con cada prueba humana — eso es
  esperado, no indica contención ni problema.
