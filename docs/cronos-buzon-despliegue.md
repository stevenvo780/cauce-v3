# Despliegue del buzón de Cronos

El runtime que admite buzones por grant OAuth local declarado está desplegado en `df2544a0efa8b3359b988eadba5769aa633c9d62`, árbol `f7c3e733ffa4c77d0d06d3cf48023ea1cb795484`. La activación del SDK compatible quedó bloqueada y la comunicación Jarvis↔Cronos desde este chat no está acreditada.

## Alcance y resultado

El ejecutor terminó a las `2026-10-07T01:20:46.932512Z` (6 de octubre, 20:20:46 en Bogotá). Actualizó gateway, terminal-relay, dispatcher, telegram-bridge y outbox-metrics. La consola, PostgreSQL, Prometheus y OTel conservaron sus contenedores y montajes. Los nueve servicios quedaron sanos y una comprobación posterior al intento del SDK lo volvió a verificar. El esquema sigue en `046_human_client_provenance.sql`; no se ejecutaron migraciones.

| Componente | Identidad publicada |
|---|---|
| Runtime | `127.0.0.1:5000/cauce-v3-runtime@sha256:0f51796cac5eff4c75ea8e1742539fc3e1ac4aea3f4f7d561bbb857920a35731` |
| Consola preservada | Revisión `10935bc53d8ba43d56128d4f083658fcd8d2e7c6`, pin `127.0.0.1:5000/cauce-v3-console@sha256:1da82a7c73be6b527fc23e72295dfac565ba150025db4f056da64718702c36d6` |
| Bundle candidato | `cronos-mailbox-20261006-r4`, digest `sha256:aaa4fdd12e6a0b320676fa25710b8a37750b500d2cd0f532f32efd01a58cc04c`; instalado, sin activación aceptada |
| SDK conservado en Jarvis y Zeus | `cronos-410c0d5c`, digest `sha256:090da1336a57f52ee1e289516a4b59b5cd688cbdaffc9a556775970387463b09` |

El runtime y la consola mantienen el ancla Compose en `/datos/workspaces/zeus/cauce-v3-deploy/71df5bc9/deploy`; la infraestructura mantiene la suya en `/datos/releases/cauce-v3/pr1-release-20261001/deploy`.

## Evidencia

Los once gates de release terminaron exit 0 con fuente exacta según `gates.json`: typecheck, lint, unitarios, matriz completa, audit, Testcontainers, bundle, ops/validate, packaging runtime, layout y cobertura. El resumen final de `full.log` registra 11 suites aprobadas y cero fallos en 2305,7 segundos; la medición exterior de `gates.json` es 2306,33 segundos. E2E tuvo 138 pruebas aprobadas y dos omitidas. `runtime.log` acredita el smoke de empaquetado y `coverage.log` el trinquete sin caídas; sus extractos con hashes comprobados están en `verification-excerpts.json`.

`executor-review.json` y `sdk-review.json` son aceptaciones previas de los ejecutores, emitidas antes del despliegue y del canario: no aprueban la activación SDK ni acreditan sus resultados. El revisor escribió `seal-qualified.py` y `finalize-reviews.py`; el principal los ejecutó tras los gates completos. El campo global `author: root` de los receipts no describe la autoría de esos dos helpers.

`verify-public.py` comprobó 109/109 recursos HTTPS contra la imagen de consola preservada: HTTP 200 y bytes exactos (`public-assets.json`). La observación CUA filtrada de una sesión web, guardada a las 01:44:04Z del 7 de octubre, recoge el encabezado Jarvis y el estado «Libre» en `ui-observation.json`. Esto no acredita una UI de buzón ni un ping nuevo.

La primera extracción del bundle falló con exit 2 por permisos de directorios de solo lectura; su salida no se conservó y el exit y la causa constan solo en `bundle-install.md`. El propietario normal recreó únicamente la release parcial no activada y extrajo el mismo archivo con `--delay-directory-restore`. `bundle-install.md` recoge la observación histórica del exit 0 del segundo intento; `bundle-install-attempt2.log` está vacío y no lo prueba. Una comprobación posterior independiente dejó el digest instalado exacto en `bundle-digest-installed.log`. No se cambiaron propietarios, perfiles ni credenciales.

