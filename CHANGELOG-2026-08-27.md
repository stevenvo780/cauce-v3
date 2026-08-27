# 2026-08-27 — el día de la purga

Un solo día, **207 commits**, cuatro instancias de IA trabajando en paralelo sobre el mismo checkout y un dueño decidiendo. El árbol quedó en **269.404 líneas** (medidas con `git ls-files | xargs wc -l` al cerrar esta nota; sigue bajando mientras las instancias cierran): se borraron 148.723 y se escribieron 81.594, con un neto de **−67.129 líneas**. No fue una limpieza cosmética: se borró todo lo que no estaba en producción y se demostró, contra un clon real, que el despliegue funciona.

Para ver cualquier cosa de las que se borraron: `git log --diff-filter=AD -- <ruta>` y `git show <hash>:<ruta>`. Todo está también en el bundle `/datos/workspaces/zeus/cauce-v3-archivo-completo-20260827.bundle`.

---

## Lo que se decidió (y cambió cómo se trabaja)

- **Todo va directo a `main`. Prohibido crear ramas.** En este repo las ramas fueron el cementerio: el 40% del trabajo se pudrió fuera de main. Se archivaron y borraron **146 ramas locales, 134 remotas y 75 worktrees**; hoy quedan 4 refs y 1 worktree.
- **Git es el archivo. No existen carpetas de cuarentena ni de bitácora.** Se probaron las dos y las dos se borraron el mismo día: `_legado/` (185 ficheros, −59.417 líneas) y `docs/bitacora/` (80 ficheros, −7.003 líneas). Lo histórico se consulta en git, no en el árbol.
- **Propiedad por sector, `git add` solo por rutas propias, commit siempre con pathspec.** Las tres reglas nacieron de daños reales del mismo día: un `git clean` destruyó dos veces ficheros recién creados de otra instancia, y un `git commit -m` a secas se llevó trabajo ajeno del índice compartido tres veces, una de ellas sin pasar el gate.
- **Prohibido `git clean`, `git reset --hard` y `git stash`** en el checkout compartido.
- **Subagentes sí, con disciplina**: ficheros disjuntos por subagente, tope 4 por instancia, profundidad 1, y solo el proceso principal commitea. La auditoría había medido subagentes declarando «1091 tests pasan» cuando fallaban 53 ficheros.

## Auditoría: qué había de verdad

- **Censo de 208 ficheros con refutación**: 29 muertos confirmados, 45 dudosos elevados al dueño. Nada se movió por sospecha; cada veredicto exigía evidencia.
- **Censo simbólico de ~2.000 exports**: solo 31 para borrar y 21 borrables-con-su-test. **A nivel de función el repo estaba sano**; el problema era estructural, no de código muerto disperso.
- **Censo de comentarios v2**: 2.322 líneas de comentario borrables, localizadas por fichero. El hallazgo incómodo: la mayoría de la densidad de comentarios era invariante legítimo, y el ruido real estaba concentrado en pocos ficheros — narrativa de incidentes con cifras («881 entregas», «197 entregas de producción», «148 repeticiones») que las sesiones frescas leían como estado ACTUAL del sistema.
- **Grafo de dependencias determinista** (`pnpm grafo`): al arreglar que resolvía sin `.tsx`, los huérfanos cayeron de 105 a 35. La primera cifra era falsa por un bug del generador, no por código muerto.
- **Auditoría de dientes de la suite**: 353 ficheros de test, 3.644 tests, 11.699 asserts. Cero tests sin asserts, cero snapshot-only, cero skips duros. Los agujeros reales: 14 tests que solo corren si hay `tmux`, 8 con un matcher que no distingue acierto de fallo, 233 que afirman sobre el texto de un fichero en vez del comportamiento — y **`test:unit` deja 1.140 de los 3.644 tests fuera del gate por commit**.
- **Caza de duplicados**: 51 grupos, ~2.250 línea-ocurrencias. El mayor: `ops/cli/cauce` y `ops/guardias/cauce-kratos.sh` son **el mismo fichero de 565 líneas** con 11 líneas de comentario de diferencia. Ocho grupos ya habían divergido y son bugs latentes (un `stringField` de seis copias donde una acepta cadena vacía; `valid_alias` escrito 17 veces con tres alfabetos distintos).
- **Matrices de test pesadas ejecutadas de verdad**: terminal-pty y services verdes; store-hardening 581/601; los rojos diagnosticados uno a uno resultaron ser **arnés preexistente (downgrade contra la 037, flaky de contenedor), cero de producto**.

