# Runbook: clases de QA y evidencia

## Transporte real

`pnpm test:e2e` y `ops/harness/runner.mjs --live` hablan HTTP/WS Fastify y PostgreSQL auténticos desde Testcontainers. Los clientes que anuncian Hermes/OpenCode/Claude/Codex siguen siendo **protocol doubles**: no ejecutan esas CLIs. El wrapper `run-testcontainers.sh` archiva sus reportes por corrida; esos reportes no son release evidence y nunca pisan `compose-authentic`.

## Adapters y dobles

`make -C ops test-doubles` usa mock contract y ejecutables fake. Acredita parser, lifecycle, fencing y contrato del adapter, no transporte productivo ni CLI auténtica.

## CLI auténtica smoke

`make -C ops smoke-cli` invoca los cinco runtimes reales (OpenClaw, Hermes,
OpenCode, Claude y Codex) solo con `--version`/`--help`, HOME/XDG aislados y sin
prompt. `artifacts/cli` acredita disponibilidad de ejecutable, no autenticación,
sesión, respuesta ni round-trip.

No describir ninguna de estas tres clases como equivalente a otra. Un smoke auténtico de prompts requeriría entorno aislado aprobado y artefacto separado; no está implementado aquí.

## Restart auténtico y release

`make -C ops test-compose-authentic` usa `ops/compose.authentic.yaml` con los
binarios finales gateway/dispatcher/relay-worker/telegram-bridge/shadow-router.
Prueba mTLS, fencing, delivery y efectos durables a través de kills reales,
Telegram fake, webhook HTTPS y un socket V2 descartable. Si Compose no está
instalado fuera de release, el mismo comando cae a `docker run` y clasifica el
artefacto `runtime-authentic`; no lo renombra ni lo promueve. `release-gate`
acepta únicamente `compose-authentic`, SHA válido, igualdad image/source digest,
cero skips críticos y ambos mecanismos de kill. Nunca apuntar fault/cutover a V2
real, producción compartida o sesiones reales.
