# Revisión adversarial (Opus) — contextos nativos por harness (ronda de codex-1)

**Veredicto: RECHAZADO** — el código queda en main con el flag OFF (default preservado); NO se activa en la ventana.

## Hallazgos
### [bloqueante] Los topes de OpenClaw están cableados al runtime MÁS PERMISIVO de la flota y no se leen del alias. `TOPES_OPENCLAW = {porFichero: 60_000, total: 150_000}` es correcto SOLO para el contenedor `claw` (jarvis). Medido hoy: `agv2-miguel-finca-oc` (gaia — el PRIMER canario de la lista del reporte) no declara `bootstrapMaxChars` en su `openclaw.json`, así que usa los defaults de OpenClaw 2026.6.6 instalados: 20.000 por fichero / 60.000 agregados; `claw-iza` y `claw-miguel` declaran 24.000/90.000. Además el agregado que valida Cauce EXCLUYE `MEMORY.md` y `HEARTBEAT.md` (`comprobarTopes` salta `solo-si-falta`), que OpenClaw SÍ cuenta: en `claw-miguel` son 18.181 B de 90.000 que Cauce no ve. Consecuencia con el flag ON: Cauce deja pasar una proyección que OpenClaw TRUNCA en silencio; los bloques A y B se anexan al FINAL del fichero (`conBloqueEntreMarcas` hace `base + "\n\n" + nuevo`), o sea que la truncación se come exactamente el contrato. Y la adopción se acredita por el SHA del fichero EN DISCO, no por lo que el arnés cargó: Cauce declararía `applied_revision` mientras el agente corre sin contrato y sin error — el fallo que el propio código dice venir a evitar. Números concretos: el bloque A mide 7.765 B; el AGENTS.md de gaia mide 8.109 B → 15.874 B + B autorado contra un tope real de 20.000.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/protocol/src/ficheros-del-arnes.ts:141,396-411 y /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/context/native-profile-context.ts:226-248
- **Arreglo:** Antes de activar: (1) leer los topes reales por alias (`agents.defaults.bootstrapMaxChars`/`bootstrapTotalMaxChars`, con default 20.000/60.000 cuando faltan) y propagarlos como hecho medido hasta el preflight, en vez de la constante; (2) contar MEMORY.md y HEARTBEAT.md en el agregado, porque OpenClaw los cuenta; (3) fallar cerrado si el runtime no publica sus topes. Mientras eso no exista, ningún alias OpenClaw es canario válido salvo `claw`/jarvis, y solo tras verificar a mano fichero por fichero.

### [bloqueante] Precipicio de expectativa vencida: con el flag ON, la PRIMERA entrega converge el bloque A y cambia el SHA del fichero canónico; a partir de ahí `assertContract` compara el SHA observado contra el SHA del contrato de la entrega y lanza, de modo que TODAS las entregas siguientes fallan con `NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED` hasta que un operador haga otro PUT que renueve la expectativa. El error es `retryable: true`, así que las entregas queman intentos y terminan en dead-letter. El alias no queda degradado: queda MUERTO. La secuencia de ventana del reporte (pasos 7-8) presenta ese segundo PUT como un refinamiento condicional («solo cuando A cambió»), cuando por construcción A SIEMPRE se crea en la primera entrega —el PUT del paso 5 corre con el flag apagado y por eso su expectativa nunca contiene A—. La prueba 281 no lo detecta porque su helper `contract()` relee el fichero DESPUÉS de la primera ejecución y fabrica un contrato ya refrescado.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/context/native-profile-context.ts:99-141,331-359 (cliff) y /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/test/native-profile-context.test.ts:78-88,293-312 (el helper que lo enmascara)
- **Arreglo:** O bien converger A ANTES del CAS, dentro del mismo lote del publicador durable (que A no dependa de la revisión lo permite: `textoNativoDelSobre` ya descarta `self_role` y `room_id`), o bien excluir el fichero de instrucciones del contrato hasta que A esté sellado. Además: añadir una prueba de tres entregas consecutivas con la MISMA expectativa, y degradar el fallo a «volver al prompt legacy» en vez de matar la entrega.

