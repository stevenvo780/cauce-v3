# Task 2 — cuotas reales y Mis cuotas

Autor: `/root/v4_quotas`. Revisión independiente de `/root/v4_contexts` completada en alcance freshness/TTL/runtimeverify/replay, sin nuevos bloqueos; integrador revisa canal firmado y broker. Revisión read-only de consola realizada por este autor; no sustituye su gate.

- Worktree aislado `/home/stev/.codex/worktrees/cauce-v4-complete/cauce-v3`, rama `codex/v4-complete`. Sin commits, despliegues, secretos, cambios productivos ni edición de los módulos del integrador.
- Cuentas canónicas compartidas por empresa, vínculos por agente, CAS e idempotencia. Un registro nuevo permanece deshabilitado hasta verificar su identidad; reintentar un registro deduplicado devuelve la cuenta canónica. Pausas manuales conservadas y límites específicos de modelo sin pausa global.
- Estado explícito unknown/error/stale/ok: se conserva la fecha de observación y recepción. Una observación histórica recién recibida no muestra saldo vigente ni dispara pausa/reanudación. Claude conserva ventanas nativas Sonnet/Opus/Haiku y el selector reconoce modelos completos. Claude, Codex y Grok consultan sin refresh por defecto. Solo en entornos de «Mis cuotas» con sesión propia, el runtime pasa `--refresh-own-session` y el lector puede renovar el token bajo candado exclusivo y escritura atómica; nunca en contenedores de agentes ni sobre sesiones compartidas.
- Entornos y cola durable en migración aditiva 057/down, fencing por token/epoch/worker/entorno, renovación y revalidación de autoridad antes de ejecutar/publicar. Nonce firmado y operación comparten transacción. Capacidades frescas de host enrolado por empresa/proveedor/acción: el gateway conserva el mapa firmado, no fabrica acciones, y ninguna identidad registrada caducada/revocada vuelve al fallback estático.
- El executor existente incorpora `--quota` y `--quota-auth-verify`, sin daemon adicional. Usa los descriptores del bundle aprobado y verifica su digest antes/después; nunca usa el repositorio como fallback. Crear exige aislamiento observado y versión funcional del CLI; eliminar exige ausencia del contenedor y del volumen propio.
- Autenticación con consentimiento y plan cerrado para el broker del integrador: TTL obligatorio, futuro y de hasta 900 segundos. La expiración durable libera waiting/resumed auth como failed/AUTH_EXPIRED. Los resultados terminales y fallos repetidos conservan el fence. Verificación final requiere HTTP aceptado e identidad real: UUID de profile Claude o account_id aceptado por WHAM Codex. Email local Grok no acredita identidad; Gemini carece de descriptor verificado y permanece unavailable.
- Replay terminal revalida autoridad y efecto completo; no aumenta versiones, no registra nuevas muestras y no muta la identidad. Autenticación repetida compara SHA256 de proveedor/identidad contra la cuenta canónica del entorno, empresa y proveedor; rechaza identidad o account_id distintos. La identidad sin hash no persiste en resultados done ni awaiting_auth. El repositorio del host repite finish/fail una sola vez ante QuotaHostTransportError; cada envío firma un nonce nuevo. HTTP, límites y JSON inválidos no se reintentan, y el efecto externo nunca se repite.
- Export browser-safe `@cauce/protocol/quotas` agregado y rebuild de protocolo verde. Consola revisada: guard CAS/fechas/ventanas, fatiga por modelo, relaciones host/proveedor y acción, rechazo de capacidades revocadas y UI awaiting_auth con scope del broker. Hallazgo profile_id corregido por su autor; autenticación externa no acreditada por esta revisión.

Evidencia local ejecutada:

- PostgreSQL y runtime TS: 4 ficheros, **26/26**, 26.04 s, tras TTL/freshness/authverify. Consolidación posterior propia: **45/46**, 7 ficheros, 39.07 s; único fallo de la fixture nueva por leer bigint version como texto. Corregida con cast SQL ::int y repetida suite nueva replay **3/3**, 4.47 s. Las otras seis suites de esa consolidación quedaron verdes, incluidos entornos **15/15** y snapshots **13/13**.
- Verificación posterior conjunta de rutas de consola y canal host firmado: **12/12**, 2 ficheros, 14.11 s. Prueba real de sesión/enrolamiento/Ed25519 incluye host nuevo sin preset, proveedor incorrecto, mapa de acciones vacío, host query-only que rechaza create/auth/update/delete, stale y revocación. Canal firmado acepta terminal idéntico con nonce nuevo y rechaza payload/fence/scope alterados. Runtime TS posterior al retry: **12/12**, 2 ficheros, 492 ms; verifica respuesta perdida tras commit sin repetir efecto y una sola repetición de fail.
- Consolidación de 8 ficheros: **115/121**, con 6 fallos de fixtures antiguas que declaraban observaciones de una hora como vigentes. Ajustadas únicamente sus fechas de ejemplo a ventanas recientes por test, sin cambiar las expectativas; suite `quota-snapshot-postgres.test.ts` posterior **13/13**, 8.71 s. Gate completo del SHA final queda al integrador.
- `python3 -m unittest ops/tests/test_quota_runtime.py ops/tests/test_quota_readers.py ops/tests/test_harness_operations.py ops/tests/test_fleet_executor.py`: **29/29**, 7.133 s, tras authverify/version.
- Collector: **✓ All tests passed**, parser y mTLS descartable real. ESLint propio verde; compileall, node --check y git diff --check verdes. `node scripts/calidad.mjs`: **VERDE**, sin modificar baseline.
- Typecheck core estuvo verde; las corridas posteriores detectaron WIP de otros sectores. Última corrida propia: error TS2352 en `services/gateway/src/console/space-backup.routes.ts:25`; comunicado al integrador. No se acredita typecheck final a partir de una corrida fallida.

