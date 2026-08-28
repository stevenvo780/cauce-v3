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
3. **Lectura y publicación.** Store hace CAS del perfil y une permisos, cuotas, arnes y destinos
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
