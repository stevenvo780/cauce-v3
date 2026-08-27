# Revisión del integrador — segunda ola (36 commits: fencing, gateway, cuarentena, tests de consola)

## fencing — con-defectos

COMPORTAMIENTO: LIMPIO. e110f80 y 8d94cf5 son mudanzas textualmente puras. Verificado con subsecuencia byte-exacta (LCS a nivel de línea, sin normalizar espacios) y con censo AST usando la TypeScript 5.9.3 del propio repo, contra el estado previo de repository.ts y contra el baseline de la ola (e3abcf6).

e110f80 (repository.ts 5.787 -> 4.331 líneas, deliveries.ts 1.493): las 1.472 líneas significativas que salieron de repository.ts aparecen en packages/store/src/repository/deliveries.ts EN EL MISMO ORDEN y con los mismos bytes. Las únicas diferencias son 11 líneas de import, la cabecera de clase (deliveries.ts:291 `export abstract class DeliveriesRepository extends MessagesRepository`), 8 declaraciones abstractas nuevas (deliveries.ts:292-299), 12 modificadores `export` añadidos y el cambio `private` -> `protected override` en 8 firmas que se quedaron en repository.ts. Cero cuerpos alterados.

8d94cf5 (repository.ts 206 -> 42 líneas): `cancelDelivery`, `cancellationReason` y sus dos constantes viajaron byte-idénticos a packages/store/src/repository/deliveries/control.ts, incluido el SELECT con `FOR UPDATE OF d` (control.ts:70-77) y el UPDATE que limpia el vallado `claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL` (control.ts:93-99). Además movió `insertAck` desde packages/store/src/repository/agents/notifications.ts (41 líneas) byte-idéntico, con su `ON CONFLICT(event_id) DO UPDATE SET applied=true,renewal=EXCLUDED.renewal,payload=EXCLUDED.payload WHERE delivery_acks.applied=false AND EXCLUDED.applied` intacto (control.ts:187-191).

CENSO GLOBAL e3abcf6 -> HEAD sobre packages/store/src: 139 nombres de método / 140 implementaciones antes y después, CERO cuerpos distintos, CERO firmas distintas (parámetros, tipos y retorno), CERO métodos perdidos o nuevos. 202 declaraciones de nivel superior antes y después, CERO textos distintos. Multiconjunto de literales SQL: 384 antes, 384 después, byte-idénticos — 0 perdidos, 0 duplicados, 0 nuevos. Recuentos de vallado idénticos: FOR UPDATE 58, FOR SHARE 40, FOR UPDATE SKIP LOCKED 4, claim_token 72, consumer_epoch 17, ON CONFLICT 51.

FACHADA: packages/store/src/repository.ts (42 líneas) exporta exactamente 64 símbolos, CONJUNTO IDÉNTICO al de 2a22107 y al de e3abcf6 (resolví los `export *` recursivamente; diff vacío en ambas direcciones). packages/store/src/index.ts no cambió en toda la ola.

CADENA: 13 eslabones estrictamente lineales, CauceRepository -> DeliveryControlRepository -> AgentNotificationsRepository -> AgentChainControlRepository -> AgentFaninRepository -> AgentsRepository -> DeliveriesRepository -> MessagesRepository -> ConfigRepository -> OutboxRepository -> JobsRepository -> ObservabilityRepository -> QuotasRepository. Sin ciclos (grafo de imports de packages/store/src: 0 ciclos incluso contando los `import type`). Verificado en runtime con tsx: la cadena de prototipos resuelve 104 miembros, exactamente los MISMOS 104 nombres que la cadena del baseline, cero duplicados, `new CauceRepository({})` funciona. Un único constructor de datos en la cadena (quotas.ts:224). `StoreError` sigue definido una sola vez (quotas.ts:10). Nadie en el monorepo reflexiona sobre prototipos ni espía `*Repository.prototype`.

CONTROLES INDEPENDIENTES QUE CORRÍ: `tsc --noEmit -p tsconfig.json` rc=0; los 10 tests de store sin Postgres verdes (30 aserciones); `sql-locking-clauses.test.ts` verde 2/2. No toqué nada del repo.

Los defectos que listo son lo que el verde no garantiza: una red de seguridad que se cayó del todo, documentación de seguridad borrada, y cero cobertura ejecutada sobre el SQL movido.

## store-resto — con-defectos

COMPORTAMIENTO: LIMPIO. Los nueve commits asignados (39a8b76, 0e6ca4c, 4b7e33a, f5467da, f4673f4, b778edb, 252a1ae, 1e17c9d, e850d12) son mudanzas textualmente puras. No encontré ni una línea de lógica perdida, duplicada ni alterada. Los defectos que listo son de red de seguridad, diseño y punteros rotos, no de conducta.

MÉTODO (scripts en el scratchpad, no en el repo; baseline e3abcf6):
1) Subsecuencia byte-exacta por commit: comparé la lista ordenada de líneas BORRADAS contra la de líneas AÑADIDAS de cada commit. 39a8b76: 28=28, única diferencia `./accounts.js` -> `../accounts.js`. 0e6ca4c: 9=9, sólo una línea en blanco que cambia de extremo. 4b7e33a: 63=63, ídem. f5467da: 334/333, tres diferencias (un `import type DatabaseClient` que quedaba sin uso, `private`->`protected` en assertReplayAuthorization, un blanco). f4673f4, b778edb, 252a1ae, 1e17c9d, e850d12: TODA diferencia es cabecera de import/re-export, línea de declaración de clase o línea en blanco. Cero cuerpos tocados.
2) Censo con el parser de TypeScript 5.9.3 del repo: 110 métodos concretos antes y 110 ahora (104 nombres únicos + 6 overrides); 0 perdidos, 0 nuevos; los 110 cuerpos son BYTE-IDÉNTICOS al baseline (comparación del bloque `{...}` sin normalizar espacios). 0 declaraciones top-level perdidas, 0 duplicadas entre módulos.
3) SQL: extraje los 398 literales de plantilla con SELECT/INSERT/UPDATE/DELETE de todo packages/store/src en e3abcf6 y en HEAD. El multiconjunto ordenado es idéntico byte a byte (`cmp` sin diferencias). Ni una cláusula, ni un `$n`, ni un FOR UPDATE movido.
4) Resolución de símbolos con el type checker (lo que el diff textual no ve): para los 138 métodos del paquete resolví CADA identificador libre a su declaración y comparé contra el baseline. 128 idénticos; los 10 con diferencia son el MISMO texto de declaración con `export` delante y en otro fichero (positiveMs, leaseCapInstantSql, leaseCapMsSql, chainNode, postgresTextSafe, RoutingTarget, AgentOutputOutcome, OpenChainGate). Cero capturas de símbolo, cero sombreados.
5) Runtime (tsx, smoke fuera del repo): `new CauceRepository()` resuelve 13 niveles de prototipo y 104 miembros, exactamente el mismo conjunto de nombres que el censo estático. 0 ciclos de import (grafo DAG, verificado también incluyendo los `import type`).
6) Superficie: repository.ts exporta los MISMOS 64 nombres que en e3abcf6 (conjunto idéntico); packages/store/src/index.ts y packages/store/package.json sin cambios desde e3abcf6.
7) Controles independientes que corrí yo: `tsc --noEmit -p tsconfig.json` rc=0; `eslint packages/store --max-warnings 0` rc=0; 12 suites del store sin sufijo -postgres: 62 tests verdes.

LAS TRES LECCIONES DE LA OLA 1:
- REINDENTACIÓN: CORREGIDA. Los seis módulos nuevos (agents.ts, agents/fanin.ts, agents/chain-control.ts, agents/notifications.ts, observability/policy.ts, deliveries/control.ts) tienen CERO miembros de clase a columna 0. Pero los 46 de la ola 1 siguen sin reparar (config.ts 10, observability.ts 11, outbox.ts 11, messages.ts 6, jobs.ts 6, quotas.ts 2) y e110f80 —de esta ola, fuera de mi lote— añadió 8 más.
- NO ABRIR EXPORTS NUEVOS: CORREGIDA en lo que importa. Los 9 commits abren 5 símbolos privados (uuidPattern y chainNode en fanin.ts; positiveMs, leaseCapInstantSql y leaseCapMsSql en observability/policy.ts) y los CINCO tienen consumidor real en otro fichero. Cero exports huérfanos en los seis módulos nuevos (comprobado nombre por nombre contra todo el monorepo), frente a los 14 huérfanos de config.ts en la ola 1. Además f4673f4 mantuvo el bloque de re-export en observability.ts, así que la superficie del paquete no se movió.
- JERARQUÍA NO INVERTIDA: NO CORREGIDA, se duplicó. 8 miembros abstractos antes, 16 ahora, y la cadena pasó de 7 a 13 clases. Justicia con la atribución: los 8 abstractos nuevos los declara e110f80 (fuera de mis nueve); mis nueve no declaran ni uno, pero aportan cuatro de los seis niveles nuevos y las implementaciones que ratifican la inversión.

LA GUARDIA sql-locking-clauses.test.ts: NO es recursiva y NO audita repository/. Sigue byte a byte como en 2a22107 (último commit que la tocó, anterior al informe de la ola 1). Esta ola la dejó peor que nunca: audita 46 de 205 literales SELECT (22%) y 9 de 69 cláusulas de bloqueo (13%); en e3abcf6 eran 131/205 y 40/69.

EFECTOS COLATERALES QUE DECLARO: no modifiqué ningún fichero del repo. Al correr las 12 suites del store, dos de ellas (catalogo-no-se-filtra.test.ts y muestra-no-es-total.test.ts, que no llevan el sufijo -postgres) arrancaron un Postgres desechable vía testcontainers; el contenedor se destruyó solo al terminar y los contenedores cauce-v3-prod-* siguen arriba y con el mismo uptime (47h-3d). La guarda de tests/helpers/postgres.ts exige que la base se llame `cauce_test*`, así que la base viva nunca estuvo al alcance.

## gateway — con-defectos

La MUDANZA es limpia y byte-exacta; los defectos están en el envoltorio (un test rojo real que el verde no cubre) y en el rótulo "legado candidato".

EVIDENCIA DE FIDELIDAD (parser de TypeScript 5.9.3, no a ojo; baseline `git show 8b90d00^` para app.ts (2.759 líneas) y `git show 6343cd2^` para terminal/plugin.ts (2.263)):
1) Registros de ruta/hook: extraje con el AST todos los `app.<get|post|put|delete|patch|addHook|decorate>` del baseline y de HEAD, los dedenté y comparé texto exacto. app.ts: 50 claves en el baseline, LAS MISMAS 50 en HEAD, 0 sólo-en-baseline, 0 sólo-en-HEAD, 0 cuerpos distintos. terminal: 11 = 11, idéntico. Ningún handler, ninguna validación de identidad y ningún guard cambió un byte.
2) ORDEN DE REGISTRO idéntico, verificado resolviendo la composición de app.ts:375-405: addHook onRequest(app.ts:376) → /v3/status(health.ts:33) → /v3/console/access(console.ts:398) → publish x5(core.ts:365-419) → topology+messages(console.ts:428,436) → publish-intents x2(legado-candidato.ts:73,112) → phase3 x21(console.ts:451-843, incl. decorate sondaDeDocumentos:627) → chain-gates x3(legado-candidato.ts:149-189) → config x5(console.ts:859-911) → runtime x9(core.ts:437-1402, incl. /v3/ws:719 y addHook onClose:1402). Es la MISMA secuencia 1..50 del baseline (app-baseline.ts:968,981,995,1081…2717). Terminal igual: session-control(219,316,689,723,803) → app.register(scope) de la sonda(governance-probes.ts:114) → addHook relay(relay-proxy.ts:320) → relay x5(329,355,645,859,1001), calcado de plugin-base.ts:695…2124.
3) Declaraciones: de 223 nombres top-level del app.ts baseline, 222 tienen gemelo BYTE-IDÉNTICO; las 6 diferencias son sólo el prefijo `export` (o firma repartida en varias líneas: `principal`, `publicPublish`); la única reescrita es `buildGateway`. En terminal: de 190, sólo 5 difieren (2 `export`, `registerTerminalControlPlane`, y `relayGovernance`/`measuredFacts` cambiando `buildGovernanceRelay(config)`→`governanceProbes.buildRelay()` y `options.`→`runtimeOptions.` con el MISMO objeto, plugin.ts:304).
4) Multiset línea a línea (baseline vs los 6 módulos nuevos): 38 líneas sólo-en-baseline, TODAS cabeceras de import/type/firma; 306 sólo-en-HEAD, TODAS imports, interfaces, firmas y `return`. Cero lógica perdida, cero lógica inventada. Por commit, el diff dedentado sólo pierde imports: 8b90d00 (reordena `validatedPublishReceipt` al final de shared.ts, cuerpo intacto), 1cfa99f 3 líneas, 71ba355 4, bb75f4e 11, 951fe67 18 — todas de import.
5) Guards contados: requirePermission 35=35, requireOperatorPermission 11=11, validatePrincipal 3=3, `await principal(request,` 41=41; terminal: deny 6=6, attributionAllows 5=5, routingAuthority 1=1, cohortRoutingAuthority 2=2, relayAuthorized 2=2, requireOperatorPermission 5=5. Los +1/+3 de assertPermission/assertPrincipal/authorizeAgentTarget son declaraciones de las interfaces nuevas, no llamadas.
6) COMENTARIOS: 340→340 en app.ts y 136→136 en terminal. Cero comentarios borrados — a diferencia de la primera ola (190 perdidos).
7) Semántica Fastify: en fastify 5.10.0 los hooks se ensamblan en `preReady` (services/gateway/node_modules/fastify/lib/route.js:388-394), así que lo que importa no es addHook-vs-ruta sino el ámbito y el orden ENTRE hooks: el de consola sigue en la raíz (app.ts:376) y el del relay dentro del scope encapsulado que main.ts:229 registra. Ambos preservados. 0 ciclos de import en runtime (34 ficheros; el borde app.ts↔core.ts es `import type`, core.ts:23).
8) Controles ejecutados por mí: tabla de rutas VIVA con `printRoutes` (flag on/off) — coincide ruta por ruta; `pnpm --filter @cauce/gateway test` 471/471 verdes; `eslint services/gateway --max-warnings 0` limpio; gate de tamaño del plan 13 cumplido (mayor fichero tocado: core.ts 1448 < 1500).

