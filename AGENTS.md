# Contexto del repositorio para agentes

Cauce V3: bus de mensajería durable y multi-tenant entre agentes de IA en CLI (Claude Code, Codex, OpenClaw), con consola web de operador y puente Telegram. PostgreSQL es la única fuente durable; el gateway expone HTTP/WS; la entrega es *pull* — el adapter de cada agente reclama sus entregas con fencing (`claim_token`+`epoch`). El `dispatcher` no reparte nada: es el segador de reintentos.

**El árbol de este repo ES material de producción.** Prometheus, OTel y postgres montan ficheros directamente desde aquí. `main` es la línea publicada, el último commit desplegado se consulta en `deploy/HISTORIAL.md` y `dev` es el carril de integración. No es un entorno de desarrollo aislado.

## Dónde está cada cosa

| Doc | Qué responde |
|---|---|
| `docs/doctrina-del-dueno.md` | el criterio detrás de las reglas: qué exige el dueño y por qué |
| `docs/arquitectura.md` | cómo está construido el sistema hoy — si solo lees un documento, que sea este |
| `docs/operacion.md` | cómo desplegar, dar de alta/baja un agente, diagnosticar, hacer backup |
| `docs/roadmap.md` | qué falta, priorizado |
| `docs/flota-y-participantes.md` | máquinas, humanos, los 15 agentes, los 5 escenarios esenciales |
| `ops/flota.json` (+ `docs/arquitectura.md` §4) | la flota como datos: el snapshot canónico del que se generan alias, contenedores y manifests |
| `ordenes/00-PROTOCOLO.md` | cómo conviven varias instancias en `dev` sin pisarse — LÉELO antes de tocar nada |

Referencia adicional: `docs/adr/` (decisiones de diseño aceptadas), `docs/threat-model.md` (amenazas y controles), `docs/grafo.md` (mapa de dependencias, generado con `pnpm grafo`), `docs/consola.md` (consola web del operador), `docs/telegram.md` (puente Telegram), `docs/adapter-sdk.md` (SDK del consumidor durable), `docs/calidad-y-gates.md` (sistema de calidad y gates).

## Regla 0

**El código muerto se BORRA con `git rm`, nunca se archiva.** Git es el archivo: todo lo histórico vive en `git log` / `git show` (`--diff-filter=AD` para lo borrado). No existen carpetas de cuarentena ni bitácoras de lo retirado.

## Reglas duras del dueño (detalle y porqué: `docs/doctrina-del-dueno.md`)

- **Efecto demostrado.** Nada está "hecho" sin pegar la salida del gate; un despliegue no está hecho sin mostrar el efecto real contra el sistema vivo.
- **Revisor ≠ autor.** Todo sector tiene un dueño de escritura por ronda y un revisor que no es su autor; ninguna instancia se autoaprueba.
- **Ramas propias para revisión; integración autorizada.** Se permiten commits y PR abiertos y listos para revisión en ramas propias con pruebas pendientes explícitas según `docs/calidad-y-gates.md`. En el checkout compartido de `dev`, convivencia por sector + `git add` solo de rutas propias + commit siempre con pathspec, nunca `-a` ni `add -A`. Los merges a `dev` o `main` quedan reservados a Steven o el agente que él autorice expresamente para integrar o desplegar; publicar un PR no autoriza integrar ni desplegar.
- **Usuarios de ejecución.** Cada alias conserva el usuario de `ops/flota.json`: `dev`, `claw`, `ubuntu` o `server` según el entorno. Los supervisores usan `placement.systemdUser` o el valor predeterminado `stev`. No cambiar propietarios de perfiles o sesiones para acomodar un gate. El CI de root usa un worktree desechable; los builds del workspace usan su propietario. `pnpm qa:runtime-packaging` exige usuario normal.
- **GitHub Actions prohibido.** El gate completo corre en el propio host (`cauce-v3-ci-local.timer`), no en un servicio pagado.
- **Idioma: `.md` en español, código en inglés.** Identificadores y comentarios exportados en inglés; toda la documentación de proyecto en español.
- **Comentarios sin narrativa, sin fechas, sin nombres.** Solo restricciones que el código no puede expresar por sí solo. Lo que se poda: funciones sin propósito claro, sin nombre que describa qué hacen, repetidas en vez de reutilizadas, sin patrón de organización consistente, sobre-ingeniería innecesaria.
- **Migraciones que contaminan se borran enteras**, con su `down` y su suite — no se parchean.
- **Credenciales jamás se tocan fuera del dueño.** `ops/private/credentials/` está ignorada por git a propósito; ninguna instancia ni subagente borra, mueve o reescribe nada ahí dentro.

