# Contextos nativos por harness

## 1. Diagnóstico medido

### Resultado

La afirmación del dueño queda **confirmada para producción**: cada entrega medida vuelve a
transportar entre 8.52 y 8.57 kB (8.32–8.37 KiB) de contrato e identidad que no dependen del pedido. Son
aproximadamente 2.12K tokens de entrada por turno. La estimación es deliberadamente simple y
reproducible (`puntos de código / 4`), no una cifra de facturación de un tokenizer concreto.

Hay que separar dos estados:

- La base productiva está aún en `024_agent_role_templates.sql`; un `SELECT` confirmó que
  `to_regclass('public.agent_profiles') IS NULL`. Por tanto, hoy producción no puede ejecutar el
  flujo 026/028/035 ni enviar `agent_profile` en el saludo.
- `main` ya contiene buena parte del destino: perfil por `hello_ack`, escritura de ficheros nativos,
  expectativas de runtime y adopción cercada. Sin embargo, las sesiones compartidas siguen
  adjuntando un `runtime_profile` medido en cada turno y los bytes gestionados no estaban ligados
  durablemente a la revisión autorada. Esta ronda cierra el fencing y retira la repetición solo en
  Claude/OpenClaw headless detrás de un flag; la TUI compartida se rechaza y conserva su inyección
  legacy hasta que exista una prueba real de recarga.

### Flujo completo existente en `main`

1. **Autoría y fencing en PostgreSQL.** La 026 crea `agent_profiles`, define los siete campos
   autorados y copia literalmente el `agents.role_brief` existente
   (`packages/store/migrations/026_agent_profile.sql:139-221,223-235`). La 028 convierte
   `role_summary` en fuente canónica, agrega `revision/applied_revision` y hace que el trigger
   avance la revisión cuando cambia contenido
   (`packages/store/migrations/028_canonical_agent_role.sql:25-78`). La 035 separa expectativa de
   documentos exactos y adopción conductual de una entrega real cercada
   (`packages/store/migrations/035_agent_profile_runtime_adoption.sql:45-109`).
2. **Composición.** El protocolo valida el presupuesto y compone el perfil
   (`packages/protocol/src/agent-profile.ts:18-40,46-60,138-159,205-209,256-294`). La proyección
   actual distribuye Claude a `CLAUDE.md`, Codex a `AGENTS.md` y OpenClaw a siete Markdown
   (`packages/protocol/src/ficheros-del-arnes.ts:187-246,264-360`).
3. **Lectura y publicación.** Store hace CAS del perfil y une permisos, cuotas, arnés y destinos
   (`packages/store/src/agent-profile.ts:123-193,283-357`). Gateway lo lee y lo envía una vez en
   `hello_ack`, gateado por `agent_profile_v1`
   (`services/gateway/src/routes/core.ts:343-363,421-425`). El PUT de `/live` ya sigue
   preflight → desired CAS → lote de ficheros → expectativa → adopción/applied
   (`services/gateway/src/console/agent-profile.routes.ts:499-714`).
4. **Escritura dentro del runtime.** El cliente anuncia las capabilities de perfil, recibe el
   saludo y siembra antes de aceptar tráfico (`packages/adapter-sdk/src/sdk/client.ts:69-128,238-302`).
   `sembrarPerfilDelArnes()` resuelve el directorio, compone todo el lote, hace preflight y evita
   una escritura parcial (`packages/adapter-sdk/src/context/siembra-del-perfil.ts:307-411,418-573`).
5. **Cada entrega.** Engine arma identidad, rol y routing
   (`packages/adapter-sdk/src/sdk/engine.ts:343-384`). El adaptador transforma eso en stdin
   (`packages/adapter-sdk/src/harnesses/shared/adapter.ts:330-380`). `protocolPrompt()` agrega, en
   este orden: identidad y rol; deber primario; esquema de salida e invariantes; mecánica de
   delegación; `runtime_profile` opcional; metadata; origen; pedido
   (`packages/adapter-sdk/src/harnesses/shared/prompt.ts:64-83,106-143,169-235`).
6. **Por qué se repite.** Sin un sello exacto se manda todo el bloque fijo; con sello se sustituye
   por un puntero corto (`packages/adapter-sdk/src/harnesses/contexto-fijo.ts:29-35,60-65`). En una
   sesión compartida, el código deshabilita a propósito ese recorte y vuelve a leer e inyectar el
   perfil vivo en cada turno porque la TUI pudo arrancar antes que el fichero
   (`packages/adapter-sdk/src/harnesses/shared/adapter.ts:205-325`).

### Medición sobre entregas reales