RESPUESTA DIRECTA: ninguna ruta perdió prefijo ni guard. Las legado-candidatas SÍ quedaron tras flag (`enableLegacyCandidateRoutes`, app.ts:343/389/399), pero el flag por defecto es ON, no tiene cableado operativo, y apagarlo rompe una ruta VECINA que no está tras el flag.

DERIVA: el repo se movió bajo mí (HEAD pasó de 2db0e9b a 73e533c con otras instancias committeando). `git diff 2db0e9b -- services/gateway/` sólo muestra README.md, y tests/gateway-hardening sin cambios: los hallazgos valen en HEAD actual.

## terra-tests — con-defectos

Auditoría de los commits de `apps/console` de Codex Terra (c63ccaa, 1ca3312, 919e271, a1425e5, 832888d, 00d3391; los tres primeros ya entraron en la revisión de los 46, los tres últimos son nuevos). VEREDICTO SOBRE LA PREGUNTA CENTRAL: el arreglo de los rojos fue LEGÍTIMO. Medí el estado de partida clonando el árbol en c63ccaa^ a un sandbox aislado y corriendo la suite: eran 9 tests rojos en 3 ficheros (no «13 en 6», que era una medición caduca previa a que Gemini reparara los suyos). Los 3 arreglos de c63ccaa son puro harness —resolver `@import` porque `styles.css` quedó en 4 líneas de import, y seguir a `listMessages` tras la partición de store— y probé por MUTACIÓN que los tres conservan sus dientes: bajar un token tipográfico, meter una clase inexistente y subir el `left(...,240)` a 500 los vuelven a poner rojos. Paridad demostrada: 243 clases CSS antes = 243 después, 37 tokens `:root` antes = 37 después, cero diferencias. Ni un skip, ni un mock ampliado, ni una aserción borrada, ni un fichero de producto tocado. LOS DEFECTOS ESTÁN EN OTRO SITIO. (1) `a1425e5` no arregla ningún rojo: borra dos entradas del catálogo de campos inertes (`container_name`, `runtime_user`) e invierte las aserciones en el mismo commit para que casen —los tests estaban verdes antes, lo verifiqué contra 2a22107—, sin el `codex-terra-bugs-reales.md` que la orden exigía y que no existe; el veredicto técnico sí es correcto (authority.ts:35 hoy lee esas columnas de la tabla), el método no. (2) Ese mismo catálogo enseña hoy al operador tres citas MUERTAS a `packages/store/src/repository.ts:5109/:5151` sobre un fichero de 42 líneas, y la guarda de citas (campos-inertes.test.ts:73-79) sólo valida la FORMA del `ruta:línea` con un regex, nunca que exista: verde garantizado con la pantalla mintiendo. (3) La partición de DirectivaModal (553→190+4 módulos) es limpia en conducta y el test no se tocó, pero se lleva por delante ~101 líneas de comentario con invariantes medidas que no viven en ningún otro sitio (CSP `style-src 'self'`, los 2.894 px de rueda, Escape en captura, `onMouseDown` y no `onClick`) — el mismo defecto que la revisión de la primera ola ya había fichado. (4) La Tarea 3, barrido de exports muertos, NO se hizo: quedan 142 exports sin consumidor fuera de su fichero y la ola añadió 18 nuevos. (5) `00d3391` duplica `aliasDe` en dos ficheros y extrae un componente que ninguna prueba cubre. Repo no modificado; todo el trabajo se hizo sobre copias en el scratchpad.

## release-quarantine — con-defectos

Auditoría de coherencia sobre la cuarentena de release (commits 9e98a80, 1470d19, 4b73424, 2db0e9b, HEAD declarado 2db0e9b) tras las 4 verificaciones que sí quedan en verde y 3 zonas con deuda real.

NOTA METODOLÓGICA: durante esta revisión el repo recibió actividad concurrente real de otra(s) instancia(s) — 4 commits nuevos después de 2db0e9b, culminando en 73e533c ('_legado BORRADO del arbol — git es el archivo, decision del dueño'), que sacó _legado/ del árbol de trabajo (preservado en git history; índice sobreviviente en docs/bitacora/legado-indice.md). Verifiqué con `git diff --stat 2db0e9b..73e533c` que ninguno de los archivos citados en mis hallazgos cambió entre ambos extremos, así que los hallazgos son válidos en todo el rango. Hubo además 8 ficheros con cambios sin commitear en el working tree (README.md, varios README de paquete, fanin-synthesizer.ts/test, schemas.ts/test) que no toqué y que parecen pertenecer a otra sesión activa en el mismo host.

VERIFICACIONES EN VERDE (sin hallazgos):
- (2) package.json: los ~32 scripts referencian rutas existentes (comprobado uno a uno); `bash -n`/`node --check` limpios en todos los scripts invocados.
- (3) ops/Makefile + Makefile raíz: `make -n <target>` limpio en los 23 targets reales.
- (5) scripts/test-all.mjs: `assertMatrixIsComplete()` cierra exactamente sobre los 10 scripts `test:` del package.json (7 en SUITES + 3 en SEPARATELY_GATED), sin huérfanos ni faltantes.
- (6) `pnpm ops:manifests`: rc=0, 15 alias validados, unidades regeneradas sin diff contra lo checked-in (`git status` limpio tras correrlo).
- (7) Los 6 esquemas de evidencia de release (build-evidence, migration-integrity-evidence, release-candidate, release-writer-snapshot, rollback-baseline, verification-evidence) ya no existen en el árbol vivo y ningún fichero vivo los carga (confirmado por grep). El plan original (docs/bitacora/ordenes-ejecutadas/ronda3/codex.md:6) hablaba de '7' nombrando en realidad 8 candidatos, incluyendo test-evidence y testcontainers-evidence — estos dos quedaron correctamente FUERA de la cuarentena porque siguen teniendo consumidores vivos reales (ops/scripts/source-digest.py, validate-testcontainers-evidence.py, ops/tests/source-digest-domains.test.mjs, tests/unit/source-digest-closure.test.ts) — la desviación del plan fue la decisión correcta, no un defecto.
- El bug crítico de la primera ola (rollback-bridge.schema.json rompiendo 3 suites reales, documentado en ordenes/reportes/claude-revision-46-commits.md) está genuinamente resuelto: el test que lo cargaba se archivó completo, tests/unit/source-digest-closure.test.ts se dividió limpiamente (329 líneas vivas vs. 95 archivadas) y ya no lo referencia, y ops/tests/source-digest-domains.test.mjs ya no lo usa como sentinel.
- deploy/compose.yaml ya no referencia relay-worker/shadow-router (coherente con lo que ya afirmaba la documentación de cuarentena).

(4) ops/scripts/validate.sh: la porción estática (bash -n / node --check de todos los scripts, validación de los 12 schemas JSON incluidos los 4 de tests/fleet-release, sintaxis de ~30 scripts Python, generación y verificación de unidades systemd, las 20 aserciones de política de compose) corrió limpia sin ningún error emitido. La porción con Docker real (container-supervisor, reaping, container-cutover, source-digest-domains, docker compose config) no llegó a completar dentro del tiempo disponible por la carga del host compartido (múltiples procesos Docker y una ejecución concurrente de `pnpm typecheck && pnpm lint && pnpm test:unit` de otra instancia corriendo al mismo tiempo) — no puedo certificar el rc final de punta a punta, aunque nada de lo que sí corrió emitió error.

Los 3 hallazgos mayor/crítica están concentrados en la documentación operativa (deploy.md, rollback.md, ops/README.md) y en la suite QA 'authentic', no en el código de producción en sí — el código vivo (compose de producción, package.json, Makefile, generadores) está coherente. Los 2 hallazgos menores ya estaban parcial o totalmente trackeados en planes existentes."

## minimax-terra-moves — con-defectos

ACLARACIÓN DE ENCUADRE (importante): los 4 commits que el encargo lista como "moves de MiniMax r6" (1470d19, be8dd2e, 4b73424, f3e5fac) NO son de MiniMax. Los 7 commits reales de ordenes/ronda6/opencode-minimax.md son a959c46 (Tarea1: 6 schemas), 90f690c (Tarea2.1: harness), c9d87f3 (Tarea2.2: 5 tests), 0f77d25 (Tarea2.3: 4 scripts), 315a84c (Tarea3: docs sueltos), 7a0f0d3 (Tarea4: censo) y 36469ce (Tarea5: residuos host) — todos ANTERIORES a e3abcf6, ya cerrados antes de que empezara la "segunda ola". Los 4 commits señalados son de Codex: 1470d19+9e98a80 completan SU PROPIA cuarentena de "maquinaria de release" (los 7 schemas que la orden de MiniMax explícitamente prohíbe tocar: "se los lleva Codex con la maquinaria, su ronda 3"); be8dd2e ajusta evidencia rootless (cluster 4826433/e24cea7/e6d9c8b, ajeno a MiniMax); 4b73424+f3e5fac retiran referencias muertas a shadow-router/relay-worker (servicios archivados desde la purga original, sección 1 de _legado/README.md). Verificado con `git log --oneline -- _legado/README.md` en la ventana: solo 1470d19 y 9e98a80 la tocan, ambos Codex.

VEREDICTO POR TAREA (los 7 commits reales de MiniMax): Tarea1 (6 schemas), Tarea2.2 (5 tests) y Tarea2.3 (4 scripts) coinciden EXACTAMENTE con la orden (git mv puro, mismos basenames, mismo destino) y la familia DLQ (dlq_cli.py+5 wrappers) quedó intacta como se pidió. Tarea3 ejecutó exactamente las 2 correcciones de una línea del reporte propio (14→15 alias; ops/runbooks/rollback.md→docs/bitacora/rollback.md) y movió consola-roles-con-nombre.md a bitácora, una de las dos opciones que el propio reporte autorizaba. Tarea5 (residuos host) es sólida: comando+tamaño por fila, spot-check confirma los 13 árboles /opt/cauce-v3-release-* y el clon muerto existen tal como se reportó. Tarea4 (tabla dudosos) SÍ agrupa (a)-(f) exactamente como pide la orden.

DEFECTOS REALES (lo que el verde no detecta): (1) Tarea2.1 tiene un huérfano sin resolver por un error de la propia orden — nombró "ops/scripts/healthcheck.mjs" (vivo, MiniMax verificó bien y correctamente NO lo movió) cuando el fichero que de verdad sólo aparecía en el Dockerfile huérfano era el OTRO "ops/harness/healthcheck.mjs" (mismo basename, fichero distinto): 0 referencias confirmadas, quedó huérfano de verdad sin mover. (2) _legado/README.md nunca fue tocado por MiniMax en toda la ronda 6: los 6 schemas, los 4 scripts y los 3 ficheros de harness que sí movió no aparecen en el índice ("contingentes/ops/schemas/" sigue listando solo 1 fichero de ronda 4; "contingentes/ops/scripts/" solo 3; el contador "52 ficheros" no subió). (3) censo-contingentes.md:3 quedó con "45 dudosos (tabla abajo...)" tras la reescritura de la Tarea4, que ya no es una tabla ni tiene 45 ítems. (4) Referencias colgantes nuevas en documentación/comentarios operativos VIVOS (ninguna detectada por typecheck/lint/tests): ops/runbooks/alias-cutover.md:7,22 (gate-snapshot.schema.json, preflight.sh) y ops/scripts/container-adapter-supervisor.sh:896 + separar-config-alias.mjs:41 (aplicar-separacion-config.sh, para la función CONFIG_POR_ALIAS que sigue "activa en código" según el propio censo).

SOBRE f3e5fac (verificado empíricamente, no sólo leído): SÍ es el fix correcto del falso-rojo-bajo-root documentado en ordenes/00-PROTOCOLO.md:33. Reproduje el bug real: en este sandbox (root, uid 0) copiar con `copyFile` un fichero fuente propiedad de otro uid (1000) produce un destino que CONSERVA el uid 1000 del origen (verificado con fs.copyFileSync), mientras que leer+escribir (`readFile`+`writeFile`) crea el destino con el uid del proceso actual (0), como exige `assertRuntimeBridge` en deploy/runtime-package-smoke.mjs:104-106. Confirmé además ejecutando la suite real: con el código ANTERIOR a f3e5fac (checkout aislado en worktree, apuntando a los ficheros reales del repo) y corriendo como root, fallan exactamente 2 tests con "Hermes runtime bridge is not owned by the runtime user"; con el código de f3e5fac (HEAD actual), la misma suite pasa 6/6 como root. No esconde nada más: no toca assertRuntimeBridge (la validación real no cambia), solo corrige cómo el TEST crea sus fixtures.

