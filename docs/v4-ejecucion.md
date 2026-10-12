# Ejecución de Cauce V4 completa

La especificación vinculante es `docs/v4-objetivo-del-dueno.md`, copia íntegra del adjunto del dueño. Ninguna fase parcial acredita la V4 completa. La matriz privada `aceptacion.json` conserva cada requisito y sus pruebas locales/publicadas.

## Restricciones globales

- Integración, migración, despliegue y verificación están autorizados por el objetivo actual; requieren respaldo, reversión, revisión independiente y gates del SHA exacto.
- Máximo cuatro subagentes, profundidad uno; ficheros disjuntos y sólo el coordinador commitea. Trabajar en este checkout aislado, nunca en los checkouts originales ni en el dev compartido.
- No secretos en Git/logs/documentación; no copiar auth.json ni sesiones, no tocar ops/private/credentials, no recuperar proveedores retirados ni reactivar sondeo Codex app-server.
- No editar migraciones anteriores: sólo nuevas migraciones aditivas con down y grants explícitos. No alterar datos reales para probar borrados; no retirar orígenes antes de verificar destino y copia recuperable.
- Los estados reflejan efectos reales; no usar mocks, health, ACK o leases como prueba de funcionalidad. Conservar contratos de terminal, CLI, fencing y comunicación.
- El objetivo nuevo autoriza registro autónomo, creación de empresa y enrolamiento de ordenadores; sustituye las restricciones administrativas del plan V4.1 que lo impedían.

## Task 1: Núcleo, autoridad, registro y administración de empresas

Propiedad: `packages/store/**` y `services/gateway/**`, EXCEPTO archivos de cuotas (repository/quotas.ts, accounts.ts y nuevos quota-*), contextos (company-context.ts, context-version*, context-git*, publishing.ts, claims.ts y publish-operation*) y migraciones reservadas de los otros frentes. Posees migrations 055, 056 y 059 nuevas; nunca las anteriores. Posees app.ts e index.ts como integrador de interfaces durante esta ola.
Revisa y termina D/E/F recuperados: autoridad humana única, configuración/personas/flota/cuentas por empresa, revocación, salas homónimas y revisiones/bloqueos acotados. Integra el contexto H mediante exports, sin modificar sus ficheros.
Implementa registro público real con email/nombre/password/empresa, creación atómica de identidad y empresa con dueño y hub, usando el hash/sesión existentes. POST /v3/auth/register; login posterior existente. Esquema estricto, anti-escalación, rate limits/origin y respuesta sin secretos. Completa CRUD de empresas para su dueño/plataforma y /v3/console/companies.
Implementa persistencia por empresa de la oficina: GET/PUT /v3/console/office/layout, versión esperada y configuración de salas/partes, sin permitir recursos ajenos. Enrolamiento de hosts debe ser self-service seguro; usa capacidades y protocolo existentes, no SSH arbitrario desde datos del navegador.
Reserva/integra interfaces de los otros frentes mediante app.ts/index.ts; coordina firmas antes de editarlos. Cuotas tiene accounts.ts; no lo escribas. Nuevos endpoints de contexto/cuota sólo se registran tras recibir el contrato correspondiente.
Prueba autoridad entre Humanizar/Praxis, rol dueño/admin/operator/reader, registro de usuario nuevo, revocación, concurrencia, sala ajena purgada, y layout guardado/releído. No declares cerrado lo que aún requiera enrolamiento/E2E publicado.

## Task 2: Cuotas reales y entornos Mis cuotas

