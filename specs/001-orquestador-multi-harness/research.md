# Research: decisiones de descubrimiento

**Spec**: [spec.md](spec.md) | **Fecha**: 2026-09-27. Todo verificado contra
el árbol o la máquina en esta sesión; nada supuesto.

## R1. Spec Kit 1.0.7, init offline

`specify init --here --force --non-interactive --ignore-agent-tools` funciona
sin red (plantillas empaquetadas). Decisión: ignorar agent-tools en el init y
elegir integraciones a mano después, para no arrastrar el default Copilot (no
es arnés de la flota).

## R2. Integraciones: claude (default) + codex + muse

- `specify integration switch claude` (la flota revisa en Claude; saca a
  Copilot y elimina `.github/` por completo — cero confusión con Actions).
- `install codex --force` e `install muse --force` junto al default.
- Resultado: `.claude/commands/` + `.agents/skills/` con `/speckit.*` para los
  tres arneses reales del proyecto. OpenClaw no tiene integración en el
  catálogo; usa los ficheros `specs/` directamente.

## R3. La pila de pruebas existe y es coherente

`ops/compose.test.yaml` (`config --quiet` OK): postgres:16-alpine efímera
(tmpfs) → migrador (`deploy/migrate.mjs`, existe DENTRO de la imagen porque
el Dockerfile copia `deploy/runtime/*.mjs` a `./deploy/`) → gateway + dispatcher
(con `readiness-probe.mjs` real) → arnés e2e (`ops/harness/runner.mjs --live`).
Red interna, único puerto publicado `127.0.0.1:18080`. Verificado en esta
sesión: imágenes `cauce-v3-test-runtime:local` y `cauce-v3-test-qa:local`
construyen y los 4 servicios arrancan saludables.

## R4. Métricas del monstruo (la deriva a ordenar)

- `main..dev`: 922 ficheros, +73.141/−20.374 líneas.
- Por área: services +17,5k, packages +17,3k, console +13,3k, ops +12,6k,
  tests +8,5k, docs +2,7k.
- Árbol: ~277k líneas de código; 19 ficheros sobre el tope de 800
  (el mayor: un test de 2.700 líneas).
- Ramas remotas vivas además de main/dev: `hospitales`,
  `zeus/turno-vivo-panel-kratos`, `zeus/tope-openclaw-90k`, `feat/blobs-1gb`.
- Deuda de despliegue: `HISTORIAL.md` no registra los commits desde `0b5bf89e`.

## R5. Flujo speckit adaptado: sin ramas, sin implementadores paralelos

`create-new-feature.sh` crea rama → NO se usa (constitución IV). El directorio
`specs/001-*/` se crea a mano en `dev`. Los tasks se ejecutan por sector según
`ordenes/00-PROTOCOLO.md`, no por historia en paralelo ciega: cada task lleva
su sector para no pisar a las instancias en vuelo.

## R6. Preguntas que sólo el dueño cierra

Recogidas en spec FR-011..FR-015 y alineadas con "Preguntas abiertas" de
`docs/version-3.1.md`: presupuestos claude/hermes, retención de grabaciones
TUI, poda de `secret.granted`/auditoría, recarga por el propio alias, SLO por
escenario. El plan NO inventa números: donde falta medida hay task de medición
o pregunta registrada.

## R7. Bloqueador e2e RESUELTO: arnés incompleto + flota sin sembrar + timeout corto

El contenedor e2e muere con `ERR_MODULE_NOT_FOUND:
'/app/ops/harness/adapter-roundtrip.mjs'`. Causa raíz: `deploy/Dockerfile`
etapa `qa-runtime` copia SÓLO `ops/harness/runner.mjs`, pero `runner.mjs`
importa `./adapter-roundtrip.mjs`, `./fleet.mjs` y `./harness-utils.mjs`
(`ops/harness/` tiene 9 módulos). Arreglo propuesto (sector despliegue, con el
dueño): copiar el directorio completo en vez del fichero suelto. Gateway,
dispatcher y postgres de la pila sí arrancan saludables; SC-001 queda
bloqueado en este punto hasta el arreglo.

## R8. `.claude/` está git-ignorado; el SDD versionado vive en 3 rutas

`.gitignore:72` ignora `.claude/`, así que los comandos `/speckit.*` de Claude
viven sólo en este checkout. Lo versionado: `.specify/` (plantillas, scripts,
constitución), `specs/` (artefactos) y `.agents/skills/` (skills). Cada
checkout/instancia instala su integración con
`specify integration install <claude|codex|muse> --force`.
