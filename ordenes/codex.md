# Codex — ORDEN ACTIVA (sesión larga; paraleliza en oleadas de 4; sector: store + gateway + adapter/protocol + ops/scripts)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden → verifica con comandos. OJO: el árbol CAMBIÓ esta noche — `apps/console` ahora es `console/` en la raíz, `deploy/` está agrupado por consumidor (`runtime/`, `console/`, `postgres/`), y las migraciones 029/036 no existen. Reglas de siempre: main directo, commit con pathspec, sin clean/reset/stash, gate global por commit COMO USUARIO NORMAL con `umask 022`, push por tarea + reporte ≤5 líneas.

## Tarea 1 — El rojo determinista de `ops/tests/container-supervisor.test.mjs` (diagnóstico ya masticado)
Falla SIEMPRE en el mismo punto: el subtest de flock (línea ~1127) — `waitForLogOrExit` (timeout fijo 15s, línea ~293) agota esperando que el PRIMER supervisor lanzado llegue a su barrera de docker-exec falso; el proceso NO sale (no es "exited before barrier"), se CUELGA antes del exec. Datos: llegó en su forma actual en `c7345da` (26-08); `validate.sh` abortaba antes (digest rojo, ya arreglado), así que **plausiblemente jamás pasó en esta máquina**; falla igual aislado (16 min de run). Investiga arnés vs producto: ¿el supervisor real (`ops/scripts/container-adapter-supervisor.sh`) se bloquea en el flock/gate del fixture, o el fixture arma mal la barrera? Arregla la causa raíz (si es producto, es un cuelgue REAL de arranque); prueba con el test completo en verde y pega la duración.

## Tarea 2 — Dientes de tu sector (mapa: `ordenes/reportes/minimax-dientes.md`)
- **Los 14 skips ambientales** de `packages/adapter-sdk/test/shared-session.test.ts` (+2 de harnesses): son el corazón del adapter y el gate NUNCA los corre (saltan si no hay tmux). Decide y ejecuta: garantizar tmux en el entorno del gate y quitar el skip, o convertir el skip en FALLO ruidoso cuando falte tmux. Que el gate los corra de verdad.
- Los matcher-débil restantes de packages/services (de los 8 del reporte; consola ya está).
- De "los 20 PEORES": los de tu sector.

## Tarea 3 — Duplicados de tu sector (mapa: `ordenes/reportes/minimax-duplicados.md` + `_parcial-dup-backend.md` + `_parcial-dup-ops.md`)
Del top-8: **#1** `ops/cli/cauce` es copia divergida de 565 líneas de `ops/guardias/cauce-kratos.sh` (y `ops/guardias/cauce-envoltorio-local.sh` era casi bit-a-bit el ya borrado cauce-portatil — evalúa si sobra entero); **#3** `stringField` ×6 (la 6ª acepta string vacío — unifica con la semántica ESTRICTA); **#4** la forma del ACK de outbox ×3 (unifica en protocol); **#5** `EgressDestinationRow` vs `DestinationRow`; **#6** la whitelist de `container_ops_digest.py` duplicada dentro de su test (el test no prueba nada — haz que lea la real); **#7** el mapa tenant→alias ×3 en `ops/harness/` (OJO: harness se COPYa a la imagen — Dockerfile:106,113); **#8** `fakePool()` ×9 con dos shapes. Después los 18 grupos de backend (~497 línea-ocurrencias). Hogar único por grupo, gate por commit.

## Tarea 4 — P14 por número en tu sector
`ordenes/reportes/minimax-lineas-p14.md` + `_parcial-p14-store.md` + `_parcial-p14-services.md`: borra por número verificando ancla (primera palabra); las particiones de hoy desplazaron líneas. Ni un byte de sql-strings.

## Recordatorios permanentes
- Migraciones 029/036 NO existen — no las resucites; el runner tolera huecos.
- Bases `cauce_test*` externas viejas: recréalas (huella de migraciones cambió). `cauce-test-zeus` (puerto 15433) sigue vivo con conexiones: coordina antes de tocarlo.
- `ops/private/credentials/` PROHIBIDO tocar (regla nueva del protocolo).