Propiedad: `ops/cuotas/**`, `ops/scripts/quota-collector.py` y sus tests, NUEVOS ops/cli/quota_* y ops/scripts/quota-*, `packages/protocol/src/schemas/quotas.ts`, `packages/store/src/repository/quotas.ts`, `packages/store/src/accounts.ts`, nuevos store quota-* y gateway routes/console/quota-* y pruebas; nueva migración 057. No console, app.ts ni index.ts.
Reutiliza parsers reales del CLI en la máquina dueña del agente y aislamiento del executor/terminal actuales. Cuenta real != host/perfil != grupo/límite de modelo. Cuenta compartida por varios agentes es válida; deduplicar suscripción, no impedir asignaciones ni inventar saldos independientes.
Modelo de observación por cuenta/límite/modelo, timestamps individuales, resets absolutos nullable, estado unknown/error/stale/ok. Respeta ventanas reales y pausas manuales; corrige normalización limitId/default, freshness por received_at, autoresume y selección. CLI y consola consumirán snapshot común.
Implementa Mis cuotas con CRUD durable de entornos Docker por cuenta sin agente, autenticación/consulta/actualización del CLI y terminal de comandos restringidos, sin shell general ni mounts arbitrarios. Usa acciones tipadas y runtime idempotente existente, no un executor paralelo. Endpoints /v3/console/quota-environments y /v3/console/quota-accounts; coordina contrato real con UI/núcleo.
Conserva comando coutas; no ejecutes refresh en perfiles compartidos. Las nuevas autenticaciones ocurren sólo en entornos propios con consentimiento del usuario. No mover credenciales entre cuentas/host por un fallo.
Prueba cuentas compartidas, modelos, unknown/stale/error, 429 de sonda, resets faltantes/vencidos, pausa manual, dos empresas con host/alias iguales y creación/eliminación/actualización real de entorno identificable. Presenta parsers y efectos reales por separado.

## Task 3: Contextos, estructura de espacios y harnesses

Propiedad: `packages/adapter-sdk/**`, protocolo realtime.ts, store company-context.ts/context-version*/context-git*, repository/messages/publishing.ts y deliveries/claims.ts, gateway publish-operation* y nuevos context-version*; ops scripts de gate recuperados, nuevos ops/cli/context_* y ops/scripts/context-*, sus pruebas; nueva migración 058. No app.ts/index.ts ni otros store/gateway.
Revisa/termina H recuperado: contextos de empresa por datos, eliminar DIRECTORES/steven_dm/gate literales al sustituirlos, compatibilidad negociada y siembra sintética de dos empresas. seed-dev-cli.ts es tuyo; no sembrar producción desde allí.
Define estructura estándar real: contexto/directivas, proyectos, config no sensible, datos persistentes, logs y tmp. Harness descriptor validado debe guiar instalación/auth/ejecución/update/cuotas y consumo de contexto sin cambios dispersos ni comandos arbitrarios.
Implementa historial/diff/restauración de contextos usando revisiones existentes y un único Git privado central con carpetas estables por empresa/agente. Broker central: agentes/usuarios sólo reciben su contenido, nunca credenciales globales ni clones completos. No crees repositorio externo ni publiques aún; el coordinador hará GitHub y despliegue.
Cada vía soportada de edición (UI/CLI/archivos nativos) debe producir historial y aplicar al agente; distinguir guardado local, Git y push pendiente/error. Outbox durable, CAS/locks, reintentos y conflictos explícitos; restaurar crea una versión nueva. No escanear/copiar secretos de perfiles.
Entrega APIs reales de historial/diff/restore y estado desired/applied/sync; coordina contratos con núcleo/UI. Prueba escrituras concurrentes, fallo GitHub, recuperación, restauración, aislamiento y aplicación por harness.

## Task 4: Consola, oficina y Mis cuotas

