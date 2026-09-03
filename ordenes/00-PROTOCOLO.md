# Protocolo de trabajo en `dev` — 4 instancias, cero colisiones

Lo lee TODA instancia antes de tocar nada. Qué falta y por qué: `docs/roadmap.md`. Procedimientos operativos: `docs/operacion.md` y `ops/runbooks/*.md` (incluye `ops/runbooks/ventana-primer-despliegue.md` para la próxima ventana de despliegue).

## Una sola verdad de trabajo: `dev`; `main` es publicación

- **Todo el trabajo va DIRECTO a `dev`. Prohibido crear ramas de tarea.** `main` representa lo publicado y sólo el dueño puede integrarlo o empujarlo con autorización explícita. Si un experimento da miedo en `dev`, se consulta al dueño antes; no se abre una rama "por si acaso".
- Las ramas históricas están archivadas. Recrear una sólo para recuperar un commit puntual requiere al dueño y se elimina en el momento; no vuelve a convertirse en carril de trabajo.

## Convivir en `dev` sin pisarse (esto sustituye a las ramas)

Todas las instancias comparten el checkout `/datos/workspaces/zeus/cauce-v3` en `dev`. Las reglas que evitan el choque:

1. **Propiedad por sector** (tabla abajo) — es LA protección principal. Prohibido tocar un fichero fuera de tu sector; si tu tarea lo exige, se pide al integrador — no se toca "de paso".
2. **`git add` solo por rutas propias.** PROHIBIDO `git add -A`, `git add .` y `git commit -a`: barren el trabajo a medias de otra instancia. Se añade fichero a fichero (o por directorio propio).
3. **Commit pequeño e inmediato** tras el gate: nada de acumular horas de cambios sin commitear en el árbol compartido.
4. **Gate ANTES de cada commit** que toque código: `dev` nunca queda en rojo. Commits que solo tocan `.md` no requieren gate completo.
5. Si `git commit` falla por lock o el árbol cambió bajo tus pies: espera y reintenta; nunca hagas `reset`/`checkout` sobre ficheros que no son tuyos. **PROHIBIDO `git clean`, `git reset --hard` y `git stash` en el checkout compartido** — un clean ya destruyó dos veces ficheros recién creados de otra instancia, y un reset ajeno reescribió la historia local.
6. **Commitea SIEMPRE con pathspec: `git commit <tus rutas> -m "..."`** — así el commit incluye SOLO tus rutas aunque haya cosas ajenas staged en el índice compartido. `git commit -m` a secas se lleva TODO el índice (ya barrió trabajo ajeno tres veces, una de ellas sin gate). `git diff --cached --stat` antes, para saber qué hay.
7. **Nunca dejes nada staged sin commitear al terminar tu turno** — un stage huérfano es una mina para el siguiente commit de cualquiera.

| Sector | Dueño | Revisor |
|---|---|---|
| `console/**` | Gemini | Claude |
| `services/terminal-relay/**`, `services/telegram-bridge/**` | Gemini | Claude |
| `packages/store/src/**`, `services/gateway/src/**`, maquinaria de release de `ops/scripts/` + sus tests | Codex | Claude |
| Higiene de disco, `docs/`, residuos, verificaciones mecánicas | OpenCode/MiniMax | Claude |
| `ops/pty-agent/**` (agente+launcher+tests), `tests/**` (estructura y suites generales) | Gemini | Claude |
| `packages/protocol/**`, `packages/mcp-fleet-monitor/**`, `ops/scripts/**` (utilidades vivas), `ops/tests/**`, `ops/harness/**` | Codex | Claude |
| `packages/adapter-sdk/**`, `ops/schemas/**` | Codex | Claude |
| `services/dispatcher/**`, `ops/runbooks/**` | Gemini | Claude |
| `scripts/**` (tooling: calidad, grafo, test-all), `ops/{systemd,generated,manifests,observability,config,guardias,container-runtime,openclaw-gateway,cli,patches,private,telegram-runtime}/**` | Claude (+dueño donde toque flota) | dueño |
| `ordenes/`, `ordenes-locales/`, documentación (README/CLAUDE.md/AGENTS.md), integración de merges, despliegue/flota/BD | Claude + dueño | dueño |
| `packages/store/migrations/**`, `deploy/**`, `/etc/cauce-v3`, `/opt`, contenedores, systemd, base de datos | NADIE sin el dueño presente | — |