### [importante] La tabla del diagnóstico (§1) publica cuatro filas por arnés, y la fila «Hermes» es en realidad una entrega OpenClaw mal etiquetada. En producción NO existe ningún agente hermes: la tabla `agents` tiene 14 filas — 1 claude (zeus), 5 codex, 8 openclaw — y `argos` es `openclaw` tanto en la BD como en `docs/flota-y-participantes.md` («director general de desarrollo — **OpenClaw**»). La muestra `80cdc4a39f4a` que el reporte atribuye a Hermes resuelve a `Steven/argos`, openclaw. Se contradice además con §4, que dice «Argos y Tales no tuvieron una entrega reciente equivalente que permitiera publicar otra cifra real sin inventarla» mientras §1 usa justamente esa entrega de argos. El reporte viola aquí su propia prohibición («No confiar en el arnés declarado de inventario cuando los hechos medidos difieren»).
- **Dónde:** /datos/workspaces/zeus/cauce-v3/ordenes/reportes/codex-contextos-nativos.md:68-73 (tabla) y :415-418 (la contradicción)
- **Arreglo:** Retirar la fila Hermes o reetiquetarla como openclaw/argos, y decir explícitamente que Hermes no tiene medición porque no hay ningún alias hermes en producción. Las otras tres filas sí reproducen (ver evidencia).

### [importante] El gate está EN ROJO en `main` hoy: `pnpm --filter @cauce/adapter-sdk run test` cierra 689 tests con 684 pass / 5 fail y exit 1. Los cinco fallos son de sesión compartida/tmux (aserciones que todavía esperan el texto en castellano que `762f55fe` tradujo a inglés), NO de esta ronda — pero el paso 4 de la lista de ventana («desplegar el código con el flag ausente en todos los alias») no puede ejecutarse bajo la regla 2 del protocolo con el gate rojo. El reporte afirma «Adapter 689/689» y «el gate global se ejecutó antes de cada commit»; eso era cierto en `c09c67c`, no lo es en HEAD.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/test/shared-session-budget-and-finalize.test.ts y los casos de rename post-paste (tests 493, 494, 499, 590, 592)
- **Arreglo:** Arreglar las cinco aserciones de texto antes de la ventana. No es zona de esta ronda; hay que asignarlo al sector que hizo la traducción.

### [importante] El lado Claude del flag no tiene ningún alias elegible en producción. Hay exactamente UN agente claude (`Steven/zeus`, contenedor `ws-zeus`) y el propio reporte lo declara sobre una TUI Claude longeva; `NativeProfileContext` rechaza `sharedSession` en el constructor. Es decir: de los 14 alias, los 5 codex están fuera por diseño, zeus está fuera por transporte, iza y janus están fuera por workspace compartido — el flag solo puede tocar 6 alias OpenClaw, y sobre esos pesa el hallazgo bloqueante de topes. El «ahorro medido» de §4 se publica para 7 alias, de los cuales 3 (zeus, iza, janus) no son activables.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/context/native-profile-context.ts:71-76 y la tabla /datos/workspaces/zeus/cauce-v3/ordenes/reportes/codex-contextos-nativos.md:405-413
- **Arreglo:** Decir en el reporte que el soporte Claude nace sin usuarios y que el ahorro real de la ventana es solo el de los canarios OpenClaw elegibles, o pasar zeus a headless (sin `CAUCE_SHARED_SESSION`) antes de contarlo.

### [menor] «Byte a byte igual que antes» es cierto para el stdin de la entrega, pero NO para el comportamiento del proceso. `6ea006ee` borró `queueTimer.unref()` y movió el commit del intent de ejecución del engine al `beforeHarnessInvoke` del adaptador. Ambos cambios afectan a TODAS las entregas, también con el flag ausente: el proceso adaptador ya no puede salir mientras una entrega espera su turno de sesión (hasta 6 h) y el intent durable ahora se confirma después de resolver sesión, adjuntos y credenciales, no antes de `harness.execute`.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/sdk/engine.ts:428-449,543-551 y /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/harnesses/shared/adapter.ts:353-357
- **Arreglo:** Ninguno obligatorio —el `clearTimeout` sigue en el `finally` y el orden nuevo del intent es más ajustado, no menos—, pero el reporte debe decirlo: el default-off preserva los BYTES de la entrega, no el flujo de control.

### [menor] Las cifras del diagnóstico no reproducen exactamente. Reproduje el método sobre las MISMAS cuatro muestras y obtuve un delta sistemático de +107 B en las cuatro: 8.644 / 8.627 / 8.649 / 8.678 B frente a los 8.537 / 8.520 / 8.542 / 8.571 publicados. El método sí es real (la muestra anonimizada es `left(md5(delivery_id),12)` y la de Claude coincide al carácter con la BD de prod), y la magnitud —~8,5 kB, ~2,1K tokens estimados— se sostiene; pero la cifra publicada no se puede regenerar desde el árbol tal como está.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/ordenes/reportes/codex-contextos-nativos.md:60-73 frente a /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/harnesses/shared/prompt.ts:158-160,209-211
- **Arreglo:** Publicar el script exacto (qué `self_role` se usó y de qué columna salió) o recalcular; un ±1,2% no cambia la decisión, pero una cifra que no se puede rehacer no es evidencia.