Revisión read-only adicional: cleanup de auth host exige prueba de stopped y ejecuta fail aunque resumeAuthentication sea false tras verify fallido, conservando rechazo a fence expirado/reemplazado. Consola conserva validación profile_id igual a account_id y guards de permiso/capacidad. Decisiones conserva identidad mTLS/durable por request, catálogo y fallback de caller.company, buckets por empresa/tenant/alias, presupuesto global y auditoría con digest sin state/credenciales; no se hallaron nuevos problemas accionables en esa revisión. Ninguna revisión de lectura acredita proveedor externo.

Fronteras pendientes: gate global exacto tras integrar el broker, canary Docker físico y flujo de autenticación web/host con proveedor real. El broker/worker/enrolled-main son del integrador; esta evidencia no acredita tokens externos, acceso a producción ni deploy.


## Cierre adicional de autoridad de flota y shutdown de cuotas

- `FleetOperationsRepository.forCompany(companyId).forTransaction(client)` permite al CLI usar la empresa elegida con persona, alias y rol durables; el string solo nunca concede autoridad. El gateway ofrece `forAuthority(source)` y resuelve la sesión humana en la transacción de escritura. Las rutas delegan `consoleHumanAccess.companyAuthority` y cierran el acceso en `finally`; los doubles y el transporte legado conservan el binding opcional.
- La cola almacena explícitamente `company_id` y `queued.acting_company`, además de `actor_subject`. El worker comprueba la igualdad de ambos scopes y revalida a la persona en cada paso. Los reintentos exigen request, empresa y origen humano iguales; el historial reciente filtra la empresa seleccionada sin inventar un target del tenant de origen. `configuredFleetRepository` comparte el catálogo privado y las opciones reales de coordinación con el gateway para el CLI físico.
- `QuotaExecutor` comprueba abort tras cada lectura de autoridad y drena la renovación pendiente antes de `finish`, comprobando abort otra vez inmediatamente tras ese await. Un shutdown o renovación inválida impide publicar create y awaiting_auth; un handoff de autenticación válido permanece abierto para el broker. Las pruebas controlan las promesas diferidas y el reloj falso, sin depender de carreras temporales.
- PostgreSQL posterior: **22/22**, 3 suites, 23.72 s, con runtime restringido. Incluye cookie firmada y cambio Humanizar a Praxis a través del gateway real: preview, enqueue, CAS, historial, control, origen durable y revocación de plataforma. La primera corrida fue **15/22**: la fixture antigua de humanidad no concedía company_admin y la nueva intentaba revocar al último platform_admin. Se concedió rol de fixture explícito y se conservó otro administrador cualificado antes de revocar, sin desactivar guards; la ausencia de persona en un retry físico se sigue denegando como forbidden.
- Foco TS posterior: **79/79**, 4 ficheros, 1.92 s; `quota-executor.test.ts` **16/16**, con 7 casos nuevos de shutdown/drenaje, y rutas/gateway **60/60**. `pnpm exec tsc --noEmit -p tsconfig.json`: **exit 0** en árbol compartido actual; ESLint de 13 rutas propias: **exit 0**; `git diff --check` y calidad: **VERDE**. Logs: `/tmp/cauce-v4-fleet-company-postgres.log`, `/tmp/cauce-v4-fleet-company-unit.log`, `/tmp/cauce-v4-fleet-company-typecheck.log`, `/tmp/cauce-v4-fleet-company-eslint.log`.
- Revisión independiente de flota y del patch de shutdown por Core cerrada sin bloqueos: scope/actor, idempotencia, transacción, revalidación del worker y handoff inspeccionados; evidencia 22/22 PostgreSQL y 16/16 executor cotejada. Interfaz/client de backups revisados por lectura: `home_tenant`, `LIMIT_EXCEEDED`, running con metadata íntegra o nula y descarga exclusivamente ready presentes; foco leído **29/29** de su autor. No acredita E2E backend, proveedores externos, autenticación física, integración ni despliegue.

## Lecturas actuales de proveedores

