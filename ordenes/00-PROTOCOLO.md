# Protocolo de trabajo en `dev` — varias instancias, cero colisiones

Lo lee TODA instancia antes de tocar nada. Qué falta y por qué: `docs/roadmap.md`. Procedimientos operativos: `docs/operacion.md` y `ops/runbooks/*.md` (incluye `ops/runbooks/ventana-primer-despliegue.md` para la próxima ventana de despliegue).

## Una sola verdad de trabajo: `dev`; `main` es publicación

- **Todo el trabajo va DIRECTO a `dev`. Prohibido crear ramas de tarea.** `main` representa lo publicado y sólo el dueño puede integrarlo o empujarlo con autorización explícita. Si un experimento da miedo en `dev`, se consulta al dueño antes; no se abre una rama "por si acaso".
- Las ramas históricas están archivadas. Recrear una sólo para recuperar un commit puntual requiere al dueño y se elimina en el momento; no vuelve a convertirse en carril de trabajo.

## Convivir en `dev` sin pisarse (esto sustituye a las ramas)

Todas las instancias comparten un único checkout del repo en `dev`. Las reglas que evitan el choque:

1. **Propiedad por sector** (tabla abajo) — es LA protección principal. Prohibido tocar un fichero fuera de tu sector; si tu tarea lo exige, se pide al integrador — no se toca "de paso".
2. **`git add` solo por rutas propias.** PROHIBIDO `git add -A`, `git add .` y `git commit -a`: barren el trabajo a medias de otra instancia. Se añade fichero a fichero (o por directorio propio).
3. **Commit pequeño e inmediato** tras el gate: nada de acumular horas de cambios sin commitear en el árbol compartido.
4. **Gate ANTES de cada commit** que toque código: `dev` nunca queda en rojo. Commits que solo tocan `.md` no requieren gate completo.
5. Si `git commit` falla por lock o el árbol cambió bajo tus pies: espera y reintenta; nunca hagas `reset`/`checkout` sobre ficheros que no son tuyos. **PROHIBIDO `git clean`, `git reset --hard` y `git stash` en el checkout compartido** — un clean destruye ficheros recién creados por otra instancia y un reset ajeno reescribe la historia local.
6. **Commitea SIEMPRE con pathspec: `git commit <tus rutas> -m "..."`** — así el commit incluye SOLO tus rutas aunque haya cosas ajenas staged en el índice compartido. `git commit -m` a secas se lleva TODO el índice, incluido trabajo ajeno a medias o sin gate. `git diff --cached --stat` antes, para saber qué hay.
7. **Nunca dejes nada staged sin commitear al terminar tu turno** — un stage huérfano es una mina para el siguiente commit de cualquiera.

| Sector | Dueño | Revisor |
|---|---|---|
| `console/**` | `<instancia>` | `<otra-instancia>` |
| `services/terminal-relay/**`, `services/telegram-bridge/**` | `<instancia>` | `<otra-instancia>` |
| `packages/store/src/**`, `services/gateway/src/**`, maquinaria de release de `ops/scripts/` + sus tests | `<instancia>` | `<otra-instancia>` |
| Higiene de disco, `docs/`, residuos, verificaciones mecánicas | `<instancia>` | `<otra-instancia>` |
| `ops/pty-agent/**` (agente+launcher+tests), `tests/**` (estructura y suites generales) | `<instancia>` | `<otra-instancia>` |
| `packages/protocol/**`, `packages/mcp-fleet-monitor/**`, `ops/scripts/**` (utilidades vivas), `ops/tests/**`, `ops/harness/**` | `<instancia>` | `<otra-instancia>` |
| `packages/adapter-sdk/**`, `ops/schemas/**` | `<instancia>` | `<otra-instancia>` |
| `services/dispatcher/**`, `ops/runbooks/**` | `<instancia>` | `<otra-instancia>` |
| `scripts/**` (tooling: calidad, grafo, test-all), `ops/{systemd,generated,manifests,observability,config,guardias,container-runtime,openclaw-gateway,cli,instances,patches,private,telegram-runtime}/**` | `<instancia>` (+dueño donde toque flota) | dueño |
| `ordenes/`, `ordenes-locales/`, documentación (README/CLAUDE.md/AGENTS.md), integración de merges, despliegue/flota/BD | `<instancia>` + dueño | dueño |
| `packages/store/migrations/**`, `deploy/**`, `/etc/cauce-v3`, `/opt`, contenedores, systemd, base de datos | NADIE sin el dueño presente | — |