## Purga: lo que se borró

- **`_legado/` completo**: −59.417 líneas en 185 ficheros. Antes de borrarse había recibido, por oleadas, todo lo que nunca se usó en producción: relay-worker, shadow-router, la maquinaria de release sintética, seis schemas sin consumidor, cinco tests huérfanos sin runner, cuatro scripts sin invocador.
- **`docs/bitacora/`**: −7.003 líneas. Se creó por la mañana para el material histórico fechado y se borró por la tarde al aplicar la misma regla que a `_legado`.
- **`ops/`: −52.417 líneas** — la zona más reducida del día, con diferencia. Se retiró el soporte `authentic` de compose, fault-compose y systemd, y se validan solo las unidades container rootless que están vivas.
- **`tests/`: −14.507 líneas.** Se separó cobertura viva de cobertura de release retirada, y la guardia de SQL volvió a ver TODO el store (era recursiva sobre `repository/` y se había quedado ciega).
- **`packages/protocol`: −2.816 líneas** con solo +155: casi todo era borrado limpio.
- Se retiraron `TopologyPage` y el HyperGraph muerto de la consola, y 160K de reportes ya consumidos.
- **−1.099 líneas de comentario narrativo y ceremonial** en siete pasadas quirúrgicas (consola −185, −203, −271, −231; telegram-bridge −37, −37; gateway −26). Quirúrgicas de verdad: cada pasada se hizo con la tabla del censo, no con un barrido masivo — porque el barrido masivo anterior (`2a22107`) había dejado frases mutiladas que hoy hay que reparar a mano.

## Particiones: los monolitos abiertos

**39 commits** de partición o extracción. Todo por responsabilidades, con el `git mv` en commits separados de las ediciones de contenido:

- **`packages/store`**: la fachada del repositorio se vació módulo a módulo — cuotas, observabilidad, cola de trabajos, outbox y fencing, mensajería, entregas, agentes y perfiles, materialización fan-in, control de cadenas, notificaciones proactivas, política de observabilidad, control de entregas, jerarquía.
- **`services/gateway`**: rutas core, rutas de consola, rutas de salud, control de sesiones terminal, proxy de relay terminal, sondas de gobierno, soporte compartido de rutas, contratos de readiness, y las rutas legado-candidatas aisladas para poder juzgarlas.
- **`packages/adapter-sdk`**: estado, engine, sesiones, parsing, arneses, entregas y `shared-session/session` bajo 800 líneas.
- **`apps/console`**: `styles.css` dividido por áreas con imports, `OperatorWorkspace` y `live.css` por responsabilidades, `pty-session`, `DirectivaModal` por capas, cliente, mocks, estilos de xterm, los tipos monolíticos y el layout del hipergrafo. Más una vista `/ayuda` nueva.
- **`ops`**: `rollout-pty` y `update-alias-config` partidos byte-a-byte bajo 800 líneas.
- Suites de test partidas bajo 600 líneas: terminal-pty, terminal-relay, telegram-bridge, consola.

Quedan **20 ficheros por encima de 800 líneas**, casi todos tests (`shared-session.test.ts` con 5.454 es el mayor del árbol) y los dos grandes de `ops/pty-agent` y `ops/container-runtime`.

## Tooling: frenos mecánicos para que no vuelva a pasar