Propiedad exclusiva: `console/**`. Usa frontend existente y APIs reales; no backend, ops ni migraciones.
Termina contrato company/platform y elimina is_hub como permiso UI; selector de empresa/rol, gestión de personas, registro público y CRUD empresarial conectados a Task 1. No habilitar botones para APIs inexistentes; comunica los contratos faltantes para completarlos, no declarar la función cerrada por ocultarla.
Crea Mis cuotas con tarjetas fijables/gráficas y ciclo del entorno conectado a Task 2, distinto de cuotas por agente. Saldos compartidos visibles, ventanas reales, timestamps y unknown/error/stale distintos de agotado.
Oficina basada en salas/agentes reales, editable con persistencia GET/PUT /v3/console/office/layout; salas/asignaciones dinámicas, detalle de agente/contextos/cuentas y cansancio derivado de disponibilidad real. Preferencias deben persistir entre sesiones/navegadores, no sólo localStorage.
Historial/diff/restore/sync/apply de contextos conectado a Task 3. Formularios, estados vacíos/carga/error, operaciones pendientes/running/done/failed, reintentos y dependencias claros. Conservar capacidades de terminal/CLI y no incluir detalles de implementación en flujos del usuario.
Pruebas unitarias/contrato y browser layout/E2E de dos empresas. No presentar mocks como validación remota. Coordina handlers/formas con los otros tres autores y registra lo que necesita prueba publicada.

## Task 5: Infraestructura, migraciones físicas y GitHub

Coordinador: contactar Kant por Cauce; censo RAM/disco/CPU/ubicación real de server1/2/3; respaldo y restore de VPS; crear Git privado central; migrar Gaia/Hegel/Hades/Argos y normalizar espacios sin copiar auth/sesiones. Verificar cuotas, terminal, comunicación, contexto e identidad antes de liberar origen. Registrar consumo antes/después y ubicaciones finales.

## Task 6: Cerrar operación de plataforma, Telegram y decisiones

Nueva ola disjunta: completar CLI bloqueado, export/import idempotente de Praxis con historial, claves tenant/alias del puente, políticas por empresa, diagnóstico útil y descarga/restore de espacios. Eliminar duplicación sólo tras demostrar consumidores/efecto sustituto.

## Task 7: Revisión, gates e integración

Revisor distinto por frente; un diff/brief/reporte por tarea. Gates completos, runtime role, ops validate, layout y ensayos en clon sobre SHA exacto. Integración autorizada con commits pequeños/pathspec; publicar PR y adjuntarlo. Nunca rebajar gates ni marcar VACIA como PASS.

## Task 8: Despliegue, aceptación final y documentación

Implementar → local → desplegar → E2E publicado → corregir/repetir. Recorrer los nueve criterios obligatorios y los 97 párrafos de la matriz; probar todos los recursos, fallos, backups/restore, signup/enrolamiento y agentes migrados. Documentar comportamiento real. No completar el objetivo con pendientes esenciales.

## Cierre local de perfiles y procedencia

La validación de rutas de los proveedores comparte una primitiva ligera. OpenClaw prepara su configuración desde el layout real de módulos del contenedor sin cargar el materializador ni montar los generadores de flota. La reproducción independiente verifica preparación y replay, las variables de los tres drivers y los rechazos de symlinks y permisos abiertos. No acredita autenticación ni ejecución de un proveedor real.

El SDK exige el `GROK_HOME` exacto al adoptar una terminal Grok. La comprobación independiente usa tmux real: rechaza el perfil ajeno y adopta el correcto conservando el proceso. Muse usa su perfil XDG dedicado y rechaza directorios existentes ajenos o accesibles por otros usuarios sin cambiar sus permisos ni archivos. Los esfuerzos siguen las capacidades de cada harness. El consumo nativo de Grok continúa sin acreditarse. Las pruebas locales conservan los negativos originales y el límite de una invocación tmux con `LC_ALL=C` impuesto manualmente.

El dominio de verificación incluye los productores PTY; esa inclusión no cambia el alcance del digest de la imagen runtime. El runner falla ante errores o formatos inválidos de HEAD y digest, cambios de identidad y un árbol final con archivos modificados o sin commitear. Las contrapruebas independientes cubren 17 casos del runner. La matriz completa y los gates de artefacto se ejecutan posteriormente sobre el SHA congelado, con imagen inmutable y etiquetas comprobadas; su preparación no equivale a haberlos superado.