NOTA DE ENTORNO: el repo estuvo en escritura activa durante esta revisión (HEAD avanzó de 2db0e9b — fin del rango asignado — a 73e533c, que borró _legado/ completo del árbol "decisión del dueño"). No contamina estos hallazgos porque todo se verificó contra commits fijos (`git show <sha>:<path>`), pero el usuario debe saberlo: cualquier ruta bajo _legado/ que se busque HOY en el árbol de trabajo ya no existe (está en el historial).

## Hallazgos

### [mayor] (fencing) La guardia estática de SQL quedó ciega al 100% del SQL del bus: repository.ts ya no tiene ni un literal, y las 4 cláusulas FOR UPDATE SKIP LOCKED, los 72 claim_token y los 17 consumer_epoch viven todos fuera de su alcance — y el test sigue verde 2/2

packages/store/test/sql-locking-clauses.test.ts:22-26 sigue enumerando los ficheros así:

    function sourceFiles(): string[] {
      return readdirSync(SOURCE_DIR)          // SOURCE_DIR = packages/store/src
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(SOURCE_DIR, name));
    }

`readdirSync` no es recursivo. La entrada `'repository'` no termina en `.ts` y el `.filter()` la descarta en silencio. La primera ola ya lo reportó como [mayor]; la segunda ola NO lo arregló y lo llevó al extremo: `git log e3abcf6..HEAD -- packages/store/test/` está VACÍO (ni un fichero de test tocado en los ~36 commits).

Medición sobre el árbol actual, aplicando la propia lógica del test: la guardia ve 13 ficheros y 46 literales con SELECT (9 con cláusula de bloqueo); los reales son 26 ficheros, 205 literales y 69 cláusulas de bloqueo. Auditaba el 100%, luego el 64% tras la ola 1, y hoy el 22% de los literales y el 13% de las cláusulas de bloqueo.

Lo decisivo: packages/store/src/repository.ts —el único fichero de la estirpe que la guardia todavía abre— tiene CERO literales SQL. Los 46 que aún ve son de accounts.ts, agent-profile.ts, configuration.ts, db.ts, fleet-activity.ts y migration-integrity.ts, es decir nada del bus. Quedan fuera: repository/outbox.ts (26 literales, 19 de bloqueo), repository/agents/fanin.ts (20/8), repository/observability.ts (18/1), repository/deliveries.ts (16/7), repository/agents/chain-control.ts (15/5), repository/config.ts (15/2), repository/messages.ts (12/9), repository/quotas.ts (11/0), repository/agents.ts (10/2), repository/agents/notifications.ts (8/1), repository/jobs.ts (7/5), repository/deliveries/control.ts (1/1).

Las 12 apariciones de SKIP LOCKED del repositorio están todas en zona ciega: outbox.ts:382, :421, :545, :579, :685, :840; jobs.ts:32, :73, :142; observability.ts:400; deliveries.ts:633. Los 72 `claim_token` y los 17 `consumer_epoch` idem (outbox.ts 20/0, deliveries.ts 26/8, jobs.ts 9/0, observability.ts 4/4, control.ts 5/3, fanin.ts 1/1).

La ironía comprobable está en el commit 8d94cf5: packages/store/src/repository/deliveries/control.ts:67-68 lleva escrito «`FOR UPDATE OF d` sin función de ventana: ver `sql-locking-clauses.test.ts`, PostgreSQL rechaza esa combinación al parsear», y la consulta que justifica está en control.ts:70-77. Ese fichero es exactamente uno de los que la guardia ya no puede leer. El comentario apunta a un vigilante que dejó de mirar.

No hay violación activa hoy: apliqué la regla del test recursivamente a los 26 ficheros y da 0 ofensivas. El defecto es que la red se cayó sin ruido. Ejecuté `vitest run packages/store/test/sql-locking-clauses.test.ts` y pasa 2/2 tests auditando el 22% del SQL. Arreglo: `readdirSync(SOURCE_DIR, { recursive: true })` (Node >= 22, que el repo ya exige) o un walk explícito.

### [mayor] (fencing) e110f80 borró 8 bloques de documentación (18 líneas) que explican precisamente la semántica de vallado y de ACK tardío, sin cambiar una sola línea de código

Censo de comentarios hecho con `ts.getLeadingCommentRanges`/`getTrailingCommentRanges` sobre cada nodo del AST (no con el scanner, que se desincroniza en los literales de plantilla): 927 bloques en e3abcf6, 919 en HEAD. De las 10 diferencias, 2 son la reescritura intencionada de migrate-cli.ts por f31a985 (deploy-release.sh -> deploy/deploy.sh). Las otras 8 son pérdidas netas y TODAS son de e110f80 — verificado con `grep -cF` sobre los tres ficheros del commit: presentes 1 vez en e110f80^:packages/store/src/repository.ts, 0 veces en e110f80:repository.ts y 0 veces en e110f80:repository/deliveries.ts.

Lo borrado, con la entidad que documentaba y su ubicación actual:
1. `/** Columnas adicionales de deliveries proyectadas para rescate tardío. */` -> `interface LateResultRow` (packages/store/src/repository/deliveries.ts:75)
2. `/** Cómo se probó que la garra que firma un ACK tardío existió de verdad sobre esta entrega. */` -> `type LateClaimProvenance` (deliveries.ts:80)
3. `/** Resultado interno de materializar las salidas de un ACK. */` -> `AgentOutputOutcome` (deliveries.ts:99)
4. `/** Store claim record; event_id is the immutable ACK correlation id for this delivery. */` -> `ClaimedDeliveryEnvelope` (deliveries.ts:116)
5. `/** Every reason a proactive egress can be refused. Refusals are durable rows, never exceptions. */` -> `NotifyDenialCode` (deliveries.ts:153)
6. `/** A rejected directive still needs a bounded handle for its durable denial row. */` -> `boundedHandle` (deliveries.ts:231)
7. El docblock de 6 líneas «The store never trusts the adapter's own validation: an ACK arrives over HTTP/WS and can come from an old or adversarial adapter...» -> `agentNotifyEntries` (deliveries.ts:234)
8. El docblock de 6 líneas «Bodies, destinations and runtime-adoption assertions become normalized durable facts, never opaque ACK/relay residue. `profile_adoption` is validated and written separately under the delivery/profile locks; persisting the untrusted assertion here would make a rejected mismatch look like evidence to every reader of `deliveries.result` or `delivery_acks.payload`.» -> `sanitizedAckResult` (deliveries.ts:268)

No es cosmético: 2, 4, 7 y 8 son la justificación escrita de por qué el store no confía en el adaptador y de por qué `profile_adoption` no se persiste desde el ACK. El commit se llama «store: extrae entregas y fencing» y su mensaje no tiene cuerpo — no declara ninguna pérdida. El código sobrevivió byte a byte; el porqué de las invariantes de seguridad, no. Es el mismo patrón que la ola 1 encontró en consola (190 comentarios borrados), repetido aquí sobre el fichero más sensible del repositorio.

### [mayor] (fencing) El verde que se presenta como aval (typecheck + lint + 107/107 de consola) no ejecuta NI UNA línea del SQL movido por estos dos commits

`cancelDelivery` e `insertAck` son el contenido íntegro de packages/store/src/repository/deliveries/control.ts. Su única cobertura del lado store es packages/store/test/terminal-recovery-postgres.test.ts:219 y :278, que exige testcontainers y no se corrió (hay producción viva en cauce-v3-prod-*).

De los 50 ficheros de packages/store/test, 40 llevan sufijo `-postgres` y necesitan contenedor. De los 10 restantes, sólo 3 importan `CauceRepository` (agent-target-access.test.ts, muestra-no-es-total.test.ts, timeout-terry-backoff.test.ts -> timeout-retry-backoff.test.ts) y ninguno toca entrega, claim, epoch ni ACK: `grep -n 'cancelDelivery|ackDelivery|claimDeliveries|acquireLease|insertAck' packages/store/test/*.ts | grep -v postgres` no devuelve nada.

Del lado gateway tampoco hay red: services/gateway/src/password-auth.test.ts:68 lo sustituye por `cancelDelivery: vi.fn(async () => ({ cancelled: true }))`, o sea que el único test que nombra `cancelDelivery` fuera de Postgres verifica el mock, no la transacción.

Corrí yo mismo lo que sí es ejecutable: `tsc --noEmit -p tsconfig.json` rc=0 y los 10 tests de store sin Postgres (30 aserciones, verdes). Confirmo el verde y confirmo que no significa nada sobre el corazón de estos dos commits: mi garantía sobre el SQL viene de la comparación byte a byte (384 literales idénticos), no de ninguna ejecución. Quien lea «typecheck+lint+tests verdes» en el reporte de la ola debe saber que el fencing no se probó.

### [menor] (fencing) e110f80 duplicó la inversión de dependencias de la ola 1: DeliveriesRepository declara 8 abstractos cuya implementación vive en 4 módulos DESCENDIENTES, e insertAck acabó dos niveles por debajo de quien lo llama

packages/store/src/repository/deliveries.ts:292-299 declara ocho miembros que la clase base necesita y no implementa. Sus únicas implementaciones están todas más abajo en la cadena:
- `profileRuntimeExpectation` -> repository/agents.ts:103
- `recordProfileRuntimeAdoption` -> repository/agents.ts:129
- `selfRoleFromProfile` -> repository/agents.ts:215
- `routingTargets` -> repository/agents.ts:238
- `delegationFeedbackForAck` -> repository/agents/chain-control.ts:304
- `materializeAgentOutputs` -> repository/agents/chain-control.ts:359
- `materializeAgentNotifications` -> repository/agents/notifications.ts:415
- `insertAck` -> repository/deliveries/control.ts:178

El total de declaraciones abstractas del paquete pasó de 8 (e3abcf6) a 16 (HEAD); las 8 nuevas son exactamente estas. Efecto medible: `DeliveriesRepository` —el módulo que el commit dice «extraer»— no se puede instanciar, ni probar, ni compilar solo; necesita cuatro módulos que están por debajo suyo.

El caso más llamativo lo introduce 8d94cf5: `insertAck` se llama desde deliveries.ts:924, :939, :968, :1019, :1043, :1166 y :1340, y su implementación está ahora en `DeliveryControlRepository` (deliveries/control.ts:178), DOS eslabones por debajo de `DeliveriesRepository`, en un fichero que además contiene `cancelDelivery`. El commit anterior b778edb la había puesto en agents/notifications.ts apenas una hora y media antes: el escritor de la fila del libro mayor de ACKs cambió de casa dos veces el mismo día.

En runtime no cambia nada (verificado: los 104 miembros resuelven y la instancia funciona). Lo que se perdió es la posibilidad de leer, probar o poner en cuarentena una capa por separado, que es lo que las extracciones dicen buscar.

### [menor] (fencing) e110f80 publicó como export 12 ayudantes que eran privados del módulo (15 en toda la ola)

Comparación de modificadores por AST entre e3abcf6 y HEAD. Los que pasaron de privados de fichero a `export`, con origen y destino:

De e110f80 (12): `AgentOutputOutcome` (repository.ts:169 -> repository/deliveries.ts:99), `OpenChainGate` (:183 -> deliveries.ts:112), `maxAgentOutputMessages` (:211 -> deliveries.ts:134), `maxNotifyBodyBytes` (:221 -> deliveries.ts:138), `notifyKinds` (:223 -> deliveries.ts:140), `handlePattern` (:224 -> deliveries.ts:141), `AgentOutputEntry` (:289 -> deliveries.ts:142), `RoutingTarget` (:301 -> deliveries.ts:148), `AgentNotifyEntry` (:338 -> deliveries.ts:165), `postgresTextSafe` (:394 -> deliveries.ts:184), y de otros commits de la ola `uuidPattern` (:225 -> repository/agents/fanin.ts:20), `chainNode` (:263 -> fanin.ts:30).

De otros commits (3): `positiveMs`, `leaseCapInstantSql`, `leaseCapMsSql` (repository/observability.ts:30/70/90 -> repository/observability/policy.ts:21/61/81).

Cero exports perdidos. El daño está contenido —ninguno se re-exporta desde repository.ts (verifiqué el conjunto de 64, idéntico) y packages/store/src/index.ts no cambió— pero `postgresTextSafe`, `maxNotifyBodyBytes` y `notifyKinds` son los topes que sanean lo que llega del adaptador: publicarlos invita a que otro módulo los reimporte y los reinterprete. Sumado a los 13 de la ola 1, son 28 ayudantes privados convertidos en superficie de módulo sin que nadie lo pidiera.

### [menor] (fencing) Los 8 abstractos que introduce e110f80 están pegados a la columna 0 dentro del cuerpo de la clase: la mudanza siguió siendo un corta-pega que nadie releyó

packages/store/src/repository/deliveries.ts:292-299: las ocho líneas `protected abstract profileRuntimeExpectation(...)`, `...recordProfileRuntimeAdoption`, `...selfRoleFromProfile`, `...routingTargets`, `...delegationFeedbackForAck`, `...materializeAgentOutputs`, `...insertAck`, `...materializeAgentNotifications` empiezan en la columna 0, dentro de un cuerpo de clase cuyo resto va a 2 espacios (confirmado con `cat -A`). Además se colapsaron a una línea cada una, mientras las firmas concretas equivalentes siguen multilinea.

