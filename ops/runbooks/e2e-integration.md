# Runbook: clases de QA y evidencia

## Transporte real

`pnpm test:e2e` y `ops/harness/runner.mjs --live` hablan HTTP/WS Fastify y PostgreSQL auténticos desde Testcontainers. Los clientes que anuncian Hermes/OpenCode/Claude/Codex siguen siendo **protocol doubles**: no ejecutan esas CLIs. El wrapper `run-testcontainers.sh` exige un Testcontainer real (rechaza el fallback `CAUCE_TEST_DATABASE_URL`), archiva sus reportes por corrida y los valida contra schema, SHA, digest runtime, digest del harness y RepoDigest/ID del PostgreSQL efectivamente levantado.

Esos reportes son evidencia de ejecución de la aplicación desde `source-tree`; declaran
`finalCauceImageExecuted=false` y no acreditan binarios/imágenes finales.

## Adapters y dobles

`make -C ops test-doubles` usa mock contract y ejecutables fake. Acredita parser, lifecycle, fencing y contrato del adapter, no transporte productivo ni CLI auténtica.

## CLI auténtica smoke

`make -C ops smoke-cli` invoca los cinco runtimes reales (OpenClaw, Hermes,
OpenCode, Claude y Codex) solo con `--version`/`--help`, HOME/XDG aislados y sin
prompt. `artifacts/cli` acredita disponibilidad de ejecutable, no autenticación,
sesión, respuesta ni round-trip.

No describir ninguna de estas tres clases como equivalente a otra. Un smoke auténtico de prompts requeriría entorno aislado aprobado y artefacto separado; no está implementado aquí.

## Binarios finales y release

La suite `compose-authentic`/`runtime-authentic` se retiró junto con sus runners: exigía
`relay-worker` y `shadow-router`, servicios que ya no existen en el runtime. Testcontainers sigue
siendo QA real de código fuente, pero no sustituye evidencia de imágenes finales. Hasta que exista
un reemplazo, este árbol no ofrece un gate de restart/fencing de clase release; ver
`el historial de git y el bundle 27-08`.