## Activación del SDK y límites

El canario de Jarvis obtuvo una sonda mTLS con ACK terminal aplicado y lease vivo, pero el gate falló por `wake backlog exceeds gate`. La captura anterior a la activación ya tenía `wakePending=1`; las capturas de canario y restauración conservaron ese valor. Ese ACK no acredita una respuesta conversacional de Jarvis a Cronos.

El wake identificado en `wake-inspection.json` pertenece a una entrega para Astra creada a las `2026-10-06T23:33:49.937Z` (6 de octubre, 18:33:49 en Bogotá). En esa inspección tenía cero intentos, entrega pendiente y destinatario sin lease vivo. El archivo no tiene timestamp propio; `wakePending=1` también consta en la captura de las 01:30:20Z. Astra estaba excluida de esta actualización. El criterio del gate no se relajó y no se canceló su entrega.

El script del canario terminó de forma anormal: `sdk-jarvis.log` y los `command-failure*.json` registran el fallo del gate y del watchdog de reversión. La observación posterior `sdk-evidence/jarvis-restoration-observed.json` acreditó el pin anterior, ambas unidades activas, un consumidor/poller/lease owner V3, cero entregas en vuelo y cero ACK inválidos. No demuestra por sí sola quién reinició las unidades. `jarvis-rollback.json` conserva `ROLLBACK_PENDING`; la observación posterior no lo convierte en un canario aprobado. Zeus no se actualizó.

| Observación | UTC del 7 de octubre | Bogotá, 6 de octubre |
|---|---|---|
| Base anterior al pin candidato | 01:21:31 | 20:21:31 |
| Sonda técnica con ACK aplicado | 01:22:31 | 20:22:31 |
| Fallo del gate | Aproximadamente 01:22:33 | Aproximadamente 20:22:33 |
| Watchdog de reversión bloqueado | 01:23:26–01:23:28 | 20:23:26–20:23:28 |
| Pin anterior y unidades activas observados | 01:30:20 | 20:30:20 |

Las capturas de `sdk-evidence/` aportan esos tiempos. `sdk-pins-observed.json`, `wake-inspection.json` y `runtime-post-sdk-attempt.json` no tienen timestamp propio y no acreditan continuidad posterior.

El grant OAuth de este chat expiró y Cauce exige reautenticación. El ping solicitado a Jarvis no se envió desde Cronos. La prueba viva del buzón y de la respuesta al remitente queda pendiente de una conexión vigente y del gate del SDK. El cliente necesita un turno activo para consultar: los mensajes no despiertan automáticamente un chat de ChatGPT.

La consola preservada de PR133 no incluye «Guardado en buzón»; por lectura estática de su código, una entrega `done` se mostraría de forma genérica. La imagen candidata de consola quedó preparada y no se desplegó. El contrato del runtime expone el almacenamiento mediante MCP y `client_mailbox` en las cargas del gateway; ese almacenamiento no se verificó en vivo tras el despliegue.

## Ubicación de los resultados

Evidencia local: `/home/stev/cauce-ci-evidence/cronos-mailbox-20261006-r4/`. El staging del servidor es `/root/cauce-cronos-mailbox-20261006-r4/`. Los resultados principales son `gates.json`, `full.log`, `runtime.log`, `coverage.log`, `verification-excerpts.json`, `bundle-proof.json`, `executor-review.json`, `sdk-review.json`, `baseline.json`, `deployment.json`, `runtime-post-sdk-attempt.json`, `public-assets.json`, `ui-observation.json`, `bundle-install.md`, `bundle-install-attempt2.log` (vacío), `bundle-digest-installed.log`, `sdk-jarvis.log`, `sdk-pins-observed.json`, `wake-inspection.json` y `sdk-evidence/` (incluidos `command-failure*.json`, rollback y observación posterior). Los archivos privados de configuración no forman parte de este registro.