Es el mismo síntoma que la ola 1 reportó. Estado actual del paquete: 39 firmas y 24 docblocks a columna 0 dentro de clases — repository/config.ts 9 firmas + 1 docblock, repository/outbox.ts 9+2, repository/deliveries.ts 8+0, repository/jobs.ts 6+0, repository/messages.ts 5+6, repository/observability.ts 2+9, repository/quotas.ts 0+5, repository/agents/notifications.ts 0+1.

No afecta al comportamiento y `eslint` pasa (no hay regla de indentación para TS), pero es la prueba material de que la extracción se hizo con un script y de que el 'lint verde' no cubre esto.

### [menor] (fencing) assertPermission sigue declarado tres veces en la misma cadena con dos uniones distintas, una más estrecha que la implementación real — la ola 1 lo reportó y la ola 2 no lo tocó

Comparé cada declaración abstracta con su implementación (tipos de parámetro y de retorno, texto normalizado). El único desajuste real superviviente:

- abstracto en `QuotasRepository`, packages/store/src/repository/quotas.ts:226 -> `permission: 'read' | 'control'`
- abstracto en `ObservabilityRepository`, repository/observability.ts:314 -> `'route' | 'read' | 'control' | 'notify'`
- abstracto en `OutboxRepository`, repository/outbox.ts:200 -> `'route' | 'read' | 'control' | 'notify'`
- única implementación en `ConfigRepository`, repository/config.ts:679 -> `'route' | 'read' | 'control' | 'notify'`

TypeScript acepta la discrepancia porque los parámetros de método se comprueban de forma bivariante, así que el typecheck verde no dice nada. Los otros dos desajustes que detecté son cosméticos y no los cuento: `delegationFeedbackForAck` (comillas simples vs dobles dentro del `Pick<...>`) e `insertAck` (`renewal?: boolean` en el abstracto, deliveries.ts:298, frente a `renewal = false` en la implementación, deliveries/control.ts:184 — mismo comportamiento, siete llamadas verificadas en deliveries.ts pasan 5 o 6 argumentos).

Verifiqué además que ningún abstracto se quedó sin implementación y que ninguna implementación quedó duplicada.

### [menor] (fencing) Con repository.ts en 42 líneas, 9 punteros fichero:línea de código vivo y 5 de documentación apuntan fuera del fichero; dos de ellos son texto que lee un operador en la consola

packages/store/src/repository.ts mide hoy 42 líneas. Referencias del tipo `packages/store/src/repository.ts:NNNN` con NNNN > 42, en fuentes vivas:

- apps/console/src/features/config/campos-inertes.ts:23 y :33 (`repository.ts:5151`), :40 (`repository.ts:5109`) — son literales concatenados que se pintan en la pantalla /config
- apps/console/src/features/config/SpaceWizard.tsx:24, SpaceWizard.test.tsx:180 y :217 (`repository.ts:5109`)
- apps/console/src/features/config/arneses.ts:79 (`repository.ts:1821`)
- apps/console/src/features/config/campos-inertes.test.ts:34 (`repository.ts:1826`)
- packages/adapter-sdk/test/output-parser-contract.test.ts:102 (`repository.ts:1089`)

Y en documentación: docs/bitacora/POOL-SUSCRIPCIONES-Y-ALTA-AGENTES.md:42, :43, :169; docs/bitacora/consola-e2e-2026-07-26.md:32; docs/bitacora/queues-contadores-2026-07-26.md:11.

Seamos justos con la culpa: la ola 1 ya los había dejado apuntando fuera de un fichero de 5.787 líneas y algunos estaban mal desde antes del refactor. Lo que hace la ola 2 es rematarlo: con 42 líneas, CUALQUIER puntero numérico a repository.ts es hoy falso por construcción, y ninguno de los ~36 commits los actualizó.

### [mayor] (store-resto) La guardia estática de SQL sigue sin ser recursiva y esta ola la dejó auditando el 22% del SQL del store: 159 literales y 60 cláusulas FOR UPDATE/SHARE fuera de su alcance, con el test en verde

packages/store/test/sql-locking-clauses.test.ts:22-26 enumera los ficheros a auditar así:

    function sourceFiles(): string[] {
      return readdirSync(SOURCE_DIR)          // SOURCE_DIR = packages/store/src
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(SOURCE_DIR, name));
    }

`readdirSync` sin `{ recursive: true }`. La entrada que devuelve para el directorio es la cadena 'repository', que no termina en '.ts', y el `.filter()` la descarta en silencio. `git log --oneline -- packages/store/test/sql-locking-clauses.test.ts` devuelve 2a22107 como último commit: NADIE la tocó desde el informe de la ola 1, que ya la reportó como [mayor].

MEDIDO APLICANDO SU PROPIA LÓGICA AL ÁRBOL: en e3abcf6 escaneaba 131 de 205 literales de plantilla con SELECT (64%) y 40 de 69 con cláusula de bloqueo. En HEAD escanea 46 de 205 (22%) y 9 de 69 (13%). El desplome no es del subdirectorio: es que repository.ts pasó de 5.787 líneas a 42, así que el único fichero grande que la guardia veía se vació.

Desglose de la zona ciega en HEAD (literales SELECT / con FOR UPDATE o FOR SHARE): repository/outbox.ts 26/19, repository/agents/fanin.ts 20/8, repository/observability.ts 18/1, repository/deliveries.ts 16/7, repository/agents/chain-control.ts 15/5, repository/config.ts 15/2, repository/messages.ts 12/9, repository/quotas.ts 11/0, repository/agents.ts 10/2, repository/agents/notifications.ts 8/1, repository/jobs.ts 7/5, repository/deliveries/control.ts 1/1. Es exactamente el SQL más peligroso del repositorio: `claimJobs` (repository/jobs.ts:26), `claimOutbox` (repository/outbox.ts:308), `assertReplayAuthorization` (repository/outbox.ts:963, con `FOR SHARE OF membership,role,tenant,room`), `insertAck` (repository/deliveries/control.ts:178).

NO hay violación activa hoy: apliqué la regla (bloqueo + `OVER (`) a los 159 literales ciegos y da 0 ofensivas. Y corrí el test: `vitest run packages/store/test/sql-locking-clauses.test.ts` pasa 2/2 mientras vigila el 22% de lo que vigilaba. Arreglo: `readdirSync(SOURCE_DIR, { recursive: true })` (Node >= 20; el repo exige >= 22) o un walk explícito.

Adicional: esta es la ÚNICA guardia estática del monorepo que barre packages/store/src (grep de `readdirSync` sobre packages, tests, ops, apps y services); no hay una segunda red que la cubra.

### [mayor] (store-resto) La jerarquía invertida no se corrigió: se duplicó (8 -> 16 miembros abstractos) y la cadena pasó de 7 a 13 clases, mientras el plan escrito exige una fachada que DELEGUE

plan-reestructura/13-carpinteria-backend.md:12 dice literalmente: «Partir `CauceRepository` en módulos por dominio, la clase queda como fachada fina que delega». Lo que hay en HEAD es packages/store/src/repository.ts:41-42:

    export class CauceRepository extends DeliveryControlRepository {
    }

Cuerpo VACÍO: no delega nada, hereda. La cadena real, verificada en runtime recorriendo prototipos con tsx, tiene 13 niveles: CauceRepository -> DeliveryControlRepository -> AgentNotificationsRepository -> AgentChainControlRepository -> AgentFaninRepository -> AgentsRepository -> DeliveriesRepository -> MessagesRepository -> ConfigRepository -> OutboxRepository -> JobsRepository -> ObservabilityRepository -> QuotasRepository. En e3abcf6 eran 7.

MIEMBROS ABSTRACTOS (base que sólo funciona si la hoja la completa): 8 en e3abcf6, 16 en HEAD. Los 8 nuevos están todos en packages/store/src/repository/deliveries.ts:292-299 y los implementan clases DERIVADAS: profileRuntimeExpectation, recordProfileRuntimeAdoption, selfRoleFromProfile y routingTargets en repository/agents.ts:103, 129, 215 y 238 (un nivel arriba); delegationFeedbackForAck y materializeAgentOutputs en repository/agents/chain-control.ts:304 y 359 (tres arriba); materializeAgentNotifications en repository/agents/notifications.ts:415 (cuatro arriba); insertAck en repository/deliveries/control.ts:178 (cinco arriba). Y DeliveriesRepository los LLAMA: deliveries.ts:699, 705, 708, 881, 924, 939, 968, 1019, 1043, 1122, 1166, 1180, 1187, 1340.

ATRIBUCIÓN HONESTA: los 8 abstractos nuevos los declara e110f80 «store: extrae entregas y fencing», que no está en mi lote de nueve. Mis nueve commits NO declaran ni un abstracto nuevo (verificado con el parser: base 8 en observability/outbox/quotas, head los mismos 8 + los 8 de deliveries.ts). Lo que sí aportan es cuatro de los seis niveles nuevos de la cadena —AgentsRepository (e850d12), AgentFaninRepository (1e17c9d), AgentChainControlRepository (252a1ae), AgentNotificationsRepository (b778edb)— y siete de las ocho implementaciones que ratifican la inversión.

Consecuencia medible: ninguna de las 12 clases abstractas se puede instanciar, probar ni compilar en aislamiento. `DeliveriesRepository` —el corazón del claim/ack/lease— depende de cuatro capas que están POR ENCIMA de ella. Y el defecto de contrato de la ola 1 sigue intacto: `assertPermission` se declara TRES veces en la misma cadena (quotas.ts:226-230 con la unión estrecha `'read' | 'control'`, observability.ts:314-318 y outbox.ts:200-204 con la real de cuatro valores) y su única implementación está en config.ts:679; la de outbox.ts:200 sigue siendo 100% redundante porque entre observability y outbox sólo hay jobs.ts, que no la redeclara.

### [mayor] (store-resto) repository.ts pasó de 5.787 a 42 líneas y tiró fuera de rango seis punteros que en e3abcf6 eran EXACTOS; tres de ellos son texto que un operador lee en la pantalla /config

