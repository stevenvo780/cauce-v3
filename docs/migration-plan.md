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
