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
  adjuntando un `runtime_profile` medido en cada turno y el fichero gestionado no identifica la
  revisión autorada. Esas son las dos brechas que cierra esta ronda detrás de un flag.

### Flujo completo existente en `main`

1. **Autoría y fencing en PostgreSQL.** La 026 crea `agent_profiles`, define los siete campos
   autorados y copia literalmente el `agents.role_brief` existente
   (`packages/store/migrations/026_agent_profile.sql:139-221,223-235`). La 028 convierte
   `role_summary` en fuente canónica, agrega `revision/applied_revision` y hace que el trigger
   avance la revisión cuando cambia contenido
   (`packages/store/migrations/028_canonical_agent_role.sql:25-78`). La 035 separa expectativa de
   bytes y adopción conductual de una entrega real cercada
   (`packages/store/migrations/035_agent_profile_runtime_adoption.sql:45-109`).
2. **Composición.** El protocolo valida el presupuesto y compone el perfil
   (`packages/protocol/src/agent-profile.ts:18-40,46-60,138-159,205-209,256-294`). La proyección
   actual distribuye Claude a `CLAUDE.md`, Codex a `AGENTS.md` y OpenClaw a siete Markdown
   (`packages/protocol/src/ficheros-del-arnes.ts:15-17,51-57,59-111,119-179`).
3. **Lectura y publicación.** Store hace CAS del perfil y une permisos, cuotas, arnés y destinos
   (`packages/store/src/agent-profile.ts:123-193,283-357`). Gateway lo lee y lo envía una vez en
   `hello_ack`, gateado por `agent_profile_v1`
   (`services/gateway/src/routes/core.ts:343-363,421-425`). El PUT de `/live` ya sigue
   preflight → desired CAS → lote de ficheros → expectativa → adopción/applied
   (`services/gateway/src/console/agent-profile.routes.ts:500-678`).
4. **Escritura dentro del runtime.** El cliente anuncia las capabilities de perfil, recibe el
   saludo y siembra antes de aceptar tráfico (`packages/adapter-sdk/src/sdk/client.ts:69-128,238-302`).
   `sembrarPerfilDelArnes()` resuelve el directorio, compone todo el lote, hace preflight y evita
   una escritura parcial (`packages/adapter-sdk/src/context/siembra-del-perfil.ts:360-415,418-509`).
5. **Cada entrega.** Engine arma identidad, rol y routing
   (`packages/adapter-sdk/src/sdk/engine.ts:361-384`). El adaptador transforma eso en stdin
   (`packages/adapter-sdk/src/harnesses/shared/adapter.ts:331-350`). `protocolPrompt()` agrega, en
   este orden: identidad y rol; deber primario; esquema de salida e invariantes; mecánica de
   delegación; `runtime_profile` opcional; metadata; origen; pedido
   (`packages/adapter-sdk/src/harnesses/shared/prompt.ts:64-78,91-208`).
6. **Por qué se repite.** Sin un sello exacto se manda todo el bloque fijo; con sello se sustituye
   por un puntero corto (`packages/adapter-sdk/src/harnesses/contexto-fijo.ts:29-35,60-65`). En una
   sesión compartida, el código deshabilita a propósito ese recorte y vuelve a leer e inyectar el
   perfil vivo en cada turno porque la TUI pudo arrancar antes que el fichero
   (`packages/adapter-sdk/src/harnesses/shared/adapter.ts:184-205,245-303`).

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
   (`packages/adapter-sdk/src/context/siembra-del-perfil.ts:12-17,360-390,418-509`; llamada en
   `packages/adapter-sdk/src/sdk/client.ts:245-301`). Claude recibe `CLAUDE.md`, Codex
   `AGENTS.md`, OpenClaw siete ficheros y Hermes ninguno
   (`packages/protocol/src/ficheros-del-arnes.ts:51-110`). En OpenClaw, `MEMORY.md` y
   `HEARTBEAT.md` se preservan y solo se crean vacíos si faltan (`:130-137`).
2. El PUT de Console ya es el publicador fuerte: prepara, verifica límites, escribe por relay,
   relee SHA/bytes/generation y registra expectativa
   (`services/gateway/src/console/agent-profile-runtime.ts:68-306`). Después espera una entrega
   que adopte esa misma revisión y solo entonces avanza `applied_revision`
   (`services/gateway/src/console/agent-profile.routes.ts:532-678`). Esta debe seguir siendo la
   única autoridad de publicación; agregar un tercer escritor produciría carreras.

Las units generadas declaran `CAUCE_SEMBRAR_PERFIL=1`, junto con HOME/config/workspace por alias
(`ops/scripts/generate-units.py:37-59` y
`ops/scripts/generate-container-units.py:193,208-243`). Pero el código fuente actual interpreta
la ausencia del valor como encendido (`CAUCE_SEMBRAR_PERFIL !== "0"`) y producción aún no lleva
ese código. La nueva omisión por mensaje debe usar otro flag, estricto y **apagado por defecto**.

Finalmente, la siembra de perfil no equivale al sello del contrato fijo. El camino legacy solo
siembra ese contrato con `CAUCE_SEMBRAR_CONTEXTO=1`; en TUI compartida se niega deliberadamente a
recortarlo porque la sesión puede haber arrancado horas antes
(`packages/adapter-sdk/src/harnesses/shared/adapter.ts:175-242`). Esa misma TUI vuelve a leer cinco
bloques autorados y crea `runtime_profile` en cada turno (`:245-304`), que `protocolPrompt()`
inyecta en `BEGIN TRUSTED RUNTIME PROFILE` (`shared/prompt.ts:189-196`). Por eso la proyección ya
existente todavía no cumple la visión del dueño.

La consecuencia operativa es distinta por modo: Claude headless y OpenClaw crean un proceso/run
por entrega y pueden observar el fichero en la siguiente; un Claude/Codex TUI persistente requiere
refresh o sesión nueva antes de retirar el bloque. Hermes one-shot también lo observaría, pero su
proyección aún es un no-op y queda fuera de esta implementación mínima.