En server2 se midió el intérprete regular `/usr/bin/python3.14` y se verificaron las raíces privadas del usuario `server`. Los CLI públicos Grok y Muse están preparados con manifiestos de integridad. Estos recibos no acreditan instalación, enrolamiento, migración, login ni despliegue. Continúan pendientes la identidad y vigencia reales de Grok/Muse, las cuatro migraciones y la aceptación publicada de los 97 requisitos.

## Correcciones de fixtures y repetición del gate completo

La corrida diagnóstica del gate completo heredó el rol restringido de las pruebas desde el entorno privado. Se conservó su resultado parcial en rojo y se canceló antes del release. El runner ahora retira esa variable para la matriz general; la suite específica de permisos sigue activando y verificando el rol restringido. La revisión independiente del runner prueba ese aislamiento, sin acreditar una matriz real en verde.

Las pruebas históricas de procedencia mantienen su prefijo puro. Las que ejercen la identidad actual usan una fixture híbrida explícita con SQL canónico de dependencias, sin modificar las migraciones ni sus ledgers. PostgreSQL verifica 75 casos, incluidos el rechazo del prefijo puro y de empresas deshabilitadas o retiradas sin efectos. Las fixtures de autoridad MCP y ciclo de flota verifican 63 y 3 casos respectivamente; la última conserva procesos y SSH aislados reales.

El extractor de contratos admite alias constantes de los codificadores globales y objetos de opciones que conservan el método HTTP. Rechaza alias importados, desestructurados o ambiguos. Las pruebas focales verifican 73 casos; el revisor reproduce siete controles propios y cierra dos admisiones falsas. La revisión de las doce rutas conserva hashes y negativos originales. Estas verificaciones habilitan repetir el gate del commit congelado; aún faltan el release completo, las operaciones físicas y la aceptación publicada.

## Matriz RED y reparaciones pendientes de validación global

La evidencia privada de esta ronda está en `/home/stev/.local/state/cauce-v3/v4-complete-20261011` (S). El candidato histórico `b70cc4cdcbf6f7d5c9c62e71ccc599d696ca5d4c` terminó su matriz en RED, con 9 etapas PASS y 3 FAIL de 12. Los fallos fueron 112 de Store hardening, 3 de runtime role y 6 E2E en cinco archivos; la etapa E2E ejecutó 141 casos y saltó 2. El release terminó con exit 78, `matrix_not_green`, sin construir imágenes. El recibo `S/final-matrix-b70-exact-red/receipt.json` conserva identidades, logs y códigos originales; las reparaciones se preparan en el checkout separado F.

La nueva migración aditiva `065_runtime_grants_replay.sql`, con su down, corrige el replay de ACL tras restaurar sin ACL: restituye los grants requeridos y elimina EXECUTE público indebido. La focal propia pasó 18/18; una ruta separada de restore pasó 1/1 con los otros 17 casos filtrados. Los 95 SQL históricos permanecen idénticos a R. Constan el recibo `S/runtime-grants-red-diagnosis/implemented-065-receipt-v3.json` y la revisión `S/authority-fixture-red-repairs/independent-065-review/review.json`. El default de compatibilidad de `deploy/Dockerfile` se actualizó de 064 a 065; la prueba existente `terminal-relay-operability`, que comprueba dinámicamente la última migración, pasó 3/3. Su revisión está en `S/runtime-schema-tip-independent-review/review.json`; todavía no hay una imagen de release nueva acreditada.

En F se repararon 25 archivos de pruebas Store para usar personas, membresías y autoridad de empresa durables, distinguir los prefijos históricos del esquema actual y conservar las restricciones del login runtime. Sus focales preservan los RED anteriores y los rechazos de recursos ajenos, sin rebajar permisos del producto; no forman una única corrida conjunta. Los recibos principales incluyen `S/authority-fixture-red-repairs/round-two/green-receipt.json` y `S/human-context-fixture-red-repairs/receipt-five-final.json`; la revisión de perfiles está en `S/profile-fixture-independent-review/receipt.json`.