## Sectores (zonas de escritura completas y reglas de convivencia: `ordenes/00-PROTOCOLO.md`)

Cada directorio tiene UN dueño de escritura por ronda; tocar algo fuera del sector propio se pide al integrador, nunca "de paso". Zonas de escritura: `console/**` y `services/{terminal-relay,telegram-bridge}/**`; `packages/store/src/**` + `services/gateway/src/**` + release de `ops/scripts/`; `docs/`, higiene de disco, verificaciones mecánicas; `ops/pty-agent/**` + `tests/**`; `packages/{protocol,mcp-fleet-monitor}/**` + utilidades vivas de `ops/scripts|tests|harness`; `packages/adapter-sdk/**` + `ops/schemas/**`; `services/dispatcher/**` + `ops/runbooks/**`; `scripts/**` + el resto de `ops/` (systemd, generated, manifests, observability, config, guardias, container-runtime, cli, patches, private); `ordenes/`, documentación raíz, integración de merges y despliegue/flota/BD (con el dueño). El revisor de un sector es siempre otra instancia, nunca la que escribió.

## Gates

Gate requerido para integrar código: `pnpm typecheck && pnpm lint && pnpm test:unit`, en verde. `pnpm test` (`scripts/test-all.mjs`) es el gate completo. Los commits y PR abiertos y listos para revisión en ramas propias pueden publicarse con gates pendientes o fallidos, declarando su estado y evidencia exacta; no acreditan trabajo listo para integrar o desplegar. Antes de integrar o desplegar deben estar verdes todos los gates requeridos. Quien integra o despliega es responsable de ejecutarlos y verificar la evidencia del código exacto que integra o despliega, incluido el gate completo y los gates de release aplicables antes del despliegue. `ops/scripts/validate.sh` valida sintaxis de `ops`+`deploy`, `shellcheck`, YAML/JSON Schema de manifiestos, y la identidad byte a byte de lo generado desde `ops/flota.json` — obligatorio tras tocar cualquier cosa de la flota. `scripts/calidad.mjs` aplica el trinquete de líneas por fichero, fechas y comentarios (solo puede bajar).

## NO TOCAR (sin excepción)

`packages/store/migrations/**` (se borran enteras, no se editan) · cualquier `*.patch` · ejecutar `deploy/deploy.sh` o `docker compose` contra producción sin el dueño · `/etc/cauce-v3` · `/opt` · la base de datos productiva · contenedores y unidades systemd · `ops/private/credentials/` y cualquier secreto o credencial.

## Cómo se trabaja

1. Para revisión mediante PR, usa una rama propia en un checkout aislado. Si trabajas en el checkout compartido de `dev`, `git pull --ff-only origin dev` antes de empezar; el árbol es compartido en tiempo real por varias instancias.
2. Trabaja SOLO en tu sector. `git add` fichero a fichero o por directorio propio — nunca `git add -A` ni `git add .`.
3. En el checkout compartido de `dev`, gate en verde antes de cada commit que toque código (commits solo-`.md` no lo requieren). En ramas propias se permite commitear y publicar PR abiertos y listos para revisión con pruebas pendientes explícitas; consulta `docs/calidad-y-gates.md`.
4. `git mv` en commits separados de cualquier edición de contenido. Commits ≤20 ficheros, uno por tarea, e inmediatos: nada de acumular horas sin commitear en el árbol compartido.
5. Commitea SIEMPRE con pathspec — `git commit <tus rutas> -m "..."` — nunca `git commit -a` ni `-m` a secas: se lleva el índice completo, incluido trabajo ajeno staged.
6. Nada está "hecho" sin la evidencia pegada: salida real del gate, o el efecto verificado contra el sistema vivo.
7. Subagentes: úsalos para lo paralelizable, ficheros DISJUNTOS por subagente, tope 4, profundidad 1; solo el proceso principal commitea. Detalle: sección "Subagentes" de `ordenes/00-PROTOCOLO.md`.
8. Al terminar una tarea, publica únicamente tu rama propia y deja el PR abierto y listo para revisión; reporta en ≤5 líneas (commits, estado y evidencia de gates, qué quedó fuera). En el checkout compartido, deja el checkout en `dev` y publica sólo trabajo autorizado. Sólo Steven o el agente que él autorice expresamente para integrar o desplegar hace merges a `dev` o `main`; integrar o desplegar exige los gates requeridos en verde.