A diferencia de la ola 1 —donde el informe pudo decir «esos punteros ya estaban mal antes»—, estos estaban BIEN. Lo comprobé línea a línea sobre el baseline:

    git show e3abcf6:packages/store/src/repository.ts | sed -n '5109p;5151p'
    5109:   async listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    5151:   async listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {

Eran el método exacto que citaban. Tras e850d12 «store: extrae agentes y perfiles» ambos viven en packages/store/src/repository/agents.ts:278 y :321, y packages/store/src/repository.ts mide 42 líneas, así que los seis punteros apuntan fuera del fichero:
- apps/console/src/features/config/campos-inertes.ts:23 y :33 («…sólo se repinta en el registro (packages/store/src/repository.ts:5151)…»)
- apps/console/src/features/config/campos-inertes.ts:40 («`listAdapters` ni siquiera lo selecciona (packages/store/src/repository.ts:5109)…»)
- apps/console/src/features/config/SpaceWizard.tsx:24, SpaceWizard.test.tsx:180 y :217 (los tres a repository.ts:5109)

Los tres primeros NO son comentarios: son valores de `CAMPOS_INERTES` (campos-inertes.ts:17), que `motivoInerte()` (campos-inertes.ts:54) devuelve y `CollectionTable.tsx:12` pinta en la pantalla /config. Es decir, la consola le explica hoy a una persona por qué una columna es inerte citando una línea que no existe.

Para separar la culpa: los otros cinco punteros vivos ya estaban podridos antes de esta ola y no los cuento aquí —apps/console/src/features/config/arneses.ts:79, ConfigPage.inertes.test.tsx:95 y campos-inertes.test.ts:34 citan `selfRoleBrief` en repository.ts:1821/1826, y `selfRoleBrief` no existe en ningún fichero del repositorio (hoy el lector es `selfRoleFromProfile`, repository/agents.ts:215); packages/adapter-sdk/test/output-parser-contract.test.ts:102 cita repository.ts:1089, que en e3abcf6 ya era una línea de SQL de memberships.

También quedan desactualizados por esta ola docs/bitacora/queues-contadores-2026-07-26.md:11-19 (sitúa `queueSnapshot` en repository.ts:3886; 4b7e33a lo movió a repository/observability.ts:1358) y :12 (`listAudit` en repository.ts:4570; hoy repository/observability.ts:1125).

### [menor] (store-resto) Nueve de los diez métodos que pasaron de private a protected en la ola son de estos commits: la encapsulación se volvió a abrir, esta vez forzada por el diseño de herencia elegido

Comparación de modificadores método a método entre e3abcf6 y HEAD (parser de TypeScript, emparejando por nombre):
- e850d12: `profileRuntimeExpectation`, `recordProfileRuntimeAdoption`, `selfRoleFromProfile`, `routingTargets` -> `protected override async` en packages/store/src/repository/agents.ts:103, 129, 215, 238.
- 252a1ae: `delegationFeedbackForAck` y `materializeAgentOutputs` -> `protected override async` en packages/store/src/repository/agents/chain-control.ts:304 y 359.
- b778edb: `materializeAgentNotifications` -> `protected override async` en packages/store/src/repository/agents/notifications.ts:415.
- 1e17c9d: `insertProgressRelay` -> `protected async` en packages/store/src/repository/agents/fanin.ts:773.
- f5467da: `assertReplayAuthorization` -> `protected async` en packages/store/src/repository/outbox.ts:963.
(El décimo, `insertAck` en repository/deliveries/control.ts:178, es de 8d94cf5, fuera de mi lote.)

Seamos justos: ninguno es gratuito. Los siete `override` son obligatorios porque implementan los abstractos de deliveries.ts:292-299. Los dos restantes también: `insertProgressRelay` se llama desde una subclase (chain-control.ts:868) y `assertReplayAuthorization` desde otra (deliveries/control.ts:82, ocho niveles por encima de donde vive). O sea: la relajación no es descuido, es el precio obligatorio del diseño de herencia. Pero el resultado neto es el mismo que señaló la ola 1 y que nadie pidió: nueve métodos que eran privados de una clase de 11.000 líneas ahora son parte del contrato protegido de una cadena de 13, y `this.pool` sigue `protected` (quotas.ts:224), así que cualquier capa futura puede saltarse `withTransaction`.

Detalle a favor: la clase de excepción de control de flujo `NotificationPreview` (repository/agents/notifications.ts:17) se quedó SIN `export`, y su `instanceof` (notifications.ts:504) vive en el mismo fichero que el `throw` (notifications.ts:500). Ahí sí se respetó el sellado.

### [menor] (store-resto) Cinco símbolos privados pasaron a export de módulo; todos tienen consumidor real, pero uuidPattern queda ahora exportado a un carácter de distancia de UUID_PATTERN, que acepta versiones distintas

Los 9 commits abren 5 símbolos que en e3abcf6 eran privados de su fichero: packages/store/src/repository/agents/fanin.ts:20 `export const uuidPattern` y :30 `export function chainNode` (1e17c9d); packages/store/src/repository/observability/policy.ts:21 `export function positiveMs`, :61 `export function leaseCapInstantSql` y :81 `export function leaseCapMsSql` (f4673f4).

Lo bueno, y hay que decirlo porque es la lección de la ola 1 aprendida: los CINCO tienen consumidor cruzado real (chain-control.ts:13 importa uuidPattern y chainNode; observability.ts:15 importa las tres de policy), y de los seis módulos nuevos NINGUNO exporta un símbolo huérfano —lo comprobé nombre por nombre contra todo el monorepo, y contrasta con los 14 huérfanos que la ola 1 encontró en config.ts—. Además la superficie pública no se movió: repository.ts exporta los mismos 64 nombres, y f4673f4 se molestó en mantener el bloque `export { ... } from './observability/policy.js'` para que `deliveryLeaseCapMs` y `DeliveryLeaseCap` siguieran saliendo por donde salían.

Lo que señalo es la trampa que queda armada: ahora conviven dos patrones UUID exportados que sólo se distinguen por mayúsculas y aceptan versiones DISTINTAS. packages/store/src/repository/observability.ts:271 `export const UUID_PATTERN = /...[1-8].../` (versiones 1-8, el fencing de conexión, usado en outbox.ts:94) y packages/store/src/repository/agents/fanin.ts:20 `export const uuidPattern = /...[1-5].../` (versiones 1-5, correlación de cadenas). VERIFICADO que hoy no se cruzan: ningún fichero importa los dos, y los 11 usos de `uuidPattern` del baseline siguen siendo 11 (5 en fanin.ts, 6 en chain-control.ts). Cuando los dos eran privados del mismo fichero, confundirlos exigía escribirlo mal a la vista; ahora basta con aceptar la sugerencia de import equivocada.

### [menor] (store-resto) Ni un test tocado en toda la ola, y 39 de las 50 suites del store exigen Docker: el 'verde' que respalda estos commits no roza el store

`git log --oneline e3abcf6..HEAD -- packages/store/test/` está VACÍO. Los nueve commits tocan exactamente 2 ficheros cada uno (3 en f5467da), todos de src. Ninguna aserción nueva fija las fronteras de los seis módulos nuevos, ni el contrato de los 16 miembros abstractos, ni el orden de la cadena de 13 clases.

Y el verde citado tampoco lo cubre: de los 50 ficheros de packages/store/test, 39 llevan el sufijo `-postgres` y arrancan testcontainers (tests/helpers/postgres.ts:1-10, `GenericContainer`). Es decir, la cobertura de COMPORTAMIENTO del store —claim, ack, lease, fencing, replay, retención, cadenas— vive entera detrás de Docker y no se ejecutó en esta ola.

Además el sufijo `-postgres`, que es la convención de facto para saber qué necesita Docker, tiene dos fugas: packages/store/test/catalogo-no-se-filtra.test.ts:16 y packages/store/test/muestra-no-es-total.test.ts llaman a `startTestDatabase()` sin llevar el sufijo. Lo descubrí porque al correr «las suites sin Postgres» esas dos tardaron 24 s y 40 s levantando un contenedor. Corrieron en verde (62 tests, 12 ficheros, rc=0) y el contenedor desechable se destruyó solo; los cauce-v3-prod-* no se tocaron.

Lo único que sí verifiqué en verde de forma independiente son las dos señales que el propio informe de la ola 1 desaconseja usar como criterio de aceptación: `tsc --noEmit -p tsconfig.json` rc=0 y `eslint packages/store --max-warnings 0` rc=0 (eslint.config.js:5 no ignora el subdirectorio, así que sí lintea los ficheros nuevos; simplemente no tiene regla de indentación para TS).

### [menor] (store-resto) La ola perdió 18 líneas de comentario, todas del commit hermano e110f80 y ninguna de estos nueve: seis JSDoc que documentaban tipos del contrato de entregas

Conteo mecánico de líneas de comentario en packages/store/src/repository*: 1.482 en e3abcf6, 1.464 en HEAD. Localicé las 18 con `git log -S` y TODAS salen de e110f80 «store: extrae entregas y fencing», que no está en mi lote. Los nueve commits que reviso preservan los comentarios byte a byte —se ve en la comparación de líneas borradas contra añadidas: en los nueve, toda diferencia es import, re-export, declaración de clase o línea en blanco—.

Los JSDoc que ya no existen en ningún fichero del repositorio (comprobado con grep sobre packages, apps, services y tests):
- «Store claim record; event_id is the immutable ACK correlation id for this delivery.» (documentaba `ClaimedDeliveryEnvelope`, e3abcf6:repository.ts:188)
- «Resultado interno de materializar las salidas de un ACK.» (`AgentOutputOutcome`, :168)
- «Every reason a proactive egress can be refused. Refusals are durable rows, never exceptions.» (`NotifyDenialCode`, :314) — esa frase es la invariante de que un rechazo de egreso es una FILA, no una excepción
- «Cómo se probó que la garra que firma un ACK tardío existió de verdad sobre esta entrega.» (`LateClaimProvenance`, :146)
- «Columnas adicionales de deliveries proyectadas para rescate tardío.» (`LateResultRow`, :139)
- «A rejected directive still needs a bounded handle for its durable denial row.» (`boundedHandle`, :476)
- y el bloque «The store never trusts the adapter's own validation: an ACK arrives over HTTP/WS and can come from an old or adversarial adapter…», que era la justificación escrita de por qué el store revalida todo lo que firma el adaptador.

Lo reporto aquí porque responde a la pregunta de las lecciones: la de los comentarios (el [mayor] de consola en la ola 1) se respetó en nueve de los once commits de store de esta ola, pero no en todos.

### [menor] (store-resto) El criterio de aceptación del plan «confirmar con git log --follow que cada función movida es idéntica» no se cumple para la mitad de los módulos nuevos

plan-reestructura/13-carpinteria-backend.md:42 fija como gate: «Diff revisable: el revisor debe poder confirmar con `git log --follow` que cada función movida es idéntica». Medido en HEAD, número de commits que devuelve `git log --follow --oneline` por fichero:
- packages/store/src/repository/agents.ts -> 1
- packages/store/src/repository/agents/fanin.ts -> 1
- packages/store/src/repository/observability/policy.ts -> 1
- packages/store/src/repository/agents/notifications.ts -> 2
- packages/store/src/repository/agents/chain-control.ts -> 52 (git detectó la copia: `C051 packages/store/src/repository.ts -> .../chain-control.ts`)
- packages/store/src/repository/deliveries/control.ts -> 57

En tres de los seis, git no puede seguir la extracción hacia repository.ts porque la similitud del fichero nuevo contra el viejo no llega al umbral de detección de copia, así que la herramienta que el plan nombra como método de verificación devuelve el commit de creación y nada más. No es culpa de quien extrajo —es una limitación estructural del método de extracción parcial— pero significa que el gate escrito no es alcanzable y que auditar estos ficheros exige lo que hice yo: reconstruir el baseline y comparar cuerpos.

Un agravante de archivo: f5467da hace una mudanza de DOS SALTOS. `listOriginRelays` viajó repository.ts -> repository/agents/chain-control.ts (252a1ae) -> repository/outbox.ts (f5467da) en la misma tanda. El destino final es el correcto (listar relays de origen pertenece al outbox) y el cuerpo llegó byte-idéntico —comprobado—, pero quien haga arqueología sobre outbox.ts tiene que atravesar dos commits para llegar al original.

Lo que sí cumple el plan, y conviene dejarlo dicho: la regla de tamaño (13-carpinteria-backend.md:41, «ningún fichero de src > 1.500 líneas en las áreas tocadas») se respeta —el mayor es repository/deliveries.ts con 1.493, luego agents/fanin.ts 1.438, observability.ts 1.420, agents/chain-control.ts 1.335—, la regla de «un commit por módulo extraído y nada más en ese commit» se respeta en los nueve, y la de «sin comentarios narrativos nuevos» también: revisé la cabecera de los seis módulos nuevos y no hay ni un comentario que no viniera del original.

### [mayor] (gateway) 951fe67 dejó un test ROJO en la matriz oficial: perfil-en-el-saludo lee app.ts como TEXTO y la cadena que busca se fue a routes/core.ts

tests/gateway-hardening/perfil-en-el-saludo.test.ts:90-93 hace:

    const fuente = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../services/gateway/src/app.ts', import.meta.url), 'utf8'
    ));
    expect(fuente).toContain("hello.capabilities.includes('agent_profile_v1')");

Esa cadena vivía en el bloque de /v3/ws y 951fe67 la movió a services/gateway/src/routes/core.ts:868. app.ts hoy tiene 408 líneas y NO la contiene. LO EJECUTÉ: `npx vitest run tests/gateway-hardening/perfil-en-el-saludo.test.ts` → 'Test Files 1 failed (1) / Tests 1 failed | 5 passed (6)', con el diff mostrando el app.ts nuevo entero. Corrí también la suite completa menos el único fichero que abre Postgres: `npx vitest run tests/gateway-hardening --exclude '**/wake-outbox-postgres.test.ts'` → 'Test Files 1 failed | 15 passed (16) / Tests 1 failed | 114 passed (115)'. Es el ÚNICO rojo de la suite.

Por qué el verde no lo vio: scripts/test-all.mjs:11-19 declara la matriz ['test:unit','test:terminal-pty','test:services','test:gateway-hardening','test:store-hardening','test:integration','test:e2e']. `pnpm test:services` (que sí corrí: 471/471 verdes) sólo ejecuta `vitest run src` dentro de services/gateway (services/gateway/package.json), y typecheck/lint no leen ficheros como texto. O sea: `pnpm test` está ROJO en HEAD y el verde reportado no cubre esa suite.

El test es exactamente la clase de red que una mudanza mecánica rompe sin ruido: su propio comentario dice «Esta prueba es la única que puede verlo, porque el tipo de TS no cruza los dos ficheros». Hoy ya no puede verlo. Arreglo: apuntar la lectura a services/gateway/src/routes/core.ts.

Nota: es el único test de este tipo. `grep -rn 'services/gateway/src' tests/` no encuentra otra aserción sobre el texto de un fuente del gateway movido; ops/tests/source-digest-domains.test.mjs:148 nombra app.ts pero escribe su propio sandbox.

### [mayor] (gateway) /v3/console/publish-intents NO es legado: es la primera pata obligatoria del único envío de la consola, y apagar el flag deja POST /v3/console/messages montada pero condenada a 409 para siempre

71ba355 movió cinco rutas a routes/legado-candidato.ts tras `enableLegacyCandidateRoutes`, «para que la tala futura sea un git rm» (plan-reestructura/13-carpinteria-backend.md:25). Con chain-gates no discuto: no tienen llamador de consola. Con publish-intents el rótulo es falso y verificable:

CAMINO VIVO: apps/console/src/features/messages/ConversationPane.tsx:14,210 y apps/console/src/features/terminal/SessionStage.tsx:31 llaman `publishDurably` → apps/console/src/features/messages/durable-publish.ts:83 `api.preparePublishIntent(...)` → apps/console/src/api/client.ts:454 `POST /v3/console/publish-intents`; luego durable-publish.ts:130 `api.publishMessage` → client.ts:432 `POST /v3/console/messages`; luego durable-publish.ts:168 `api.confirmPublishIntent` → client.ts:479 `POST /v3/console/publish-intents/confirm`. No hay otra vía de envío en la consola.

LAS DOS PIEZAS QUEDARON EN LADOS DISTINTOS DEL FLAG. `POST /v3/console/messages` se registra en services/gateway/src/routes/console.ts:451 (fase 3, SIN flag). Su handler es el publishHandler de services/gateway/src/routes/core.ts:303-305, que hace `const consolePublish = request.routeOptions.url === '/v3/console/messages'` y core.ts:336 `requirePreparedConsoleIntent: consolePublish`. Y el store lo exige de verdad: packages/store/src/repository/messages.ts:884-889

    if (prepared === undefined
        || prepared.operator_scope_hash !== options.consoleIntentOperatorScope
        || prepared.semantic_hash !== semanticHash
        || prepared.conversation_hash !== conversationHash) {
      throw new StoreError(
        'conflict',
        'console publish key was not prepared for this authenticated request',
      );
    }