- **Primer CI del repo en `main`** (GitHub Actions, Node 22, pnpm 11.8): job de typecheck + lint, y un segundo job paralelo de `pnpm test:unit` + `test:pty`.
- **Gate determinista de calidad con trinquete** (`scripts/calidad.mjs` + `calidad-base.json`): el tamaño de los ficheros existentes solo puede bajar. Se extendió el trinquete a la **densidad de comentarios** — los existentes solo bajan, los nuevos no pasan del 15%. Cada borrado baja el techo solo, y ningún fichero puede recrecer.
- **`test:unit` es global desde hoy** e incluye la consola (114 ficheros, 1.368 tests verdes en la última corrida).
- **Grafo de dependencias** reproducible (`pnpm grafo` → `docs/grafo.md`).
- **`test:pty`** incorporado al gate, con la suite del pty-agent blindada y sus listas fijadas por literal.
- El digest operativo dejó de exigir ficheros que se habían movido (runbooks, bridges de rollback) — dos roturas de gate causadas por las propias mudanzas del día, arregladas en el día.

## Documentación: la que se puede verificar

- **`AGENTS.md` / contexto de repo para las IA constructoras**, y `CLAUDE.md`/`GEMINI.md` reducidos a punteros: una sola identidad, no tres versiones divergentes.
- **Los 14 runbooks vivos verificados contra el sistema real** y reescritos los 13 al mismo formato de cuatro secciones. La verificación encontró 6 correcciones quirúrgicas necesarias (relay-worker, shadow-router, zeus, dual-stack V2/V3, QA rota).
- **Los 6 ADR verificados** contra el sistema real.
- **`docs/mapa-de-ficheros.md`** y una guía de lectura de la arquitectura para humanos.
- Cinco barridos de enlaces: cada mudanza rompía rutas en la documentación y cada rotura se reparó el mismo día.

## FASE 3: el ensayo general

- **Dossier de despliegue verificado**: de 12 migraciones sospechosas, **12 refutadas**; compose canónico único; kill-list de PTY; código pre-ventana identificado.
- **Ensayo general ejecutado contra un clon** (nunca contra producción): **migración en 2,4 s**, ruptura provocada y rollback verificado, consola horneada con el editor dentro.
- El ensayo reveló un hallazgo que el papel no tenía: **D1 es DOBLE** — la migración 029 también da de alta a los cuatro agentes de Pablo. Un dato que solo aparece ejecutando.
- **Producción sigue en la migración 024 y no se tocó** en ningún momento del día: ni un reinicio, ni una escritura en su base.
- Se acordó la secuencia de cierre con el dueño: las instancias cierran sus sectores → rutas cortas pre-deploy → decisiones pendientes → **PRIMEROS DESPLIEGUES** → cirugía de dominios después. Y `PENDIENTES-DEL-DUEÑO.md` pasó a formato pregunta + Respuesta, para que cada decisión quede justificada con sus matices en vez de resuelta por omisión.

---

## Los números del día

| | |
|---|---:|
| commits | 207 |
| ficheros tocados (suma de commits) | 1.729 |
| líneas escritas | +81.594 |
| líneas borradas | −148.723 |
| **neto** | **−67.129** |
| ficheros borrados (rutas únicas) | 299 |
| ficheros creados (rutas únicas) | 305 |
| ramas archivadas y borradas | 146 locales + 134 remotas |
| worktrees eliminados | 75 |
| commits de partición o extracción | 39 |
| líneas de comentario narrativo borradas | 1.099 |
| árbol al cerrar esta nota | 269.404 líneas |
| tests de la consola en verde | 1.368 / 1.368 |
| ficheros aún por encima de 800 líneas | 20 |
| migración de producción | 024, intacta |

El repo había quemado ~120B tokens en agosto porque los agentes escribían features completas y las declaraban hechas sin desplegarlas ni probarlas contra el sistema real, y porque el fan-out sin dueño por fichero produjo hasta **10 versiones paralelas del mismo archivo**. El 27 de agosto se cerró ese patrón: un solo `main`, un dueño por sector, un gate que no se puede aflojar, y un despliegue demostrado contra un clon antes de tocar la flota.