Las cinco rutas E2E se corrigieron con los menús, diálogos y fichas actuales y tienen focales separadas: Registry 1/1, CRUD 3/3, perfil 1/1, overview 1/1 y cuentas 2/2. La autoridad owner de cuentas se concede sólo a la persona positiva de la fixture; el reader conserva el rechazo autenticado y la proyección sin credenciales. El mensaje 403 actual explica el rol y el ámbito de empresa y conserva el detalle del servidor. Los recibos y revisiones están en `S/e2e-authority-fixture-repairs/final-author-receipt.json`, `S/config-profile-browser-repairs/root-independent-review.json`, `S/overview-browser-repairs/root-independent-review.json`, `S/root-accounts-independent-review/review.json` y `S/registry-authority-error-independent-root-review/review.json`.

El perfil acredita desired y fichero del runtime actualizado, pero sigue en `pending_session_refresh`, con `applied_revision` y adopción de sesión sin acreditar; sus errores de navegador permanecen en el log. Registry acredita el inverso persistido, sin ejecutar rollback. El nuevo gate global de F está pendiente y ninguna focal sustituye los gates del SHA exacto ni la aceptación publicada. Los 97 requisitos de `S/aceptacion.json` continúan `unverified`; no se ha aplicado la migración ni desplegado o migrado agentes en producción.


## Gates mínimos y diagnóstico de geometría

Los mínimos del candidato `fe5f54a06b20f8f2a3276fd293806fca269db4ea` pasaron en F limpio: `pnpm typecheck`, `pnpm lint` y `pnpm test:unit`, todos con exit 0. El recibo `S/minimum-F-after-repairs/receipt.json` conserva la identidad y los hashes de sus logs; la fuente antes y después coincide. R avanzó por fast-forward al mismo commit, con digest completo `sha256:0d0cd25a0e95d919c6bb63680dc46357eeb4672613580a508f9604669731ebd6`. Este avance ocurrió entre checkouts aislados y no acredita integración en dev o main.

El diagnóstico `qa:layout` de ese candidato terminó con exit 1: diez empeoramientos y diecisiete mejoras pendientes de ratchet. El recorte horizontal de la barra de la oficina afecta cinco anchos; configuración móvil aumentó de 1,09 a 1,39 pantallas y colas dejó 494 píxeles libres frente a 466. El recibo `S/final-layout-preflight-fe5/receipt.json` conserva los 84 estados medidos, logs, identidad estable y cierre de sus procesos. La API fue simulada; este diagnóstico no prueba operación remota. El baseline y las métricas permanecieron intactos. La reparación debe resolver los empeoramientos antes de aceptar mejoras.

La matriz exacta de `fe5f54a0` terminó con exit 1: once de doce suites aprobadas. Store hardening pasó 1.770 pruebas y runtime role 3.603; E2E pasó 138, falló tres en `chat-media-real-browser.test.ts` y saltó dos. El recibo `S/final-matrix-fe5-exact-red/receipt.json` conserva siete archivos de evidencia y verifica después la misma fuente limpia. La reparación de multimedia tiene una focal posterior en verde; esta matriz en rojo todavía impide integrar o desplegar y debe repetirse sobre el commit final. La cadena de release se canceló con SIGTERM (exit 143 observado en el shell) antes de ejecutar sus etapas, porque las reparaciones UI hacen obsoleto ese candidato; `S/release-chain-fe5-superseded.json` conserva la identidad y el motivo. No construyó imágenes.

El controlador operativo privado dispone de pruebas herméticas; no ha congelado escritores ni ejecutado staging, migración o activación. El seguimiento del mismo chat permanece activo cada treinta minutos. Continúan pendientes los gates completos del candidato final, la imagen y su ensayo, las cuatro migraciones físicas, las autenticaciones y la aceptación de los 97 requisitos.