## Reglas de todo commit (sin excepción)

1. Gate antes de commit: `pnpm typecheck && pnpm lint && pnpm test:unit` en verde — test:unit es GLOBAL (consola incluida). La flota, el gate y el CI nocturno corren como root. Sólo `pnpm qa:runtime-packaging` exige usuario normal porque valida ownership; no se cablean otras guardias anti-root ni se chownea el árbol para ocultar un rojo.
2. `git mv` en commits separados de ediciones de contenido. Commits ≤20 ficheros salvo mv mecánico.
3. Prohibido: comentarios narrativos, fechas o "incidentes" en el código; planes nuevos >100 líneas; declarar "hecho" sin pegar la salida del gate.
4. Mensajes de commit: qué y por qué en ≤5 líneas, sin épica.
5. Ningún `*.patch`, SQL de migraciones, ni nada de la fila NADIE.

## Subagentes: sí, con disciplina

Todos los harness de la flota los soportan — **úsalos** para agilizar lo paralelizable (barridos, renombres masivos, verificaciones, extracciones módulo a módulo). Reglas, aprendidas de la quema de agosto:

1. **Ficheros disjuntos por subagente** — un fichero tiene UN dueño por ronda. Reparte por fichero/directorio ANTES de lanzar, por escrito en el prompt de cada uno.
2. **Tope de concurrencia por instancia**: MiniMax, Gemini y Codex: 4 (MiniMax con 6 da rate limit; decirle el tope EXPLÍCITO en cada orden o no usa ninguno). Profundidad 1 (un subagente no lanza subagentes).
3. **Solo el proceso principal commitea.** Los subagentes editan y reportan; el padre revisa, pasa el gate y hace el commit. Nunca dos procesos commiteando a la vez.
4. Los subagentes heredan TODO este protocolo: sector de su instancia, NO-TOCAR, sin ramas, sin `add -A`, sin comentarios narrativos.
5. Si un subagente reporta "hecho" sin evidencia (salida de comando, diff), su trabajo se verifica antes de commitear — la auditoría midió subagentes declarando "1091 tests pasan" cuando fallaban 53 ficheros.

## Modo de sesión por instancia

- **Gemini y MiniMax: sesión NUEVA por cada orden** (el dueño hace `new`). Las órdenes son autocontenidas: arranque = pull + protocolo + la orden; verificar con comandos qué está hecho, nunca confiar en memoria.
- **Codex: sesión larga persistente** (re-leer contexto le cuesta mucho); su orden se mantiene estable hasta cerrarla.

## Al terminar cada tarea

1. `git push origin dev` y dejar el checkout en `dev`. Prohibido cambiar o publicar `main` sin autorización explícita del dueño.
2. Reportar en 5 líneas máximo: commits hechos (hashes), gate (pegado), qué quedó fuera y por qué. Sin ensayos.

## Credenciales de la flota: `ops/private/credentials/` — REGLA DURA
Carpeta ignorada por git (solo su README va en git): copias de trabajo de credenciales que dan autonomía real a los agentes. **PROHIBIDO para toda instancia, agente y subagente: borrar, mover, renombrar, vaciar o reescribir cualquier fichero ahí dentro** — ni con `rm`, ni con `git clean`/`reset` (ya prohibidos), ni con `git add -f`. Es la ÚNICA excepción a la regla "todo vive en git": por diseño NO vive en git, así que borrarla es pérdida total e irrecuperable. Solo el dueño añade, rota o retira ficheros; las instancias pueden LEER lo que sus permisos les dejen. `/etc/cauce-v3` sigue siendo la fuente productiva (fila NADIE).
