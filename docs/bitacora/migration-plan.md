# Shadow V2 → V3 sin tocar servicios vivos

## Invariantes

V2 sigue autoritativo hasta un cutover explícito por alias. V3 usa DB, certificados, tokens, DNS, state dirs y procesos propios. Nunca hay consumers/pollers V2 y V3 simultáneos para la misma identidad; shadow no emite wake, ACK, relay ni side effects.

## Fases

1. **Baseline V2 read-only:** métricas ACK/reconnect/duplicate/no_route/retry/DLQ por alias, sin payloads, sesiones ni headers.
2. **V3 aislado:** dev/test separados de producción; QA distingue transporte real, protocol doubles y CLI availability.
3. **Shadow ingress Unix:** el router identity-free recibe envelopes correlacionados por socket privado, persiste inbox/mapping de `005_channel_bridges.sql` y en `shadow|compare` solo llama preview con harness/respuesta humana deshabilitados. El mismo profile mantiene el guard de side effects; no lee secretos/sesiones V2 ni escribe V2 directamente.
4. **Comparación:** ACL, route count, lane, correlación y latencia. Divergencias generan evidencia; no corrigen V2.
5. **Release gate:** Compose v2, docker build, imágenes por digest, PostgreSQL TLS/restore, hashes y cero evidencia crítica faltante.
6. **Manifests:** validar exactamente 15 aliases con `ops/scripts/validate-manifests.py`; generar unidades sin iniciarlas.
7. **Canary:** conversación nueva entre dos identidades de prueba autorizadas, un solo productor de efectos y hold de dos ventanas lease/retry con expansión progresiva.
8. **Cutover por alias:** collector fresco → preflight → owner V2 bloquea/drain → snapshot con V2=0/V3=0 → `cutover.sh host-native|container` elige explícitamente una sola familia V3 → round-trip/lease/ACK/DLQ/outbox gates → watchdog/reconciler.
9. **Lotes:** avanzar por grupos de tenant definidos en el manifiesto privado; no versionar aliases ni identidades operativas en este plan.
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

## Snapshot histórico de Telegram bridge V3

> La fecha, host, aliases, releases, métricas y paths exactos del corte se conservan en evidencia
> privada no versionada. Este resumen no modifica las invariantes ni acredita estado live actual.

- Se observó un único bridge saludable con selector acumulativo y preflight secret-free sobre
  metadata; no se leyó contenido de tokens.
- El corte observó V2 drenado para el alcance medido, pero `poll_fenced` estable sólo prueba
  ausencia de contención V3. Cualquier release debe volver a medir el lado V2.
- Las métricas eran agregadas y sin labels, de modo que no atribuían mensajes ni rechazos a una
  identidad. Los valores puntuales no se versionan ni se tratan como cotas futuras.
- Un launcher legado conservó Telegram activo durante el cutover; se desactivó mediante la
  configuración oficial. El caso demuestra que el round-trip humano y el gate V2 son ambos
  necesarios.

Detalle operativo vigente: `../ops/runbooks/telegram-cutover.md`. El incidente completo y su
remediación permanecen en evidencia privada no versionada.