### [menor] El adaptador ES un segundo escritor del fichero canónico —converge el bloque A con `escribirEnDiscoRealSiCoincide` sobre el mismo `CLAUDE.md`/`AGENTS.md` que publica el PUT—, justo lo que el propio diseño prohíbe («agregar un tercer escritor produciría carreras»). El fencing aguanta: cualquier escritura del gateway entre la lectura y la escritura del adaptador rompe la precondición `contenidoPrevio` y la entrega falla cerrada. Pero la comparación no es un CAS atómico del kernel (hay ventana entre el segundo `leerContenido` y el `ftruncate`), así que la garantía es procedimental —alias en reposo—, no técnica.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/context/native-profile-context.ts:105-110 y /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/src/context/siembra-del-perfil.ts:323-342
- **Arreglo:** Si A se convierte en parte del lote del publicador (arreglo del hallazgo bloqueante 2), este hallazgo desaparece solo. Si no, dejar escrito en el runbook que la quietud del alias es un requisito de CORRECCIÓN, no una precaución.

### [menor] La prueba «absent and zero native flags preserve the legacy prompt byte for byte» compara tres ejecuciones del MISMO build entre sí, no contra un golden anterior: si mañana alguien edita `bloquesFijos`, las tres cambian igual y la prueba sigue verde. Prueba que añadir `native_profile_contract` al contexto no altera el stdin con el flag apagado —que es lo que hacía falta— pero no prueba la no-regresión del texto legacy. Lo verifiqué por separado con el diff y el texto legacy no cambió.
- **Dónde:** /datos/workspaces/zeus/cauce-v3/packages/adapter-sdk/test/native-profile-context.test.ts:176-232
- **Arreglo:** Añadir un SHA fijado del prompt legacy para un contexto canónico, o dejarlo así y confiar en el diff — pero entonces no llamarlo «byte a byte» en el reporte sin decir contra qué.

## Activar en la ventana
NADA del flag. Con la lista tal como está escrita, el primer canario OpenClaw se rompe. Verifiqué los 4 bloqueantes que el propio reporte declara y los cuatro son reales: (1) `CAUCE_NATIVE_PROFILE_CONTEXT` no está en la allowlist del supervisor y el `case` termina en `*) die "container alias config key is not allowlisted"` — ponerlo hoy no lo descarta, MATA al alias (ops/scripts/container-adapter-supervisor.sh:176-196); (2) las generaciones no coinciden — supervisor `sha256(id\0started\0restart\0init_starttime)` 64 hex (container-adapter-supervisor.sh:483-485) contra launcher `sha256(id|started|restart)[0:32]` (ops/pty-agent/cauce-pty-launcher.sh:149-155), y como el launcher filtra procesos por igualdad exacta de `CAUCE_CONTAINER_GENERATION`, hoy la sonda de hechos no encontraría NINGÚN proceso y el PUT devolvería `unavailable`; (3) prod sigue en `024_agent_role_templates.sql`, `to_regclass('public.agent_profiles') IS NULL` y no existe `agent_profile_runtime_expectations`; (4) iza y janus comparten `claw-miguel` y el workspace `/home/claw/clawd` (los siete ficheros están ahí, uno solo para los dos), y zeus es el único claude y está en TUI compartida.

Lo ÚNICO activable en la ventana, y solo después de poner el gate en verde: desplegar el código con el flag AUSENTE en los 14 alias y comprobar que la entrega sale idéntica. Eso es seguro — el default-off preserva los bytes del stdin (verificado por diff del texto legacy entre 2a787aac y HEAD, y por las pruebas 280 y 281, ambas verdes).

Para que esto pase a APROBADO-CON-ARREGLOS hacen falta, además de los 4 prerrequisitos del reporte: (a) topes de OpenClaw leídos por alias y con MEMORY/HEARTBEAT contados en el agregado; (b) el bloque A dentro del lote del publicador durable, o el fichero de instrucciones fuera del contrato hasta que A esté sellado — sin eso, la segunda entrega de cada canario muere; (c) los 5 tests rojos de adapter-sdk arreglados; (d) la fila «Hermes» del diagnóstico corregida.

## Evidencia
## 1. Diagnóstico: método real, una fila falsa

