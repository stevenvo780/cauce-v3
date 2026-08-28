# Contexto del repositorio para agentes

Cauce V3: bus de mensajería durable entre agentes de IA en CLI (Claude Code, Codex, OpenClaw) de 4 tenants (Steven, Miguel, Jhon, Isa), con consola web de operador y puente Telegram. PostgreSQL es la única fuente durable; el gateway expone HTTP/WS; la entrega es *pull* — el adapter de cada agente reclama sus entregas con fencing (`claim_token`+`epoch`). El `dispatcher` no reparte nada: es el segador de reintentos.

**El árbol de este repo ES material de producción.** Prometheus, OTel y postgres montan ficheros directamente desde aquí; `main` está desplegado. No es un entorno de desarrollo aislado.

## Dónde está cada cosa

| Doc | Qué responde |
|---|---|
| `docs/doctrina-del-dueno.md` | el criterio detrás de las reglas: qué exige el dueño y por qué |
| `docs/arquitectura.md` | cómo está construido el sistema hoy — si solo lees un documento, que sea este |
| `docs/operacion.md` | cómo desplegar, dar de alta/baja un agente, diagnosticar, hacer backup |
| `docs/roadmap.md` | qué falta, priorizado |
| `docs/flota-y-participantes.md` | máquinas, humanos, los 14 agentes, los 5 escenarios esenciales |
| `ordenes/00-PROTOCOLO.md` | cómo conviven varias instancias en `main` sin pisarse — LÉELO antes de tocar nada |

Referencia adicional: `docs/adr/` (decisiones de diseño aceptadas), `docs/threat-model.md` (amenazas y controles), `docs/grafo.md` (mapa de dependencias, generado con `pnpm grafo`), `docs/consola.md` (consola web del operador), `docs/telegram.md` (puente Telegram), `docs/adapter-sdk.md` (SDK del consumidor durable), `docs/calidad-y-gates.md` (sistema de calidad y gates).

## Regla 0

**El código muerto se BORRA con `git rm`, nunca se archiva.** Git es el archivo: todo lo histórico vive en `git log` / `git show` (`--diff-filter=AD` para lo borrado). No existen carpetas de cuarentena ni bitácoras de lo retirado.

## Reglas duras del dueño (detalle y porqué: `docs/doctrina-del-dueno.md`)

- **Efecto demostrado.** Nada está "hecho" sin pegar la salida del gate; un despliegue no está hecho sin mostrar el efecto real contra el sistema vivo.
- **Revisor ≠ autor.** Todo sector tiene un dueño de escritura y un revisor distinto (tabla abajo); ninguna instancia se autoaprueba.
- **Todo en `main`, sin ramas.** Prohibido crear ramas. Convivencia por sector + `git add` solo de rutas propias + commit siempre con pathspec, nunca `-a` ni `add -A`.
- **La flota corre como root.** Es el entorno real de esta VPS: no se cablean guardias anti-root ni se chownea para "corregirlo"; el gate y el CI nocturno también corren como root. Única excepción: `pnpm qa:runtime-packaging` valida ownership y exige usuario normal.
- **GitHub Actions prohibido.** El gate completo corre en el propio host (`cauce-v3-ci-local.timer`), no en un servicio pagado.
- **Idioma: `.md` en español, código en inglés.** Identificadores y comentarios exportados en inglés; toda la documentación de proyecto en español.
- **Comentarios sin narrativa, sin fechas, sin nombres.** Solo restricciones que el código no puede expresar por sí solo. Lo que se poda: funciones sin propósito claro, sin nombre que describa qué hacen, repetidas en vez de reutilizadas, sin patrón de organización consistente, sobre-ingeniería innecesaria.
- **Migraciones que contaminan se borran enteras**, con su `down` y su suite — no se parchean.
- **Credenciales jamás se tocan fuera del dueño.** `ops/private/credentials/` está ignorada por git a propósito; ninguna instancia ni subagente borra, mueve o reescribe nada ahí dentro.

## Sectores (tabla completa, con revisor y reglas de convivencia: `ordenes/00-PROTOCOLO.md`)

Cada directorio tiene UN dueño de escritura por ronda; tocar algo fuera del sector propio se pide al integrador, nunca "de paso". Zonas y quién escribe hoy: `console/**` y `services/{terminal-relay,telegram-bridge}/**`; `packages/store/src/**` + `services/gateway/src/**` + release de `ops/scripts/`; `docs/`, higiene de disco, verificaciones mecánicas; `ops/pty-agent/**` + `tests/**`; `packages/{protocol,mcp-fleet-monitor}/**` + utilidades vivas de `ops/scripts|tests|harness`; `packages/adapter-sdk/**` + `ops/schemas/**`; `services/dispatcher/**` + `ops/runbooks/**`; `scripts/**` + el resto de `ops/` (systemd, generated, manifests, observability, config, guardias, container-runtime, cli, patches, private); `ordenes/`, documentación raíz, integración de merges y despliegue/flota/BD (con el dueño). Claude revisa todos los sectores.

## Gates

Gate de todo commit que toque código: `pnpm typecheck && pnpm lint && pnpm test:unit`, en verde. `pnpm test` (`scripts/test-all.mjs`) es el gate completo. `ops/scripts/validate.sh` valida sintaxis de `ops`+`deploy`, `shellcheck`, YAML/JSON Schema de manifiestos, y la identidad byte a byte de lo generado desde `ops/flota.json` — obligatorio tras tocar cualquier cosa de la flota. `scripts/calidad.mjs` aplica el trinquete de líneas por fichero, fechas y comentarios (solo puede bajar).

## NO TOCAR (sin excepción)

`packages/store/migrations/**` (se borran enteras, no se editan) · cualquier `*.patch` · ejecutar `deploy/deploy.sh` o `docker compose` contra producción sin el dueño · `/etc/cauce-v3` · `/opt` · la base de datos productiva · contenedores y unidades systemd · `ops/private/credentials/` y cualquier secreto o credencial.

## Cómo se trabaja

1. `git pull` antes de empezar; el árbol es compartido en tiempo real por varias instancias.
2. Trabaja SOLO en tu sector. `git add` fichero a fichero o por directorio propio — nunca `git add -A` ni `git add .`.
3. Gate en verde antes de cada commit que toque código (commits solo-`.md` no lo requieren).
4. `git mv` en commits separados de cualquier edición de contenido. Commits ≤20 ficheros, uno por tarea, e inmediatos: nada de acumular horas sin commitear en el árbol compartido.
5. Commitea SIEMPRE con pathspec — `git commit <tus rutas> -m "..."` — nunca `git commit -a` ni `-m` a secas: se lleva el índice completo, incluido trabajo ajeno staged.
6. Nada está "hecho" sin la evidencia pegada: salida real del gate, o el efecto verificado contra el sistema vivo.
7. Subagentes: úsalos para lo paralelizable, ficheros DISJUNTOS por subagente, tope 4, profundidad 1; solo el proceso principal commitea. Detalle: sección "Subagentes" de `ordenes/00-PROTOCOLO.md`.
8. Al terminar: `git push origin main`, y reporta en ≤5 líneas (commits, gate, qué quedó fuera).