Recibos privados `real-quotas/manifest.json` y `claude-usage-shape.json`: nueve perfiles inspeccionados entre19:25 y19:27UTC. Cinco devuelven cuota, uno carece de credencial y tres fallan (una credencial sin accessToken y dos HTTP403). Las ocho credenciales existentes conservaron contenido y mtime; no se ejecutaron CLIs de proveedores ni refresh de tokens.

Claude reportó 5 h con 0 % usado y semanal con 93 %; Codex Pro semanal con 15 %; Grok semanal con 6 %. Codex b2b y Hegel tienen la misma identidad de cuenta remota, por tanto comparten saldo. Grok sólo permitió cotejar la etiqueta local; no se acreditó UUID remoto. `seven_day_breakdown` de Claude describe composición por filas y se excluye de las ventanas, incluso si el objeto contiene un campo `utilization`. Las ventanas globales `five_hour` y `seven_day` se conservan; sin utilización numérica finita quedan desconocidas. Las específicas necesitan utilización numérica finita: no se fabrican ventanas desde strings, booleanos, arrays o metadata sin porcentaje. `limits[]` y `weekly_scoped_shares` no se interpretan mientras su contrato no esté verificado.

Las lecturas son reales y conservan estados negativos; no acreditan presentación web, creación de un entorno nuevo ni autenticación interactiva de Mis cuotas. Sigue pendiente el efecto publicado.

## Corrección local del parser de Claude

La regresión reprodujo tres fallos antes del cambio: ventana ficticia para composición, composición con porcentaje tratada como cuota y metadata no numérica aceptada como ventana específica. El lector corregido elimina esos resultados y conserva los porcentajes numéricos por modelo, los resets recibidos y las ventanas globales desconocidas. No convierte la composición del consumo en agotamiento.

```text
python3 -m unittest ops/tests/test_quota_readers.py ops/tests/test_quota_runtime.py ops/tests/test_harness_operations.py ops/tests/test_fleet_executor.py
Ran 32 tests in 6.317s
OK

node --check ops/cuotas/leer-cuota.mjs
exit 0
```

Recibos privados en el directorio de estado V4: `claude-composition-red.log` conserva 3/3 fallos esperados antes de la reparación; `claude-composition-green.log` conserva 32/32 en verde después. La suite emite un `ResourceWarning` por limpieza de un HTTPError 429 del fixture; no hubo fallo. `claude-composition-offline-shape.log` aplica el lector real a la respuesta sanitizada autorizada con fetch simulado y credenciales sintéticas: devuelve sólo 5 h/0 % y 7 d/93 %, conserva los resets y no interpreta composición, `limits` ni shares. En ese ensayo hubo cero peticiones al proveedor y ninguna lectura de credenciales reales.

La corrección está probada en el checkout. No se repitió la consulta externa ni se declara distribuida al servidor, publicada en la web o aceptada por un gate final integrado. El coordinador revisa y acredita esas fases.

## Imagen de cuotas: construcción, digest y carga en el host

La imagen (`ops/cuotas/Dockerfile`) fija la base `node:22-slim` por digest y cada CLI por versión exacta (`CLAUDE_CODE_VERSION`, `CODEX_VERSION`, `GEMINI_CLI_VERSION`, `GROK_VERSION`); el propio build falla si algún `--version` no coincide con lo fijado. Lleva los lectores (`leer-cuota.mjs`, `leer-cuota-grok.mjs`, `codex-http-probe.py` ejecutable `0555`) y ningún script de refresco aparte: la sonda refresca solo con `--refresh-own-session` dentro de entornos de sesión propia. Subir una versión es deliberado: se cambia el `ARG`, se reconstruye y se registra el digest nuevo; nada flota con `latest`.

Procedimiento (host con Docker; la política espera el digest, no un tag):

```bash
docker build -t cauce-cuotas-local ops/cuotas
docker image inspect cauce-cuotas-local --format '{{.Id}}'   # sha256:<digest>
```

1. Cargar el digest obtenido en `policy.quota_environments.image` del host de cuotas.
2. Recargar la política del executor (sin reiniciar contenedores ajenos): el executor valida la política sintácticamente al cargarla y solo exige los descriptores al anunciar capacidades o ejecutar una operación.
3. Los entornos existentes siguen con la imagen anterior hasta recrearse; los nuevos usan el digest registrado. `update_cli` sigue instalando el paquete del descriptor en el perfil, por encima de la versión de la imagen.

Última construcción local acreditada (este checkout): imagen `sha256:58b70c68c0555715b20682a71a093b8a52d4f1335b872da989dee3d7dd907547`, con `validate()` real sobre un contenedor canary desechable (`zz-canary-cuotas`, red `bridge`): creación verificada (`cli_version: codex-cli 0.160.1`), los tres lectores responden `not_authenticated` sin credenciales, las cuatro versiones coinciden con lo fijado y contenedor y volumen quedaron eliminados. Este digest es el candidato a registrar; el registro en la política del host productivo y el despliegue corresponden al dueño o al agente integrador autorizado.