El reparto concreto de sectores entre instancias se fija por ronda y no vive en esta tabla; lo que no cambia es la forma: cada sector tiene UN dueño de escritura por ronda y un revisor que no es su dueño, y una instancia puede sostener varios sectores.

## Reglas de todo commit (sin excepción)

1. Gate antes de commit: `pnpm typecheck && pnpm lint && pnpm test:unit` en verde — test:unit es GLOBAL (consola incluida). La flota, el gate y el CI nocturno corren como root. Sólo `pnpm qa:runtime-packaging` exige usuario normal porque valida ownership; no se cablean otras guardias anti-root ni se chownea el árbol para ocultar un rojo.
2. `git mv` en commits separados de ediciones de contenido. Commits ≤20 ficheros salvo mv mecánico.
3. Prohibido: comentarios narrativos, fechas o "incidentes" en el código; planes nuevos >100 líneas; declarar "hecho" sin pegar la salida del gate.
4. Mensajes de commit: qué y por qué en ≤5 líneas, sin épica.
5. Ningún `*.patch`, SQL de migraciones, ni nada de la fila NADIE.

## Subagentes: sí, con disciplina

Todos los harness de la flota los soportan — **úsalos** para agilizar lo paralelizable (barridos, renombres masivos, verificaciones, extracciones módulo a módulo). Reglas:

1. **Ficheros disjuntos por subagente** — un fichero tiene UN dueño por ronda. Reparte por fichero/directorio ANTES de lanzar, por escrito en el prompt de cada uno.
2. **Tope de concurrencia por instancia**: 4 subagentes; por encima de eso los harness dan rate limit. El tope va EXPLÍCITO en cada orden o la instancia no usa ninguno. Profundidad 1 (un subagente no lanza subagentes).
3. **Solo el proceso principal commitea.** Los subagentes editan y reportan; el padre revisa, pasa el gate y hace el commit. Nunca dos procesos commiteando a la vez.
4. Los subagentes heredan TODO este protocolo: sector de su instancia, NO-TOCAR, sin ramas, sin `add -A`, sin comentarios narrativos.
5. Si un subagente reporta "hecho" sin evidencia (salida de comando, diff), su trabajo se verifica antes de commitear.

## Modo de sesión por instancia

- **Sesión NUEVA por cada orden** (el dueño hace `new`) para las instancias que no conservan contexto útil entre órdenes: la orden es autocontenida — arranque = pull + protocolo + la orden — y qué está hecho se verifica con comandos, nunca confiando en memoria.
- **Sesión larga persistente** para las instancias a las que re-leer el contexto les cuesta mucho: su orden se mantiene estable hasta cerrarla.

## Al terminar cada tarea

1. `git push origin dev` y dejar el checkout en `dev`. Prohibido cambiar o publicar `main` sin autorización explícita del dueño.
2. Reportar en 5 líneas máximo: commits hechos (hashes), gate (pegado), qué quedó fuera y por qué. Sin ensayos.

## Credenciales de la flota: `ops/private/credentials/` — REGLA DURA
Carpeta ignorada por git (solo su README va en git): copias de trabajo de credenciales que dan autonomía real a los agentes. **PROHIBIDO para toda instancia, agente y subagente: borrar, mover, renombrar, vaciar o reescribir cualquier fichero ahí dentro** — ni con `rm`, ni con `git clean`/`reset` (ya prohibidos), ni con `git add -f`. Es la ÚNICA excepción a la regla "todo vive en git": por diseño NO vive en git, así que borrarla es pérdida total e irrecuperable. Solo el dueño añade, rota o retira ficheros; las instancias pueden LEER lo que sus permisos les dejen. `/etc/cauce-v3` sigue siendo la fuente productiva (fila NADIE).