Con el flag en false no existe ninguna ruta capaz de crear esa fila, así que /v3/console/messages responde 409 en cada intento. Lo confirmé montando el gateway real y volcando `app.printRoutes()` con el flag a true y a false: con false desaparecen las cinco pero `/v3/console/messages (GET, HEAD, POST)` sigue en la tabla.

EL TEST NUEVO CERTIFICA JUSTO ESO COMO SI FUERA BUENO. services/gateway/src/routes/legado-candidato.test.ts:78-85 se titula «removes only the five candidate routes from their live neighbors when disabled» y comprueba `NEIGHBOR_ROUTES.every(hasRoute)` incluyendo `{ method: 'POST', url: '/v3/console/messages' }` (línea 22). Comprueba PRESENCIA de ruta, no que la vecina siga sirviendo. Pasa en verde mientras describe una configuración que rompe el compositor.

LA EVIDENCIA CITADA NO AGUANTA. plan-reestructura/12-cuarentena-legado.md:17 justifica el rótulo con «La migración 037 lo dice: "This state machine has never been deployed"; 0 audit_events console.publish.*». Ese texto (packages/store/migrations/037_console_publish_intent_indexes.sql) es un GATE DE MIGRACIÓN —«refuse to guess a head for experimental rows», con un DO $$ que aborta si ya hay filas console.publish.%— es decir, una condición para APLICAR el esquema, no una medición de uso posterior. services/gateway/README.md:15 repite hoy «0 uso medido en producción». No pude consultar la base viva (sólo lectura fuera del repo), pero el código de las dos puntas dice que si publish-intents tuviera 0 uso, la consola no habría podido enviar un solo mensaje.

Acción mínima: o las tres rutas del envío entran juntas al módulo con flag, o publish-intents sale del módulo. Tal como está, el `git rm` que el plan prepara mata el compositor de la consola.

### [menor] (gateway) El flag de activación no tiene cableado operativo: sólo es un campo de GatewayOptions que nadie fuera del test puede poner

`grep -rn 'enableLegacyCandidateRoutes\|LEGACY_CANDIDATE\|LEGADO_CANDIDATO'` sobre todo el repo (excluyendo node_modules y _legado) da exactamente cinco sitios: services/gateway/src/app.ts:296 (campo opcional de GatewayOptions), :343 (`const enableLegacyCandidateRoutes = options.enableLegacyCandidateRoutes !== false;`), :389 y :399 (los dos `if`), y services/gateway/src/routes/legado-candidato.test.ts:35,50 (el test).

services/gateway/src/main.ts NO lo lee: el `buildGateway({...})` de main.ts:209 no lo menciona, y no hay variable de entorno, ni entrada en services/gateway/src/config.ts, ni en deploy/, ni en ops/. Por defecto queda ON (`!== false`), que es lo correcto para no cambiar conducta, pero significa que en producción NO se puede apagar: nadie puede medir «apagado y no pasó nada» antes de la tala. El flag documenta una intención; no habilita el experimento que justificaría la intención.

Es el mismo hueco que el hallazgo anterior amplifica: si además de no poder apagarlo, apagarlo rompiera la consola, el flag es un botón sin cable encima de una trampa.

### [menor] (gateway) La partición del terminal movió texto pero no dependencias: 17 y 13 parámetros inyectados, una constante regex viajando como argumento, y el plano de control importando del proxy

services/gateway/src/terminal/session-control.ts:178 `TerminalSessionControlOptions` tiene 17 miembros, 11 de ellos FUNCIONES que antes eran locales del mismo fichero: `pool, config, registry, grants, repository, UUID_PATTERN, principal, openPredicate, currentCohort, cohortLabels, sessionExpiry, parseSessionRequest, parseOwnerRotation, parseDeleteSession, browserOwnerGeneration, replyError, recordTransactionalTerminalAudit`. services/gateway/src/terminal/relay-proxy.ts:114 `TerminalRelayProxyOptions` repite 13 (`... UUID_PATTERN, exactObjectKeys, boundedInteger, cohortLabels, sessionExpiry, replyError, recordTransactionalTerminalAudit`). Inyectar `UUID_PATTERN` —una RegExp constante, plugin.ts:56— como parámetro de runtime es la firma de un corta-pega: un `import` habría bastado.

Y la dependencia quedó al revés: services/gateway/src/terminal/plugin.ts:21-23 importa `CLAIM_UUID_PATTERN, registerTerminalRelayProxy, relayClaimEpoch` DESDE relay-proxy.ts, y los usa en validaciones que no tienen nada que ver con el relay: plugin.ts:130 (`canonicalUuidV4`), plugin.ts:178 (`parseOwnerRotation`) y plugin.ts:195 (`parseDeleteSession`). El plano de control ahora no compila sin el proxy. En el original ambos eran locales del mismo fichero (plugin-base.ts:238 y :250).

Subsidiario: `type FleetCohort = ReturnType<typeof containerCohort>` está declarado DOS veces, idéntico, en session-control.ts:176 y relay-proxy.ts:112, y no existía en el original — es el único nombre top-level duplicado entre los cuatro ficheros del terminal (comprobado con el AST: 62 nombres top-level, 1 duplicado; en routes/: 78 nombres, 0 duplicados).

No cambia la conducta —los 11 registros de ruta del terminal son byte-idénticos y en el mismo orden— pero el resultado no son tres módulos: son tres trozos de la misma función que sólo funcionan ensamblados por plugin.ts.

### [menor] (gateway) El contrato del repositorio quedó declarado cinco veces, y nada mantiene sincronizadas las copias

La partición creó cuatro interfaces nuevas que re-declaran a mano trozos de `GatewayRepository` (services/gateway/src/app.ts:79, 53 miembros): `ConsoleRouteRepository` (services/gateway/src/routes/console.ts:35, 29 miembros), `LegacyCandidateRepository` (services/gateway/src/routes/legado-candidato.ts:34, 5), `GatewayHealthRepository` (services/gateway/src/routes/health.ts:14, 3), más `TerminalSessionRepository`/`TerminalRelayRepository` en el terminal.

Las comparé miembro a miembro con el AST: HOY son subconjuntos FIELES. Ningún miembro sobra, ninguna opcionalidad cambió (`getAgentByIdentity?`, `authorizeAgentTarget?`, `recordProfileRuntimeExpectation?`, `readProfileRuntimeAdoption?`, `listChainGates?`, `answerChainGate?`, `cancelChainGate?`, `prepareConsolePublishIntent?`, `confirmConsolePublishIntent?` siguen opcionales en las dos puntas) y las 11 «diferencias de firma» que detecté son sólo comas finales y saltos de línea (p.ej. `assertPermission(tenantId: Tenant, alias: string, permission: ...)` vs la misma en tres líneas).

El defecto es que no hay `Pick<GatewayRepository, ...>` ni nada que las ate: si mañana alguien endurece `assertPermission` en app.ts:100, las copias de console.ts:36 y del terminal se quedan con el contrato viejo y `pnpm typecheck` sigue verde, porque cada módulo valida contra SU propia declaración y `buildGateway` pasa un objeto que satisface las dos. Lo mismo con `CoreRouteOptions` (core.ts:38) frente a `GatewayOptions` (app.ts:263). Es deuda barata de pagar ahora (`Pick<>`) y cara de descubrir después.

### [menor] (gateway) Punteros fichero:línea colgando tras el adelgazamiento de app.ts de 2.759 a 408 líneas, uno de ellos dentro del código

docs/directiva-ficheros-del-agente.md:145 dice «`services/gateway/src/app.ts:41` lo importa y `:1483` lo registra». app.ts:41 es hoy `import { createCoreRoutePhases } from './routes/core.js';` y `:1483` está FUERA DEL FICHERO (app.ts tiene 408 líneas). El registro real de `registerAgentDocumentRoutes` está en services/gateway/src/routes/console.ts:16 (import) y :707 (llamada).

docs/bitacora/queues-contadores-2026-07-26.md:21 dice «`services/gateway/src/app.ts:369` pasa ese objeto por `visibleQueue()`»; app.ts:369 es hoy la línea `outboxPollMs,` del bag de opciones, y `visibleQueue` se usa en services/gateway/src/routes/console.ts:473.

El que más molesta está en CÓDIGO, no en documentación: packages/store/src/configuration.ts:8 dice «El gateway lo traduce a 422 (`statusFor()` en services/gateway/src/app.ts)». `statusFor` vive hoy en services/gateway/src/routes/shared.ts:26 y sigue siendo el único sitio donde 'no_route' | 'invalid_actor' | 'invalid_input' se convierten en 422 (shared.ts:30).