Se tomó por harness la entrega productiva no-fanin más reciente, mediante `BEGIN READ ONLY`,
`default_transaction_read_only=on` y `statement_timeout=10s`. El cuerpo y el rol circularon solo
por el pipe de memoria hacia el compositor; el resultado conserva un hash de 12 caracteres del
delivery y solo publica conteos. La columna `bytes repetidos` es la diferencia exacta entre el
mismo `protocolPrompt()` sin sello y con el sello SHA válido; excluye pedido, metadata y origen.

| Harness | Muestra anonimizada | Bytes repetidos | Puntos de código | Tokens estimados |
|---|---:|---:|---:|---:|
| Claude | `e834bb7e9489` | 8,537 | 8,491 | 2,123 |
| Codex | `a30097529800` | 8,520 | 8,474 | 2,119 |
| Hermes | `80cdc4a39f4a` | 8,542 | 8,496 | 2,124 |
| OpenClaw | `7b0f38e85ca2` | 8,571 | 8,525 | 2,132 |

El costo es mayor que el pedido de tres de las cuatro muestras: los cuerpos medían 429, 476,
997 y 1,057 bytes, mientras el preámbulo repetido rondaba 8.5 kB. En `main`, una sesión
compartida además puede agregar el bloque JSON `TRUSTED RUNTIME PROFILE`; no se lo suma a la tabla
porque ese camino todavía no está desplegado en la base productiva 024.

### Ficheros reservados para esta ronda

Codex-2 puede continuar su molienda fuera de esta lista. Estos son los únicos ficheros `src` que
esta ronda puede necesitar; si el diseño permite reducir la lista, los sobrantes no se tocarán:

- `packages/adapter-sdk/src/context/siembra-del-perfil.ts`
- `packages/adapter-sdk/src/context/native-profile-context.ts` (nuevo dentro del mismo subsistema)
- `packages/adapter-sdk/src/contracts/harness.ts`
- `packages/adapter-sdk/src/harnesses/shared/adapter.ts`
- `packages/adapter-sdk/src/harnesses/shared/prompt.ts`
- `packages/adapter-sdk/src/sdk/client.ts`
- `packages/adapter-sdk/src/sdk/engine.ts`
- `packages/adapter-sdk/src/sdk/types.ts`
- `packages/protocol/src/agent-profile.ts`
- `packages/protocol/src/ficheros-del-arnes.ts`
- `packages/protocol/src/schemas/realtime.ts`
- `packages/store/src/agent-profile.ts`
- `packages/store/src/repository/agents.ts`
- `packages/store/src/repository/deliveries/claims.ts`
- `services/gateway/src/console/agent-profile-runtime.ts`
- `services/gateway/src/console/agent-profile.routes.ts`
- `services/gateway/src/routes/core.ts`

## 2. Cómo consume contexto cada harness

### Matriz nativa