## Reparación de geometría móvil y excepción de colas

La barra de la oficina distribuye sus quince accesos en filas. Configuración usa un selector nativo para sus siete secciones en móvil y conserva las pestañas de escritorio; el resumen se organiza en dos filas y las acciones de empresas siguen disponibles. La sonda final midió 1.088,5 píxeles a 360 de ancho, frente al presupuesto previo de 1.090; a 760 y 1440 midió 1.000. Las fronteras de navegación a 760 y 761 y el teclado con una altura visual de 600 también tienen recibos locales. Las focales pasaron 96 pruebas de cinco archivos en la versión anterior del sello y 36 pruebas de tres archivos sobre el sello V3. La revisión independiente V3 verificó siete escenarios y dos controles de runtime, incluidos filtros y transiciones 760/761/1100. Cada recibo conserva los hashes de las fuentes que probó. Son pruebas con API simulada; no acreditan operaciones físicas ni aceptación publicada. Las corridas anteriores fallidas y sus errores de red se conservan.

El hueco de colas proviene del commit ya publicado `dc3485216b58286020624d2531a469247a85265e`, que trasladó la fecha de lectura al encabezado común. La revisión independiente permite ajustar sólo cuatro presupuestos `foldDesaprovechado`, de 466 a 494 píxeles, para `/queues` a 1100, 1440, 1920 y 2560 de ancho. El timestamp, la recarga, las filas, los filtros y las acciones se conservan; no se añade relleno para satisfacer la medida. La excepción está condicionada a comprobar las reparaciones y registrar las mejoras reales. El gate, las métricas y los objetivos deben permanecer idénticos. Su revisión consta en `S/queues-layout-exception-independent-review/review.json`.

La QA oficial V3 midió 84 estados con el alias `Steven/jarvis`, incluida la tarjeta del agente abierta por query. Ese estado no acredita la ficha completa `AgentSheet`, que requiere `ficha=1`. Conservó fuentes y baseline, cerró sus procesos y terminó con exit 1 únicamente por los cuatro presupuestos de colas y dieciocho mejoras pendientes de ratchet. El recibo es `S/final-layout-enrolled-takeover/qa-layout-v3-run/receipt.json`; su diagnóstico no acredita uso real de las API ni aceptación publicada.

El update oficial con la excepción revisada terminó con exit 0 y sin procesos propios restantes. El baseline cambió 29 campos: cuatro aumentos de colas, dieciocho mejoras que el gate reclamaba, tres reducciones menores y cuatro descriptores del máximo observado. Ningún otro presupuesto subió; los scripts del gate permanecieron idénticos. El recibo `S/final-layout-baseline-update/execution-v3/receipt.json` conserva el baseline antes y después; el nuevo SHA256 es `37d81aee263723ca9fc15c0e71e9a8710bfd9b0d4a3b61896a007c8e3d4bed88`. Su revisión independiente y el gate normal del commit final siguen siendo necesarios.

La fixture multimedia realiza un gesto de scroll del lector antes de previsualizar archivos y espera que Configuración termine de cargar antes de elegir su selector móvil o pestaña de escritorio. Conserva todos los clics y aserciones. La focal posterior pasó tres casos con PostgreSQL, Chromium y SDK reales en 30,551 segundos, usando un proveedor CLI sintético; la fuente y los procesos permanecieron comprobados. El recibo `S/chat-media-fixture-repair/focal-run2/receipt.json` tiene exit 0 y conserva `success=false` por un clasificador de ausencia Docker sensible a mayúsculas. La auditoría complementaria `S/chat-media-fixture-repair/owned-resources-closure-audit-v2.json` acredita los cuatro recursos temporales ausentes; el recibo de la focal registra los grupos propios cerrados. El fallo previo de carga de la fixture sigue conservado; estas focales no sustituyen la matriz final ni verifican un proveedor externo.