Prod está donde el reporte dice:
```
$ docker exec -u postgres cauce-v3-prod-postgres-1 psql -X -d cauce -U cauce \
    -c "SET default_transaction_read_only=on; SET statement_timeout='10s';" \
    -c "SELECT to_regclass('public.agent_profiles'), to_regclass('public.agent_profile_runtime_expectations'), (SELECT max(version) FROM schema_migrations);"
 agent_profiles | expectations |        max_migration
----------------+--------------+------------------------------
                |              | 024_agent_role_templates.sql
```

La muestra anonimizada es `left(md5(delivery_id),12)`. Las cuatro del reporte existen:
```
    sample    | harness_id | tenant | alias  |      mtype       | body_bytes | role_chars
--------------+------------+--------+--------+------------------+------------+-----------
 e834bb7e9489 | claude     | Steven | zeus   | telegram.message |        292 |       1097
 7b0f38e85ca2 | openclaw   | Steven | jarvis | request          |       1022 |       1129
 80cdc4a39f4a | openclaw   | Steven | argos  | request          |        983 |       1101   <-- publicada como «Hermes»
 a30097529800 | codex      | Miguel | kratos | telegram.message |        316 |       1078
```
Y no hay ningún hermes en la flota:
```
 harness_id | count | enabled        Steven|zeus     |claude    Steven|argos    |openclaw
------------+-------+---------       Miguel|atlas    |codex     Miguel|gaia     |openclaw
 claude     |     1 |       1        Steven|kant     |codex     Jhon  |hegel    |openclaw
 codex      |     5 |       5        Miguel|kratos   |codex     Jhon  |heraclito|openclaw
 openclaw   |     8 |       8        Isa   |salva    |codex     Miguel|iza      |openclaw
                                     Steven|socrates |codex     Miguel|janus    |openclaw
(harness_definitions sí tiene 'hermes',                        Steven|jarvis   |openclaw
 pero ningún agente lo usa)                                    Jhon  |tales    |openclaw
```
`docs/flota-y-participantes.md:17` confirma: «argos (director general de desarrollo — **OpenClaw**)».

Reproducción de la cifra sobre esas cuatro muestras (`textoFijoDelSobre` menos el puntero, dist compilado):
```
pointer bytes: 244
claude/zeus     fijo=8888B  delta=8644B  codepoints=8838  tokens~=2210  bloqueA=7764B   (reporte: 8537)
codex/kratos    fijo=8871B  delta=8627B  codepoints=8821  tokens~=2205  bloqueA=7766B   (reporte: 8520)
openclaw/argos  fijo=8893B  delta=8649B  codepoints=8843  tokens~=2211  bloqueA=7765B   (reporte: 8542 «Hermes»)
openclaw/jarvis fijo=8922B  delta=8678B  codepoints=8872  tokens~=2218  bloqueA=7766B   (reporte: 8571)
```
Magnitud confirmada, +107 B sistemático.

## 2. Dónde escribe vs. dónde lee cada arnés

`ws-zeus` (claude) — el destino existe y coincide con el reporte:
```
$ docker exec ws-zeus ls -l /home/dev/.claude/CLAUDE.md
-rw-r--r-- 1 dev dev 10733 Aug  2 16:53 /home/dev/.claude/CLAUDE.md
```
`rutaDelContextoFijo("claude", …)` devuelve `$CLAUDE_CONFIG_DIR/CLAUDE.md` o `$HOME/.claude/CLAUDE.md` (packages/adapter-sdk/src/harnesses/contexto-fijo.ts:80-82) = memoria de usuario de Claude Code, que se fija al arrancar el proceso. Correcto para headless (proceso nuevo por entrega); por eso la TUI compartida se rechaza.

`claw-miguel` (openclaw) — workspace `/home/claw/clawd`, los siete ficheros presentes, uno solo para iza Y janus:
```
SOUL.md 1651  IDENTITY.md 4109  USER.md 1377  MEMORY.md 17948
HEARTBEAT.md 233  AGENTS.md 12240  TOOLS.md 6746      (total 44.304 B)
```
Que OpenClaw los relee por run está en la doc de la versión instalada (2026.6.6):
```
$ docker exec claw-miguel cat .../docs/concepts/system-prompt.md
  "OpenClaw builds a custom system prompt for every agent run."
$ docker exec claw-miguel cat .../docs/concepts/agent-workspace.md
  "AGENTS.md … Loaded at the start of every session."
  "Large bootstrap files are truncated when injected; adjust limits with
   agents.defaults.bootstrapMaxChars (default: 20000) and
   agents.defaults.bootstrapTotalMaxChars (default: 60000)."
```

## 3. Los topes reales, por contenedor (el bloqueante)