Y una afirmación de arquitectura que la partición volvió falsa: docs/arquitectura.md:32 describe app.ts como «monta `routes/{health,console:1..4,core,legado-candidato}` + `terminal/plugin`». `buildGateway` NO monta el plugin de terminal — lo hace services/gateway/src/main.ts:229 (`await app.register(registerTerminalControlPlane, ...)`), y por eso el volcado de `printRoutes()` de buildGateway no contiene ni una ruta /v3/console/terminal/* ni /v3/terminal/relay/*.

### [menor] (gateway) Nueve helpers que eran privados de fichero pasaron a export público de módulo, y los cuatro módulos grandes nuevos no tienen ni un test propio

Superficie: services/gateway/src/routes/shared.ts exporta hoy siete cosas que en el app.ts original eran `function`/`const` a secas — `CONNECTION_TOKEN_PATTERN` (:16, antes app-baseline.ts:399), `replyError` (:34, antes :704), `principal` (:51, antes :721), `publicPublish` (:58, antes :725), `trustedPublishSemantics` (:112, antes :781), `consolePublishOperatorScope` (:142, antes :811), `validatedPublishReceipt` (:151, antes :529)—; el terminal añade `TerminalClockSkewError` (session-control.ts, antes plugin-base.ts:86) y `CLAIM_UUID_PATTERN`/`relayClaimEpoch` (relay-proxy.ts, antes plugin-base.ts:245,250). El daño está contenido y lo verifiqué: services/gateway/src/index.ts sigue haciendo `export *` sólo de app/auth/console-security/config/health/oidc-bff, así que la superficie del paquete NO cambió; `statusFor` (shared.ts:26) tuvo el buen criterio de quedarse privado.

Cobertura: `git diff --stat 8b90d00^..HEAD -- services/gateway/` toca 11 ficheros y el único test es el nuevo legado-candidato.test.ts (106 líneas, 4 casos). Ni un test existente fue editado —que es exactamente lo que el plan 13 exige— pero tampoco se añadió ninguna prueba de frontera para los cuatro módulos grandes: core.ts (1.448), console.ts (920), session-control.ts (902) y relay-proxy.ts (1.141) se siguen probando sólo de punta a punta a través de `buildGateway`/`registerTerminalControlPlane`. Las nuevas interfaces de opciones (17 y 13 miembros inyectados) no tienen quien vigile que alguien deje de pasar uno: el typecheck lo ve HOY, pero cualquier futuro `?` en esas firmas abre el hueco en silencio.

### [mayor] (terra-tests) a1425e5 cambia el PRODUCTO e invierte aserciones sin que hubiera un test rojo que lo forzara, y sin el reporte obligatorio

El commit `a1425e5 fix(console): corregir catálogo de campos inertes` NO es un arreglo de test rojo: borra dos entradas del catálogo de producto (`agents.container_name` y `agents.runtime_user` desaparecen de `apps/console/src/features/config/campos-inertes.ts`, que pasa de 5 a 3 columnas marcadas) y reescribe las aserciones en el MISMO commit para que casen. Inversión literal: `apps/console/src/features/config/campos-inertes.test.ts:26` pasa de «marca las cinco columnas de emplazamiento de agents» a «marca las tres... sin lector runtime», y :43-44 añade `expect(motivoInerte('agents','container_name')).toBeUndefined()` / `('runtime_user')` — o sea, los dos campos saltan de la lista «DEBE estar marcado» a la de control negativo. Igual en `apps/console/src/features/config/ConfigPage.inertes.test.tsx:77` (rótulo del it) y :104, donde «Contenedor» y «Usuario» pasan de la lista de cabeceras que deben llevar `MARCA_INERTE` a la de las que NO deben llevarla. Y `campos-inertes.test.ts:121` afloja `columnasInertesDe('agents',[...,'container_name'])` de `['harness_id','container_name']` a `['harness_id']`.

Esos tests estaban VERDES antes: el único commit anterior que tocó `campos-inertes.ts` es `2a22107`, y su diff sobre ese fichero sólo borra comentarios y suaviza la redacción de `state_directory` («NO LE ENCONTRÉ LECTOR» → «No tiene lector»); no toca ni una entrada del catálogo. Ningún rojo obligaba a esto.

La orden (docs/bitacora/ordenes-ejecutadas/ronda5/codex-terra.md, Tarea 1) decía: «PROHIBIDO debilitar aserciones o poner skip... Si un test revela un bug real de producto: NO toques el producto — repórtalo en `ordenes/reportes/codex-terra-bugs-reales.md` con archivo:línea y déjalo rojo». Ese fichero no existe en el repo (ni en `ordenes/reportes/` ni en ningún sitio), y el mensaje del commit es una sola línea sin una pizca de evidencia.

ATENUANTE, y es fuerte: el contenido del cambio es CORRECTO. `2a22107` reescribió `services/gateway/src/terminal/authority.ts:31-49` para que `loadFleetPlacements` lea `container_name` y `runtime_user` directamente de la tabla (`SELECT tenant_id,alias,container_name,runtime_user FROM agents WHERE enabled`, :35) en vez de la constante compilada `FLEET_PLACEMENTS` que citaba el motivo viejo. Esas dos columnas SÍ tienen hoy lector runtime y autorizan la sesión PTY: el catálogo mentía. El defecto no es el veredicto técnico, es el método — producto tocado en silencio, aserción invertida en el mismo commit, y el canal de reporte que la orden creó para exactamente este caso quedó vacío.

### [mayor] (terra-tests) El catálogo de inertes enseña al operador tres citas MUERTAS y la guarda de citas no puede verlo (verde garantizado)

`apps/console/src/features/config/campos-inertes.ts:23` y :33 citan `packages/store/src/repository.ts:5151`, y :40 cita `packages/store/src/repository.ts:5109`. Cuando Terra escribió esas líneas eran exactas — verificado: `git show a1425e5:packages/store/src/repository.ts` tiene 5787 líneas, :5109 es `async listAdapters(...)` y :5151 es la línea `a.enabled,a.container_name,a.runtime_user,...` del SELECT de `listAgents`. Hoy `packages/store/src/repository.ts` tiene **42 líneas** (fachada pura, tras la partición de store de esta ola). Las tres citas apuntan al vacío. Los lectores vivos están en `packages/store/src/repository/config.ts` (listAdapters) y `packages/store/src/repository/agents.ts:325` (el SELECT de listAgents).

Esto no es un comentario interno: el motivo se PINTA en la cara del operador. `apps/console/src/features/config/CollectionTable.tsx:94` toma `motivoInerte(key, columna.clave)` y lo cuelga de la cabecera de la columna (`data-inerte` + `CabeceraConAyuda`), y `ConfigPage.inertes.test.tsx:120` confirma que el texto viaja en el árbol accesible (`expect(cabecera).toHaveTextContent(/repository\.ts:5109/)`). Una pantalla cuyo encargo entero es «que no mienta sobre lo que hace» está citando pruebas inexistentes.

Y la guarda es ciega por construcción: `apps/console/src/features/config/campos-inertes.test.ts:73-79` («cada motivo cita al menos una ruta del repositorio con su línea») sólo valida la FORMA con `/[\w/-]+\.(ts|sql|md):\d+/` — nunca abre el fichero ni comprueba que la línea exista. Por eso 107/107 sigue en verde con tres citas falsas en pantalla. Peor: `ConfigPage.inertes.test.tsx:120` y `campos-inertes.test.ts:23` fijan el número 5109 por regex, así que el día que alguien corrija la cita a la ruta real, esos dos tests se ponen rojos por decir la verdad.

### [mayor] (terra-tests) 832888d parte DirectivaModal sin cambiar conducta, pero borra ~101 líneas de comentario con invariantes MEDIDAS que no viven en ningún otro sitio

La partición es limpia en comportamiento: comparación de multiconjunto de líneas (normalizando el prefijo `export`) entre `DirectivaModal.tsx` en 832888d^ y la unión de los 5 ficheros de hoy da 18 «líneas de código perdidas», y las 18 son andamiaje: reordenación de imports, el tipo de props inline convertido en `interface CapaCabeceraProps` (`apps/console/src/features/live/directiva-modal/CapaCabecera.tsx:3-12`) y la llamada `<NoSeMiro ... />` replegada de 4 líneas a 1 (`directiva-modal/ContenidoDeCapas.tsx:139`). Cero ramas, cero guardas, cero atributos JSX perdidos. Los cuerpos de `CapaDeFicheros`, `CapaDeMemoria`, `CapasPendientes`, `AvisosDeSolapamiento`, `CapaCabecera`, `SinMedir`, `NoSeMiro`, `LecturaFallida` y `MiroYNoHay` son byte-idénticos. `DirectivaModal.test.tsx` NO se tocó y pasa: la orden («Tests pasan sin editar salvo imports») se cumplió. Tamaños: 553 → 190 + 26 + 27 + 34 + 186 = 463.

El defecto son las ~101 líneas de comentario borradas en un commit que sólo anuncia «partir por capas». Lo que se fue no es épica: es evidencia medida que no está en ningún otro lugar del repo — por qué `inert` va sobre `.app-shell` y no sobre `body`; que `inert` NO frena la rueda y que la página de detrás conservaba **2.894 px de recorrido** medidos en Chrome; por qué la clase va en `documentElement` (dueño del scroll, si no el `scrollbar-gutter` no tiene a quién aplicarse); por qué va por CSS y no por `style` en línea (la CSP de producción es `style-src 'self'` y funcionaría en dev y no en prod); por qué Escape se atiende en CAPTURA sobre `document` (si no, una sola pulsación cerraba el diálogo Y el cajón); por qué `onMouseDown` y no `onClick` (soltar el ratón sobre el velo tras seleccionar texto dentro cerraba y perdía el borrador); y por qué el foco vuelve por ref DESPUÉS de levantar `inert`.

Matiz honesto: el protocolo («Reglas de todo commit» #3, ordenes/00-PROTOCOLO.md) prohíbe «comentarios narrativos, fechas o incidentes en el código», así que borrarlos es defendible por sí solo. Lo que no lo es: hacerlo dentro del commit de partición, que es exactamente el defecto que la revisión de la primera ola ya había levantado (`ordenes/reportes/claude-revision-46-commits.md:36`: «el más serio es la eliminación de 190 comentarios... en commits que dicen literalmente “preservando invariantes y comportamiento”: el comportamiento sí, las invariantes ESCRITAS no»). La lección se registró y se repitió.

### [mayor] (terra-tests) Tarea 3 (barrido de exports muertos) no se ejecutó, y la ola AÑADIÓ 18 exports huérfanos

Ningún commit de `apps/console` en la ola borra un solo export muerto. Barrido mecánico sobre `apps/console/src` (cada símbolo `export function|const|class|interface|type` buscado por palabra en todos los demás ficheros, tests incluidos como consumidores): **142 exports sin ningún consumidor fuera de su propio fichero**.

De esos 142, 18 los creó Terra en esta tanda, todos privados antes:
- `apps/console/src/features/terminal/pty-types.ts` — 12: `MAX_RESPUESTA_TECNICA`, `DA_PRIMARIA`, `DA_SECUNDARIA`, `DSR_ESTADO`, `MAX_FILAS_REMOTAS`, `MAX_COLUMNAS_REMOTAS`, `MAX_CLAIM_LEASE_MS`, `MAX_POSTGRES_BIGINT`, `UUID_CANONICO`, `decimalPositivo`, `longitudRespuestaDeCursor`, `claimEpochCanonico`.
- `apps/console/src/features/terminal/pty-connection.ts` — 5: `startViewerHeartbeat` (:30), `finishChannel` (:39), `rejectMalformedReady` (:59), `handleControlFrame` (:69), `scheduleReconnect` (:125).
- `apps/console/src/features/live/directiva-modal/ContenidoDeCapas.tsx:7` — `export type RecursoDirectiva`.

En `1ca3312^` todos eran `const`/`function`/`interface` a secas dentro de `pty-session.ts`. En total esa partición promovió 40 símbolos privados a `export`. La revisión de la primera ola sólo llegó a fichar uno (`claude-revision-46-commits.md:175-177`, `PtyEntry`); los otros 17 nunca se reportaron. La orden de Terra decía literalmente lo contrario de lo que ocurrió: «Tarea 3 — Barrido de exports muertos en apps/console/src: símbolos exportados que nadie importa... bórralos con la evidencia en el mensaje de commit», y «Tarea 2 ... imports/exports con paridad». Ni barrido, ni paridad, ni un reporte de cierre en `ordenes/reportes/`.

### [menor] (terra-tests) El conteo de partida era caduco: eran 9 tests rojos en 3 ficheros, no 13 en 6 — y los 9 se arreglaron SÓLO por harness, verificado por mutación

Medido, no supuesto: copié el árbol en `c63ccaa^` (= c3b7fc9) a un sandbox aislado con `git archive` (sin tocar el repo) y corrí la suite entera: `Test Files 5 failed | 102 passed (107)`, `Tests 9 failed | 1277 passed (1286)`. Dos de esos 5 ficheros (`features/live/perfil.test.ts` y `features/terminal/denegaciones.test.tsx`) fallan sólo en mi copia porque no archivé `services/gateway` ni `@cauce/protocol` — no eran rojos reales. O sea: 9 rojos en 3 ficheros, los 3 que toca `c63ccaa`. El «13 rojos en 6 ficheros» de la orden era una medición anterior a que las propias particiones de Gemini (0b5b54f, 91bb5d7) repararan sus tests.

Los 9, uno a uno, y los 3 arreglos son de ENTORNO/HARNESS, legítimos y sin pérdida:

1) `apps/console/src/styles.tipografia-montada.test.tsx` — 7 rojos. Causa: 0b5b54f dejó `styles.css` en 4 líneas de `@import`, así que `TOKENS` salía VACÍO. Arreglo: `resolverCss` (:37-44) que inlinea los `@import`. Paridad exacta comprobada: el `styles.css` monolítico de 0b5b54f^ declara 37 tokens en `:root`; el resolver devuelve los MISMOS 37 con los mismos valores (0 diferencias, 0 nuevos); sin resolver, 0. Aserciones intactas. Prueba de mutación: bajé `--tipo-cuerpo` de 14px a 9px en `styles/base.css` → 5 tests vuelven a rojo listando 87 textos en /live, 69 en /accounts, 29 en /queues, 9 en /observability y 129 en /config por debajo del suelo de 12,5 px. El test conserva sus dientes.

2) `apps/console/src/features/messages/messages-css.test.ts` — 1 rojo. Misma causa; mismo `resolverCss` (:35-43). Paridad exacta: el monolito definía 243 clases, el resolver devuelve las MISMAS 243 (0 perdidas, 0 nuevas). El rojo eran 6 clases huérfanas reales (`terminal-composer`, `composer-blocked`, `notice` de ConversationPane.tsx; `timeline`, `timeline-node` de MessageTimeline.tsx; `trust-callout` de MessagesPage.tsx). Prueba de mutación: metí un `className="clase-que-no-existe-xyz"` en MessagesPage.tsx → rojo otra vez.

3) `apps/console/src/features/terminal/cuerpo-del-mensaje.test.ts` — 1 rojo. Causa: c3b7fc9 sacó `listMessages` de `repository.ts` a `repository/messages.ts`. Arreglo: try/catch que apunta primero a la ruta nueva (:17-25). Ninguna aserción relajada — sólo se reescribió el mensaje del `expect`. Prueba de mutación: cambié `left(COALESCE(...),240)` por `500` en `packages/store/src/repository/messages.ts` → «expected 500 to be 240».

En `c63ccaa` no hay ni un `skip`, ni un `.only`, ni un mock ampliado, ni una aserción borrada, ni un fichero de producto tocado. Es el commit limpio de la tanda.

### [menor] (terra-tests) Deuda menor que el verde tapa: fallback muerto, resolverCss copiado 12 veces, y lectura frágil del primer :root

(a) `apps/console/src/features/terminal/cuerpo-del-mensaje.test.ts:21-24`: el `catch` que relee `packages/store/src/repository.ts` es hoy código muerto (la ruta nueva existe) y oscurece qué fichero se leyó de verdad. No permite un verde silencioso —si faltan las dos rutas el `readFileSync` del catch revienta, y si `messages.ts` existe sin el SQL el `recorte` sale null y falla ruidosamente—, pero el día que se renombre `repository/messages.ts` el test leerá una fachada de 42 líneas y el mensaje de error apuntará al fichero equivocado.

(b) El helper `resolverCss` va ya por 12 copias literales en ficheros de prueba: `styles.tipografia-montada.test.tsx:37` (la que añadió c63ccaa) sobre las 11 que la revisión de la primera ola ya contó (`claude-revision-46-commits.md:171-173`). Sin memoización y sin detección de ciclos, y el regex corre ANTES del borrado de comentarios, así que un `@import` citado dentro de un comentario CSS se intentaría abrir como fichero.

(c) `styles.tipografia-montada.test.tsx:49` toma el PRIMER `:root` del texto ya inlineado (`css.search(/(^|})\s*:root\s*\{/)`). Hoy acierta porque el único `:root` está en `apps/console/src/styles/base.css:5` y `base.css` es el primer `@import` de `styles.css`. El día que un parcial importado antes declare su propio `:root`, el test leerá otra escala sin decir nada: los 37 tokens se sustituirían en silencio.

### [menor] (terra-tests) 00d3391 duplica el helper `aliasDe` en dos ficheros y extrae un componente que ninguna prueba cubre

La extracción de `FlowArrow` es byte-limpia en conducta (el JSX y la función `curva` viajan idénticos, sólo se repliegan dos expresiones a una línea y las props inline pasan a `interface FlowArrowProps`). Pero `aliasDe` no se movió: se DUPLICÓ. Existe ahora en `apps/console/src/features/live/live-hypergraph/FlowArrow.tsx:36` y, recreada verbatim en el mismo commit, en `apps/console/src/features/live/LiveHypergraph.tsx:126` (que la sigue usando en :363). Dos copias idénticas de la misma función de 4 líneas, listas para divergir; la salida natural era un módulo compartido o importarla del sitio donde quedó.

Además la extracción entró sin red: `grep -rln "LiveHypergraph\|FlowArrow"` sobre `apps/console/src/**/*.test.ts(x)` no devuelve NADA. `LiveHypergraph.tsx` (539 líneas, el mapa de la flota) no tiene una sola prueba, así que aquí el 107/107 verde no dice absolutamente nada sobre si el hipergrafo sigue pintando lo mismo. Contraste con `DirectivaModal.test.tsx`, que sí existe y es lo que respalda la partición de 832888d.

### [critica] (release-quarantine) docs/bitacora/deploy.md y docs/bitacora/rollback.md son runbooks de producción íntegramente obsoletos, y no están en el índice de deuda conocida

Ambos runbooks se presentan como procedimiento vigente ('# Runbook: deploy Cauce V3 aislado') y cada paso invoca la maquinaria de release retirada: `make -C ops release-build` (deploy.md:6), `make -C ops release-gate` (deploy.md:20), `make -C ops release-bootstrap-legacy/-manifest-sha/-production-legacy` (deploy.md:82,160,182), `make -C ops release-capture-writer-snapshot`/`release-bootstrap-writer-snapshot`/`release-rotate-writer-snapshot` (deploy.md:236,243,408; rollback.md:266), `make -C ops release-deploy-preflight`/`release-deploy` (deploy.md:269,319,379), `make -C ops prod-up`/`prod-down`/`migrate` (deploy.md:376-377; rollback.md:61), `rollback-baseline.py create` (deploy.md:207) y el flujo completo de `rollback.sh`/`pin-production-release.py` (rollback.md:1-11,61,232,266). Verifiqué contra `ops/Makefile` (contenido íntegro leído) que NINGUNO de esos targets existe: la lista real de targets vivos es help/test*/smoke-*/validate/manifest*/dev-*/prod-health/backup — confirmado además con `make -n <target>` sobre los 23 targets reales, todos limpios, y ninguno se llama release-* ni prod-up/prod-down/migrate/restore. Esos targets fueron retirados por el commit 669bad5 ('legado(release): retira targets y runners huerfanos'), que SÍ está dentro del rango auditado (e3abcf6..HEAD) — es decir, la cuarentena de esta misma ola dejó estos dos runbooks apuntando al vacío. A diferencia de `ops/INSTALLATION.md` y `ops/runbooks/systemd.md`, que SÍ figuran en la tabla 'Referencias vivas rotas a sabiendas' de `docs/bitacora/legado-indice.md` (antes `_legado/README.md`) con una nota explícita de que se reescriben en FASE 3, deploy.md y rollback.md NO aparecen en esa tabla en absoluto — el propio inventario de deuda conocida es incompleto. Un operador que siga deploy.md hoy para desplegar a producción fallaría en el segundo paso real.

### [mayor] (release-quarantine) El grep de item (1) no da 'solo docs/planes': ops/README.md, ops/INSTALLATION.md, dos runbooks de ops/ y ops/scripts/validate.sh referencian la maquinaria retirada fuera de _legado y de docs de plan

`git grep` de deploy-release|release-candidate|pin-production|release-gate|verification-rounds|release-writer fuera de docs/, ordenes/ y plan-reestructura/ (equivalente vivo de '_legado/' tras el commit 73e533c, que borró _legado/ del árbol de trabajo — su contenido solo sobrevive en git history) da 6 archivos, no 0: `apps/console/src/features/live/directiva.test.ts:36` (fixture de test, ver hallazgo menor aparte), `ops/README.md:65,71,79,86,92,107,113` (`pnpm evidence:release-candidate`, `pnpm verify:three-rounds`, `make release-gate`, `make release-build` — ninguno existe en package.json ni en ops/Makefile, verificado), `ops/INSTALLATION.md:29` y `ops/runbooks/systemd.md:6` (reconocidos en el índice de deuda), `ops/runbooks/e2e-integration.md:31` (reconocido inline como roto), y `ops/scripts/validate.sh:156` (ver hallazgo de release_state). De estos, `ops/README.md` es el más grave: es la puerta de entrada operativa de `ops/` y describe como vigentes exactamente los mismos comandos que `_legado/README.md`/`docs/bitacora/legado-indice.md` documentan como retirados, sin ninguna nota ni estar listado en la tabla de refs rotas conocidas.

### [mayor] (release-quarantine) La suite QA 'authentic' (compose.authentic.yaml + smoke-runtime-authentic.sh + smoke-compose-authentic.sh) exige y ejecuta relay-worker/shadow-router dentro de la misma imagen runtime que el Dockerfile ya no construye; la aserción estática de validate.sh oculta la rotura en vez de detectarla

`ops/compose.authentic.yaml:197,246` define servicios `relay-worker`/`shadow-router` con `<<: *final-runtime` (línea 3: `image: ${CAUCE_AUTHENTIC_RUNTIME_IMAGE}`) y `command: ["node", "services/relay-worker/dist/main.js"]` / `.../shadow-router/dist/main.js` (líneas 199,248). `ops/scripts/smoke-compose-authentic.sh:26` construye esa misma imagen con `docker build --target runtime -f deploy/Dockerfile`, y `deploy/Dockerfile` (leído completo) ya NO copia ni compila esos dos servicios: el `RUN pnpm --filter` de la etapa build (líneas 48-54) no los incluye, y los `COPY --from=build .../dist` de la etapa final (líneas 82-85) tampoco. Por tanto `node services/relay-worker/dist/main.js` fallará por módulo inexistente en cualquier ejecución real de `make test-compose-authentic` (`smoke-compose-authentic.sh:82` exige exactamente `services=(gateway dispatcher relay-worker telegram-bridge shadow-router)`) o `make test-runtime-authentic` (`smoke-runtime-authentic.sh:180-198`, mismo patrón). `ops/scripts/validate.sh:111-112` impone una aserción de texto que EXIGE que `compose.authentic.yaml` declare esos 5 servicios y 6 instancias de `final-runtime` — un chequeo puramente léxico que pasa aunque el binario no exista, así que 'validate.sh en verde' no certifica esta clase de QA. Esto ya está parcialmente reconocido en `ops/runbooks/e2e-integration.md:36-37` ('la clase test-compose-authentic queda rota hasta plan-reestructura/31'), pero la entrada paralela en `docs/bitacora/legado-indice.md` que describe `smoke-runtime-authentic.sh` como mera 'cadena literal... sigue funcionando' es inexacta para este caso: no es un nombre de servicio en un string, es una invocación de comando real que revienta.

### [menor] (release-quarantine) El secreto release_state de producción sigue siendo fail-closed sin generador vivo en el árbol (ya trackeado, sigue sin resolver)

`deploy/compose.yaml:562` exige `${CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE:?set the selected writer snapshot}.state.json` como secreto `release_state`, montado en el servicio `outbox-metrics` (líneas 376,389-390). `deploy/outbox-metrics.mjs:28` lo lee con `required('CAUCE_RELEASE_STATE_FILE')`, fail-closed: sin el fichero, el servicio no arranca. `ops/scripts/validate.sh:126-167` fabrica a mano un fixture con exactamente la forma del schema retirado `release-writer-snapshot.schema.json` (`"kind": "cauce-v3-release-writer-snapshot"`, línea 156) solo para que `docker compose config` resuelva; no hay ningún generador vivo de ese fichero para producción real, porque `release-writer-state.py`/`pin-production-release.py`/`capture-release-writer-snapshot.sh` están retirados. Esto ya figura como pendiente explícito en `plan-reestructura/fase3/compose-canonico.md` punto 9 ('hoy es un `:?` fail-closed atado a la maquinaria de release retirada... o decidir conservar el snapshot-writer'), así que no es un hallazgo nuevo, pero sigue sin resolver al HEAD auditado y es la explicación de por qué 'release-writer' aparece en validate.sh en el grep del punto (1).

### [menor] (release-quarantine) directiva.test.ts usa como texto de control negativo una ruta a un script retirado (cosmético, no rompe el test)

`apps/console/src/features/live/directiva.test.ts:36` usa la frase fija 'Producción migra dentro de `ops/scripts/deploy-release.sh deploy`' como fixture de un CONTROL NEGATIVO (verifica que el detector de avisos de autonomía NO marque texto de manual de despliegue). El test pasa igual porque no depende de que ese script exista; es solo el único hit de 'deploy-release' en código de aplicación fuera de _legado/docs/planes, y describe un flujo de despliegue que ya no es cierto. Vale una limpieza cosmética la próxima vez que se toque ese archivo, sin urgencia.

### [mayor] (minimax-terra-moves) Los 4 commits del encargo (1470d19/be8dd2e/4b73424/f3e5fac) no son de MiniMax, sino de la cuarentena de release de Codex

Los 7 commits reales de ordenes/ronda6/opencode-minimax.md son a959c46, 90f690c, c9d87f3, 0f77d25, 315a84c, 7a0f0d3, 36469ce (todos con '(ronda 6)' en el mensaje, todos anteriores a e3abcf6). 1470d19+9e98a80 mueven los 5+1 schemas de la 'maquinaria de release' que la Tarea 1 de la orden de MiniMax prohíbe explícitamente tocar ('se los lleva Codex con la maquinaria, su ronda 3'); be8dd2e ajusta ops/tests/container-ops-evidence.test.mjs al flag --rootless (cluster ajeno 4826433/e24cea7/e6d9c8b); 4b73424+f3e5fac retiran shadow-router/relay-worker de stack-health.sh y runtime-package-smoke.mjs, servicios ya archivados desde la purga original (_legado/README.md sección 1, origen 'purga 27-08'). git log -- _legado/README.md en la ventana ronda6 confirma que solo 1470d19 y 9e98a80 la tocan.

### [mayor] (minimax-terra-moves) ops/harness/healthcheck.mjs quedó huérfano sin mover: la Tarea 2.1 nombró la ruta equivocada

La orden dice mover 'ops/scripts/healthcheck.mjs (solo aparecía en ese Dockerfile huérfano)'. Pero _legado/contingentes/Dockerfile.harness-origen:3 (COPY mock-server.mjs runner.mjs healthcheck.mjs ./) referencia por ruta relativa a ops/harness/healthcheck.mjs, un fichero DISTINTO con el mismo basename que ops/scripts/healthcheck.mjs (este sí vivo vía ops/scripts/stack-health.sh:67, ops/Makefile:69,75 y ops/systemd/cauce-v3-health@.service). MiniMax verificó bien la ruta que la orden nombró literalmente (vivo, correctamente no movido, documentado en censo:21) pero nunca comprobó si existía otro fichero con ese basename en otra carpeta. `git grep -n 'healthcheck\.mjs' -- . | grep -v _legado` da 0 resultados para ops/harness/healthcheck.mjs: es un huérfano real de 480 bytes que sigue en el árbol vivo.

### [mayor] (minimax-terra-moves) _legado/README.md nunca fue actualizado por MiniMax: 13 ficheros movidos en ronda 6 no aparecen en su propio índice

git log -- _legado/README.md en la ventana ronda6 muestra solo 1470d19 y 9e98a80 (ambos Codex) tocando el fichero; MiniMax no lo editó ni una vez en sus 5 tareas. En _legado/README.md a 2db0e9b, la fila 'contingentes/ops/schemas/ (1)' solo lista rollback-bridge.schema.json (ronda 4) — faltan los 6 schemas de la Tarea 1 (dlq-no-replay-resolution, dlq-reconciliation, fleet-snapshot, gate-snapshot, physical-fleet-snapshot, telegram-manual-replay); la fila 'contingentes/ops/scripts/ (3)' solo lista los 3 de ronda 4 — faltan los 4 de la Tarea 2.3 (aplicar-separacion-config.sh, censo-config-por-alias.py, diff-consola-visible.py, preflight.sh); no hay ninguna entrada para Dockerfile.harness-origen/dockerignore.harness-origen (Tarea 2.1). El encabezado de la sección 5 sigue diciendo '52 ficheros del censo 2026-08-27' sin sumar estos 10.

### [menor] (minimax-terra-moves) plan-reestructura/censo-contingentes.md:3 quedó desincronizado con la reescritura de la Tarea 4

La línea 3 sigue diciendo '**45 dudosos** (tabla abajo, decide el dueño)', pero 7a0f0d3 reemplazó la tabla de 41 filas por una lista agrupada (a)-(f) con muchos menos ítems totales y que ya no es una tabla. Nadie actualizó el resumen ejecutivo de la línea 3 al reescribir la sección.

### [menor] (minimax-terra-moves) Referencias colgantes nuevas a rutas movidas por MiniMax, en documentación y comentarios operativos vivos

ops/runbooks/alias-cutover.md:7 ('schemas/gate-snapshot.schema.json') y :22 ('ops/scripts/preflight.sh jarvis /ruta/snapshot-preflight.json') — el runbook está marcado 'solo como referencia de rollback' pero un operador que lo siga literalmente hoy encuentra ENOENT en ambas rutas. ops/scripts/container-adapter-supervisor.sh:896 — comentario que documenta cómo activar CONFIG_POR_ALIAS (función 'apagada por defecto' pero 'activa en código' según censo:126) sigue diciendo 'copiar los ficheros ANTES (ops/scripts/aplicar-separacion-config.sh)', script que ahora vive en _legado/contingentes/ops/scripts/. ops/scripts/separar-config-alias.mjs:41 tiene el mismo tipo de referencia menor. Ninguna de las tres rompe typecheck/lint/tests porque son comentarios y runbooks, no código ejecutado.