| Harness | Ficheros que realmente consume | Momento de lectura | Límite relevante |
|---|---|---|---|
| Claude Code | Política Linux `/etc/claude-code/CLAUDE.md`; usuario `$CLAUDE_CONFIG_DIR/CLAUDE.md` o `~/.claude/CLAUDE.md`; `CLAUDE.md`, `.claude/CLAUDE.md` y `CLAUDE.local.md` desde raíz hasta cwd; reglas descendentes bajo demanda | Usuario y raíz del proyecto se fijan al arrancar. Un cambio entra en la siguiente sesión, `/clear` o `/compact`; los ficheros descendentes se cargan cuando se accede a su árbol. | Recomendación menor de 200 líneas; un `CLAUDE.md` de más de 4 MiB se omite. La auto-memoria carga 200 líneas o 25 KiB. |
| Codex CLI | `$CODEX_HOME/AGENTS.override.md` o `AGENTS.md`; después un `AGENTS.override.md`, `AGENTS.md` o fallback por directorio desde la raíz del proyecto hasta cwd | Construye la cadena una vez por ejecución; en TUI, una vez por sesión lanzada. | `project_doc_max_bytes`, 32 KiB agregados por defecto. No existe un `Codex.md` nativo. |
| OpenClaw | Workspace configurado: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` y, en la versión instalada, también `TOOLS.md`, `HEARTBEAT.md` y `BOOTSTRAP.md` cuando aplica | OpenClaw 2026.6.6 resuelve y lee los bootstrap files en cada `agent run`; su caché solo reutiliza el objeto si los bytes no cambiaron. El cambio queda visible en el siguiente run sin reiniciar gateway. | Upstream: 20,000 caracteres por fichero y 60,000 agregados; `USER.md` tiene 4,000. Los runtimes medidos también usan 24K/90K y 60K/150K. |
| Hermes Agent | Identidad en `$HERMES_HOME/SOUL.md`; proyecto: `.hermes.md`/`HERMES.md`, luego `AGENTS.md`, después `CLAUDE.md`/`.cursorrules`; memoria en `$HERMES_HOME/memories/{MEMORY,USER}.md` | El prompt es una foto al comienzo de sesión; los cambios exigen sesión nueva. Cauce usa `run_oneshot()`, por lo que una entrega nueva reconstruiría esa foto. | En el commit fijado, el presupuesto de contexto de proyecto deriva de la ventana: 6 %, con mínimo 20K y máximo 500K caracteres. `MEMORY.md` y `USER.md` tienen sus propios topes. |

Las fuentes primarias son la documentación de
[memoria de Claude Code](https://code.claude.com/docs/en/memory) y su
[caché de prompt](https://code.claude.com/docs/en/prompt-caching), la resolución oficial de
[AGENTS.md de Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md), el
[workspace](https://docs.openclaw.ai/concepts/agent-workspace) y
[system prompt](https://docs.openclaw.ai/concepts/system-prompt) de OpenClaw, y el
[`prompt_builder.py` fijado de Hermes](https://github.com/NousResearch/hermes-agent/blob/62b2d78025c349996e753c6f7c748de035eb8048/agent/prompt_builder.py).

### Qué existe hoy en los runtimes

La inspección fue solo lectura. Se usó `docker exec` con `cat` canalizado únicamente a `wc`,
`sha256sum` o una búsqueda de marcas; no se imprimieron perfiles, memoria ni secretos.

- Claude Code es 2.1.248 en el host y 2.1.179 en los cuatro contenedores de workspace medidos.
  Los `CLAUDE.md` reales miden entre 8,339 y 10,733 bytes. `ws-zeus`, por ejemplo, tiene
  `/home/dev/.claude/CLAUDE.md` de 10,733 bytes, SHA abreviado `40cb552d8870`.
- Los `AGENTS.md` de Codex medidos existen bajo `~/.codex`; van de 9,776 a 13,319 bytes. En
  `ws-humanizar`, `/home/dev/.codex/AGENTS.md` mide 13,319 bytes, SHA `a1a2c5c9113a`.
- Los siete ficheros del workspace OpenClaw existen en los runtimes grandes. El total va de
  11,961 a 60,986 bytes según alias. En `claw`, por ejemplo, los siete suman 60,986 bytes; en
  `agv2-jhon-hegel-oc`, 21,838. `BOOTSTRAP.md` solo apareció en Tales y algunos alias no tienen
  `MEMORY.md`, ambos casos válidos para upstream.
- El Hermes esperado está fijado en `ops/hermes-runtime.json` a 0.20.5/`62b2d780…`, pero
  `ws-humanizar` aún contiene 0.19.0 y no tiene el release sellado bajo `/opt`. El home canónico
  dormido de Iza solo tiene un `SOUL.md` de 513 bytes. La ejecución viva atribuida a Iza es hoy
  OpenClaw en `claw-iza`, no ese Hermes.
- Ninguno de los ficheros inspeccionados contiene `CAUCE:PERFIL` ni `CAUCE:CONTEXTO-FIJO`.
  Los bundles activos, fechados entre el 12 y el 19 de agosto, tampoco contienen los símbolos
  `sembrarPerfil` o `CAUCE_SEMBRAR_PERFIL`; la siembra llegó a `main` el 25 de agosto.

### Qué ya hace Cauce y qué falta

Hay dos caminos existentes, no una hoja en blanco:

1. `sembrarPerfilDelArnes()` corre una vez por conexión durante `hello_ack`, resuelve directorios
   medidos, hace preflight completo y escribe el lote con rollback
   (`packages/adapter-sdk/src/context/siembra-del-perfil.ts:307-411,418-573`; llamada en
   `packages/adapter-sdk/src/sdk/client.ts:254-291`). Claude recibe `CLAUDE.md`, Codex
   `AGENTS.md`, OpenClaw siete ficheros y Hermes ninguno
   (`packages/protocol/src/ficheros-del-arnes.ts:187-360`). En OpenClaw, `MEMORY.md` y
   `HEARTBEAT.md` se preservan y solo se crean vacíos si faltan (`:278-301`).
2. El PUT de Console ya es el publicador fuerte: prepara, verifica límites, escribe por relay,
   relee SHA/bytes/generation y registra expectativa
   (`services/gateway/src/console/agent-profile-runtime.ts:72-308`). Después espera una entrega
   que adopte esa misma revisión y solo entonces avanza `applied_revision`
   (`services/gateway/src/console/agent-profile.routes.ts:499-714`). Esta debe seguir siendo la
   única autoridad de publicación; agregar un tercer escritor produciría carreras.

Las units generadas declaran `CAUCE_SEMBRAR_PERFIL=1`, junto con HOME/config/workspace por alias
(`ops/scripts/generate-units.py:37-59` y
`ops/scripts/generate-container-units.py:193,208-243`). Pero el código fuente actual interpreta
la ausencia del valor como encendido (`CAUCE_SEMBRAR_PERFIL !== "0"`) y producción aún no lleva
ese código. La nueva omisión por mensaje debe usar otro flag, estricto y **apagado por defecto**.

Finalmente, la siembra de perfil no equivale al sello del contrato fijo. El camino legacy solo
siembra ese contrato con `CAUCE_SEMBRAR_CONTEXTO=1`; en TUI compartida se niega deliberadamente a
recortarlo porque la sesión puede haber arrancado horas antes
(`packages/adapter-sdk/src/harnesses/shared/adapter.ts:205-325`). Esa misma TUI vuelve a leer cinco
bloques autorados y crea `runtime_profile` en cada turno (`:274-325`), que `protocolPrompt()`
inyecta en `BEGIN TRUSTED RUNTIME PROFILE` (`shared/prompt.ts:216-223`). Por eso la proyección ya
existente todavía no cumple la visión del dueño.

La consecuencia operativa es distinta por modo: Claude headless y OpenClaw crean un proceso/run
por entrega y pueden observar el fichero en la siguiente; un Claude/Codex TUI persistente requiere
refresh o sesión nueva antes de retirar el bloque. Hermes one-shot también lo observaría, pero su
proyección aún es un no-op y queda fuera de esta implementación mínima.

## 3. Diseño: perfil al fichero una vez; turno sin perfil duplicado

### Modelo objetivo y autoridad

`agent_profiles` continúa siendo la única fuente autorada. Una publicación desde `/live` sigue
esta secuencia, sin un escritor nuevo:

1. La UI envía `PUT perfil` con `expected_revision`.
2. Gateway normaliza y hace preflight del runtime medido sin mutar nada.
3. Store hace CAS de desired; el trigger de 028 avanza `revision` solo cuando cambian los campos.
4. La preflight de disco se conserva inmutable hasta que el CAS devuelve la revisión durable.
   Entonces `materialize(revision)` compone en memoria el marcador literal y B, y un único lote
   escribe `CLAUDE.md` o los siete ficheros OpenClaw. El readback acredita ruta+bytes+SHA bajo la
   misma `generation`; la expectativa 035 conserva para esa revisión el conjunto exacto.
5. La primera entrega que termina correctamente y mide exactamente esos documentos registra la
   adopción. Solo ese ACK cercado puede hacer `applied_revision = revision`.

La revisión también queda escrita literalmente en el fichero canónico, en una línea
`CAUCE:REVISION-PERFIL` inmediatamente anterior a B: `CLAUDE.md` para Claude y `AGENTS.md` para
OpenClaw. No se predice el número ni se hace una segunda escritura después del CAS. Los demás
Markdown OpenClaw quedan ligados a la misma revisión mediante el contrato único
`revision + container generation + [(path, SHA)]`; repetir el comentario en los cinco ficheros
autorados sería redundante. El marcador mejora observabilidad y defensa, pero no sustituye el
fencing durable: una edición directa, un recreate o una revisión supersedida sigue sin poder
acreditarse solo por conservar la etiqueta.

El contrato fijo de Cauce y el perfil rico siguen siendo bloques separados en el fichero nativo:

- bloque A, `CAUCE:CONTEXTO-FIJO`: identidad corta, deber, salida estructurada e invariantes;
- bloque B, `CAUCE:PERFIL`: propósito, rol, responsabilidades, restricciones, humano, herramientas
  y reglas, repartido por fichero en OpenClaw.

La proyección de `/live` es dueña de B. El adaptador, que es el único que puede componer A sin
duplicar la redacción del protocolo, acredita y converge A antes de arrancar un turno nativo. Un
SHA exacto del bloque A habilita únicamente el puntero corto. Si faltan el perfil propio, la ruta,
el write o la relectura exacta, el modo nativo falla antes de invocar al proveedor: jamás elimina
el contexto por confianza.

### Flag y comportamiento por entrega

El opt-in por proceso/alias será `CAUCE_NATIVE_PROFILE_CONTEXT=1`. Ausente o `0` conserva
exactamente el comportamiento actual; cualquier otro valor es error de configuración. El opt-in
solo admite Claude y OpenClaw. Claude con TUI compartida se rechaza al arrancar, porque una sesión
vieja no puede probar que releyó sus instrucciones.

Con el flag activo y la proyección acreditada, la entrada del turno conserva:

- un puntero corto al contrato A ya cargado;
- metadata dinámica de entrega y origen, necesaria para routing/fencing;
- el pedido.

No contiene el contrato A completo, `self_role` ni `BEGIN TRUSTED RUNTIME PROFILE`. Es «solo el
mensaje» en el sentido relevante: ninguna faceta autorada vuelve a viajar por turno; el pequeño
contexto transaccional no se puede volver un fichero estático.

La medición de adopción permanece fuera del prompt. Para Claude acredita `CLAUDE.md`; para
OpenClaw acredita los siete documentos. `MEMORY.md` y `HEARTBEAT.md` aportan solo ruta+SHA al ACK:
sus bytes siguen siendo del agente y nunca se copian al bloque inyectable. Esto corrige además la
cardinalidad actual de cinco contra una expectativa de siete, que impide adoptar OpenClaw.

### Recarga y edición desde `/live`

- **OpenClaw 2026.6.6:** relee el workspace en el siguiente `agent run`; no requiere reinicio.
- **Claude headless:** Cauce crea el proceso después de converger el fichero; ese mismo turno ya
  puede cargarlo. Un cambio posterior entra en la siguiente invocación.
- **Claude compartido:** antes de activar hay que cerrar/recrear la TUI o pasar el alias a
  headless. La primera versión no intentará matar una conversación ni simular una recarga.
- **Hermes/Codex:** quedan pineados al comportamiento existente. Hermes todavía no tiene
  proyección y Codex compartido presenta la misma barrera de recarga; ampliar soporte sin resolver
  esas dos diferencias sería afirmar adopción sin prueba.

La UI no cambia: editar directivas sigue siendo PUT → CAS → proyección → expectativa. Si la
respuesta es `202 pending_session_refresh`, el fichero está escrito pero la revisión no se declara
aplicada. Una entrega posterior puede producir el ACK exacto; al persistir ese ACK, Store registra
la adopción y avanza `applied_revision` en la misma transacción. El GET posterior puede releer el
runtime y renovar su expectativa, pero no causa el avance de `applied_revision`.

### Ahorro esperado

Las muestras de la sección 1 retiran 8,520–8,571 bytes del **stdin que compone Cauce**,
aproximadamente 2,119–2,132 tokens con la estimación reproducible `puntos de código / 4`. A eso se
podría sumarse en el futuro el JSON `runtime_profile` que `main` adjunta hoy a las TUI compartidas,
pero **no es ahorro de esta implementación**: el flag rechaza esas sesiones hasta poder probar que
releyeron el fichero. Producción 024 tampoco permite medir ese JSON con un perfil real, así que no
se inventa una cifra. En los modos soportados, B sigue entrando una vez por el mecanismo nativo del
arnés —son instrucciones útiles— y no se contaba como `runtime_profile` headless. El ahorro medido
es A: contrato fijo, identidad e invariantes que dejan de viajar dentro de cada stdin y pueden
ocupar el prefijo estable/cachable que el proveedor diseñó para ellos. No es una afirmación de
ahorro facturado ni de reducción de la ventana del proveedor.

### Riesgos y prohibiciones

- No activar por la mera existencia de un fichero: se exige owner del alias, sello exacto y, para
  `applied_revision`, la expectativa completa de la revisión y generación actuales.
- No activar Claude sobre una TUI longeva. Reiniciar el adaptador no reinicia por sí solo ese pane.
- No meter `MEMORY.md`/`HEARTBEAT.md` en el perfil autorado ni reescribir sus bytes.
- No servir ni modificar `openclaw.json`: mezcla configuración con credenciales y no es una
  superficie de directivas.
- No confiar en el harness declarado de inventario cuando los hechos medidos difieren; Iza ya
  demuestra que esa deriva ocurre.
- No escribir migraciones, no avanzar `applied_revision` desde el write y no habilitar el flag de
  toda la flota a la vez. La activación debe ser por alias y con un canario real.
- La convergencia de A y la publicación multifichero no forman una transacción común con un turno
  concurrente. La ventana debe poner el alias en reposo mientras publica/activa y verificar la
  primera adopción antes de devolverle tráfico normal.

## 4. Implementación mínima verificable

### Qué quedó implementado

El opt-in está contenido en `NativeProfileContext` y se construye una vez por proceso
(`packages/adapter-sdk/src/context/native-profile-context.ts:45-175`). Acepta exclusivamente
ausencia/`0`/`1`, limita soporte a Claude y OpenClaw headless, exige generación y rutas absolutas,
y falla antes de leer disco para cualquier combinación no soportada. Ausencia o `0` no crea el
proyector ni añade IO (`packages/adapter-sdk/src/harnesses/shared/adapter.ts:72-89`).

Para una entrega activada, el preflight hace lo siguiente:

1. relee el bloque B y valida cardinalidad, nombre, ruta, owner, SHA autorado y generación contra
   `profile_runtime_contract`;
2. rechaza A parcial, repetido, invertido o fuera del fichero de instrucciones, y rechaza B
   parcial, repetido, ajeno o solapado/anidado con A en los ficheros autorados; permite que A
   todavía no exista para poder convergerlo y exige al menos un bloque B propio en el lote;
3. converge el bloque A solo en `CLAUDE.md` o `AGENTS.md`, preservando el texto humano;
4. vuelve a leer el lote completo y genera evidencia exacta de uno o siete documentos;
5. repite la lectura inmediatamente antes de invocar al runner y después del turno.

Las lecturas usan `dirfd`, `O_NOFOLLOW`, tamaño acotado antes de reservar memoria y verificación de
identidad; la escritura condicionada rechaza symlinks, hardlinks y bytes distintos de los leídos
(`packages/adapter-sdk/src/context/siembra-del-perfil.ts:177-262,329-411`). OpenClaw vuelve a
comprobar 60K por fichero y 150K agregados después de sumar A
(`native-profile-context.ts:225-247`). `MEMORY.md` y `HEARTBEAT.md` se miden, pero nunca se copian al
perfil ni al prompt; sus posibles marcas textuales tampoco se interpretan como bloque B autorado.

Engine ejecuta el primer preflight todavía en `accepted`; solo después publica `started`. Dentro
del adaptador hay otra revalidación, se confirma el intent durable y se hace una última relectura
antes del runner. Esa relectura puede fallar después del intent pero antes del proveedor; la
relectura posterior al turno impide emitir adopción si hubo drift
(`packages/adapter-sdk/src/sdk/engine.ts:340-449` y
`packages/adapter-sdk/src/harnesses/shared/adapter.ts:331-375,497-509`). La comparación exacta de
contrato y medición quedó en una función pura compartida
(`packages/protocol/src/profile-runtime-adoption.ts:11-31`).

Con evidencia válida, `protocolPrompt()` envía el puntero a A, las tres reglas dinámicas de
`agent.response` cuando aplican, metadata/origen y pedido. Omite A completo, `self_role` y
`BEGIN TRUSTED RUNTIME PROFILE` (`packages/adapter-sdk/src/harnesses/shared/prompt.ts:197-235`). El
modo nativo también apaga la siembra legacy desde el `hello_ack`, para que un saludo viejo no pise
una publicación más nueva (`packages/adapter-sdk/src/sdk/client.ts:622-625`). El comportamiento
default-off se fijó byte a byte en una prueba dedicada.

La publicación de B no se duplicó en el adaptador: sigue en el PUT existente de Gateway. La
preflight captura una sola foto de rutas, bytes, generación y precondiciones antes del CAS; cuando
Store devuelve el número real, `materialize(revision)` compone perfil y marcador en memoria y
`apply()` consume esa foto una sola vez. El lote sigue siendo uno: no existe una ventana de
«perfil escrito, revisión todavía no escrita». El sentinel con el mayor entero seguro valida antes
del CAS el peor ancho posible del marcador; puede rechazar conservadoramente un OpenClaw situado a
unos pocos caracteres del tope, pero evita descubrir después del CAS que el número durable no cabe.

El parser del marcador exige entero positivo seguro, una sola línea canónica adyacente a un único
B y topología A/B completa, alineada y disjunta. El publicador rechaza CR/CRLF en este camino,
delimitadores `CAUCE:` dentro de campos autorados, bloques duplicados o anidados y owner distinto
en la primera línea; valida tanto los bytes previos como los bytes compuestos antes del lote. El
adaptador vuelve a exigir que el marcador observado coincida exactamente con la revisión del
delivery. Codex conserva su formato legacy y no recibe marcador, porque todavía no soporta este
opt-in (`packages/protocol/src/ficheros-del-arnes.ts:14-129,264-360`).

La siembra de reconnect tampoco vuelve a ser un escritor alternativo. Si encuentra una proyección
revisionada de Claude u OpenClaw, recupera su revisión, recompone todo el lote y solo acepta el
no-op exacto. Drift, un fichero OpenClaw ausente o un owner ajeno fallan sin escribir nada. Así el
flag `0` sigue siendo un rollback seguro con prompt legacy, pero no puede pisar ni declarar vigente
una publicación durable incompleta. Sin marcador, la ruta legacy conserva su formato anterior y
acepta los ficheros humanos CRLF que ya aceptaba; la validación estricta no se filtra al default-off
(`packages/adapter-sdk/src/context/siembra-del-perfil.ts:494-573`).

La nueva prueba de saga usa el publicador real contra disco simulado para Claude y los siete
ficheros OpenClaw. Demuestra revisión 1→2→3, marcador literal 2→3, respuesta `202` mientras falta
evidencia, comparación pura por path+SHA+generation, reentrada idempotente de la ruta y
`applied_revision` 1→2→3. La evidencia se suministra de forma controlada al mock de Store: esta
prueba no pretende ser una entrega ni un ACK reales. También demuestra que
`MEMORY.md`/`HEARTBEAT.md` sobreviven byte a byte
(`services/gateway/src/console/agent-profile-native-projection.test.ts`).

### Evidencia de pruebas

- 15/15 pruebas nativas del adaptador: flag estricto, default-off byte-puro, Claude, OpenClaw
  siete documentos, límites, marcas/owner/generation, IO acotado, CAS, barreras de ejecución,
  topología disjunta de A/B antes de escribir, bootstrap de A y ACK de adopción exacta desde Engine
  para ambos harnesses.
- 27/27 pruebas de siembra verifican además el no-op revisionado de reconnect, drift sin escritura,
  lote OpenClaw incompleto y owner no suplantable. Protocolo pasa 29/29 casos dirigidos de
  generación, incluido marcador literal, inyección de delimitadores, CRLF, cardinalidad y las
  cuatro formas de solapamiento A/B.
- 2/2 casos de la saga Gateway —52/52 junto con rutas y runtime—: Claude y OpenClaw reproyectan dos
  revisiones y la ruta solo avanza
  con evidencia exacta suministrada al doble de Store. La prueba PostgreSQL existente verifica que
  el ACK real registra adopción y avanza `applied_revision` atómicamente
  (`packages/store/test/agent-profile-runtime-adoption-postgres.test.ts:117-150`).
- El barrido dirigido combinado cerró 123/123: 15 nativas, 27 de siembra, 29 de protocolo y 52 de
  Gateway, además de una revisión adversarial final sin bloqueantes.
- El paquete Gateway completo queda verde con 31 ficheros y 472/472 pruebas.
- El gate global se ejecutó antes de cada commit de código como usuario `stev`, con `umask 022` y
  el comando exacto `pnpm typecheck && pnpm lint && pnpm test:unit`. Para `6ea006e`: typecheck y
  lint verdes, adapter 682/682, MCP 9/9, Console 1,348/1,348 y raíz/protocolo 353/353. Para
  `c483075`: typecheck y lint verdes, adapter 683/683, MCP 9/9, Console 1,348/1,348 y
  raíz/protocolo 353/353. Para `c09c67c`: typecheck y lint verdes, Adapter 689/689, MCP 9/9,
  Console 1,348/1,348 y raíz/Protocol 362/362. `lint:calidad` cerró verde en los tres; conservó
  solo dos avisos preexistentes. La corrida final se serializó por paquete para no competir por
  memoria con otros gates del host, sin omitir ni alterar ninguna suite.

La trazabilidad publicada de la ronda es: diagnóstico `2a787aa`, investigación nativa `081ff8a`,
diseño `387771f`, implementación default-off `6ea006e` y cierre adversarial de proyección/adopción
`c483075`, más el marcador durable y el cierre de reconnect `c09c67c`. Todos fueron empujados a
`origin/main` inmediatamente después de su commit.

El cambio de scheduling destapó dos defectos de hermeticidad existentes y se cerraron sin relajar
producción: el timer que resuelve el techo de cola permanece referenciado hasta que termina el
wait, y el test de `CliTmux` admite el caso correcto en que el timeout mata al intérprete antes de
que llegue a escribir su PID. Las pruebas correspondientes pasan 4/4 y 1/1.

### Ahorro medido en los alias de interés

Este es el delta exacto entre los dos `protocolPrompt()` sobre entregas reales; no incluye pedido,
metadata ni origen, que siguen presentes en ambos caminos.

| Alias / harness | Bytes retirados de stdin | Puntos de código | Tokens estimados |
|---|---:|---:|---:|
| zeus / Claude | 8,537 | 8,491 | 2,123 |
| gaia / OpenClaw | 8,614 | 8,566 | 2,142 |
| hegel / OpenClaw | 8,240 | 8,194 | 2,049 |
| heraclito / OpenClaw | 8,234 | 8,188 | 2,047 |
| iza / OpenClaw | 8,619 | 8,573 | 2,144 |
| janus / OpenClaw | 8,625 | 8,579 | 2,145 |
| jarvis / OpenClaw | 8,571 | 8,525 | 2,132 |

El rango OpenClaw observado es 8,234–8,625 bytes, unos 2,047–2,145 tokens estimados. Una entrega
`agent.response` agrega 932 bytes de reglas dinámicas tanto al camino legacy como al nativo, por
lo que ese bloque se cancela al calcular el delta. Argos y Tales no tuvieron una entrega reciente
equivalente que permitiera publicar otra cifra real sin inventarla.

### Bloqueantes descubiertos para la ventana

**Hoy no se puede activar ningún alias.** El código queda correctamente apagado por defecto, pero
hay cuatro prerrequisitos operativos fuera de la zona de esta ronda:

1. El supervisor no admite `CAUCE_NATIVE_PROFILE_CONTEXT` en su allowlist ni lo exporta a
   `/usr/bin/env -i` (`ops/scripts/container-adapter-supervisor.sh:175-195,868-925`). El editor
   seguro tampoco lo admite (`ops/scripts/update_alias_lib.py:43-89`) y el generador no lo escribe
   (`ops/scripts/generate-container-units.py:180-244`). Ponerlo a mano hoy haría fallar el parse o
   lo descartaría antes del proceso.
2. Las generaciones no son iguales. El supervisor genera 64 hex de
   `id\0started\0restart\0init_starttime`
   (`container-adapter-supervisor.sh:478-486`); el launcher que alimenta la expectativa genera 32
   hex de `id|started|restart` (`ops/pty-agent/cauce-pty-launcher.sh:139-155`). El preflight falla
   cerrado hasta que ambos propaguen exactamente la misma generación.
3. Producción sigue en la migración 024 y el árbol aún no contiene `ops/flota.json`; faltan
   026/028/035 y la conmutación K2 del inventario de 14 alias antes de poder publicar expectativas.
4. Iza y Janus comparten `claw-miguel`, `/home/claw` y el mismo workspace. Zeus usa una TUI Claude
   longeva. No se puede afirmar recarga nativa en ninguno de esos tres sin aislar workspace o
   recrear/cambiar el transporte.

Tras resolverlos, los primeros canarios elegibles son Argos, Gaia, Hegel, Heraclito, Jarvis y
Tales en OpenClaw. Iza y Janus quedan bloqueados hasta separar workspace. Zeus solo es elegible en
Claude headless, sin `CAUCE_SHARED_SESSION`. Atlas, Kant, Kratos, Salva y Socrates siguen en Codex
y están deliberadamente fuera de este opt-in.

### Lista exacta para activar en la ventana

1. Aplicar migraciones hasta 035; ejecutar K2 y reconciliar/regenerar la flota de 14.
2. Añadir el flag al editor, generador, allowlist y entorno limpio del supervisor; unificar la
   fórmula de generación y probar que delivery, expectativa y runtime publican el mismo valor.
3. Mantener Iza/Janus apagados salvo que se les asigne workspace exclusivo; mantener Zeus apagado
   mientras use TUI compartida.
4. Desplegar el código con el flag ausente en todos los alias y comprobar comportamiento legacy.
5. Para un canario OpenClaw elegible, con el flag todavía apagado y el alias en reposo, hacer un PUT
   idempotente. Verificar perfil no vacío, B proyectado, marcador canónico igual a `revision`,
   expectativa 035 actual y margen para A bajo los topes. Un reconnect previo a activar solo debe
   acreditar el no-op exacto de la siembra, nunca reescribirlo.
6. Configurar `CAUCE_NATIVE_PROFILE_CONTEXT=1`, reiniciar solo ese adaptador y confirmar que la
   siembra legacy no corre. Volver a comparar `generation` del proceso reiniciado con la
   expectativa; si cambió, repetir el PUT antes de entregar.
7. Enviar una primera entrega controlada. Esta converge A y debe ejecutar con puntero. Si A ya era
   exacto y la generación no cambió, esa misma entrega puede acreditar adopción; si A se creó o
   cambió, su nuevo SHA deja vencida la expectativa anterior.
8. Solo cuando A cambió —o la generación exigió renovar la foto—, hacer un PUT idempotente para
   releer A+B, renovar la expectativa y enviar una segunda entrega. Verificar ACK `done` con
   `profile_adoption` exacta y ausencia de A/B en el stdin observado.
9. Verificar por GET que el ACK ya dejó `applied_revision == revision`; recién entonces devolver
   tráfico normal al alias.
10. Repetir alias por alias. Para rollback inmediato, fijar el flag a `0` o retirarlo y reiniciar
    el adaptador: vuelve la corrección del prompt legacy y la siembra por `hello_ack` verifica la
    proyección revisionada sin cambiarla. A/B permanecen activos en los ficheros; en headless A
    vuelve también al stdin y puede repetirse parte del rol, pero no se inyecta necesariamente B
    completo. Si esa verificación ve drift, el reconnect falla cerrado. No borrar bloques a ciegas;
    retirar A solo con una operación dedicada, owner comprobado y alias quiescente.

Queda una frontera conservadora: el intent durable precede la última relectura de disco. Un crash
en ese intervalo puede dejar intent sin llamada al proveedor; la quietud del alias reduce esa
ambigüedad. La comparación previa a escritura tampoco es un CAS atómico del kernel: otro escritor
puede entrar entre comparación y `ftruncate`. Por eso publicación y activación deben ocurrir con
el alias quiescente. Una edición de `MEMORY.md` o `HEARTBEAT.md` durante el turno no invalida el
perfil autorado, pero sí retiene la adopción exacta hasta una expectativa nueva.