```
$ for c in claw agv2-miguel-finca-oc claw-iza claw-miguel; do
    docker exec $c cat /home/claw/.openclaw/openclaw.json | grep -o '"bootstrap[A-Za-z]*"[^,]*'; done
claw                  -> 60000 / 150000
agv2-miguel-finca-oc  -> (sin claves: defaults 20000 / 60000)   <-- gaia, primer canario
claw-iza              -> 24000 / 90000
claw-miguel           -> 24000 / 90000
```
Cauce valida contra `60_000 / 150_000` cableado (packages/protocol/src/ficheros-del-arnes.ts:141) y `grep -rn "bootstrapMaxChars" packages services ops console` no da ni un solo resultado fuera de este informe: los topes nunca se leen del alias. Los bloques se anexan al FINAL (`conBloqueEntreMarcas`: `base + "\n\n" + nuevo`), que es justo lo que la truncación se lleva. AGENTS.md de gaia = 8.109 B + bloque A 7.765 B = 15.874 B + B autorado, contra un tope real de 20.000.

## 4. El precipicio, reproducido

```
$ node scratchpad/cliff.mjs      # claude nativo, flag=1, expectativa del publicador (fichero SIN A)
expectation sha (publisher): 14d145028cad
delivery 1: OK, file now sha: 835362e11b6f
delivery 2: FAILED -> NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED
            Native profile context preflight failed: …/CLAUDE.md does not match profile revision 7
```
La entrega 1 converge A y cambia el SHA; la entrega 2, con la MISMA expectativa vigente, muere. Error retryable → quema intentos → dead-letter.

## 5. Flag: default-off intacto en bytes

```
$ pnpm --filter @cauce/adapter-sdk run test
ok 280 - absent and zero native flags preserve the legacy prompt byte for byte
ok 281 - claude projects the fixed contract and sends only pointer, metadata, and request
ok 278/279/282..291  (las 15 nativas, todas verdes)
# tests 689   # pass 684   # fail 5   EXIT=1
not ok 493/494/499 - shared-session-budget-and-finalize (regex castellano vs texto ya traducido)
not ok 590/592 - rename post-paste
```
`git diff 2a787aac..HEAD -- packages/adapter-sdk/src/harnesses/shared/prompt.ts` confirma que el texto legacy no cambió: los únicos cambios son el parámetro `includeRoom` (solo lo usa la rama nativa), el descarte de tres claves en `deliveryMetadata` que el engine solo pobla en esta ronda, y las dos ramas `native ? … : …` de `protocolPrompt`.

## 6. Fencing (lo que SÍ aguanta)

Busqué la carrera «proyección vieja pisa una nueva» y está cerrada en todos los caminos:
- `profileRuntimeExpectation` hace `JOIN agent_profiles ON profile.revision=expectation.revision … FOR SHARE`: una expectativa supersedida no se sirve (packages/store/src/repository/agents.ts:103-125).
- El trigger `agent_profile_runtime_adoptions_expectation_guard` exige coincidencia exacta con la expectativa VIGENTE (035:75-105).
- `applied_revision` solo avanza con `revision=$3 AND (applied_revision IS NULL OR applied_revision < $3)`, y 028 lo acota con `CHECK (applied_revision <= revision)`.
- La siembra de reconnect, si el fichero canónico lleva marcador de revisión, regenera el lote con ESA revisión y solo acepta el no-op exacto; cualquier diferencia devuelve `no-se-pudo-escribir` sin tocar el disco (siembra-del-perfil.ts:504-532). Un hello viejo no puede pisar un PUT nuevo.
- El preflight del adaptador exige `revisionDelPerfil(fichero) === contract.revision` (native-profile-context.ts:300-308).
- Y `siembraHabilitada` apaga la siembra legacy cuando el flag está encendido (client.ts:622-625).
Residuo real y ya declarado por el reporte: comparar-y-escribir no es un CAS atómico del kernel.

## 7. Prerrequisitos operativos verificados

```
$ grep -rn "CAUCE_NATIVE_PROFILE_CONTEXT" ops/     -> 0 resultados
ops/scripts/container-adapter-supervisor.sh:176-196  case … *) die 'config key is not allowlisted'
ops/scripts/container-adapter-supervisor.sh:483-485  sha256(id\0started\0restart\0init_starttime)  (64 hex)
ops/pty-agent/cauce-pty-launcher.sh:149-155          sha256(id|started|restart)[0:32]              (32 hex)
ops/pty-agent/cauce-pty-launcher.sh:424,438-440      filtra /proc por igualdad EXACTA de CAUCE_CONTAINER_GENERATION
```
