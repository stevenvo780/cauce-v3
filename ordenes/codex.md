# Codex-1 — ORDEN ACTIVA (ronda 2 del carril C): las deudas de la revisión + comprometerte a COMMITEAR

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → `plan-reestructura/flota-como-datos.md` → esta orden. Tu carril C fue **APROBADO por revisión adversarial: Fase A byte-idéntica** — excelente trabajo. Pero por SEGUNDA ronda dejaste TODO sin commitear (2.301 líneas untracked; el integrador las commiteó en `f517c9b`). Esta ronda: **commit+push por tarea, sin excepción**. Zona EXCLUSIVA: `ops/scripts/**` + `ops/tests/**`.

## Tarea 1 — La Fase A como TEST AUTOMATIZADO (deuda importante de la revisión)
Hoy solo existe el fixture `minimal` (codex/hermes/openclaw); la rama `claude` de `generate-manifests.py:69-70` no la ejercita ningún test. Añade `ops/tests/fixtures/fleet_snapshot/real-11/` (snapshot que replica el inventario real de los 11 alias, incluido al menos un `claude`) y un test que asevere `cmp` byte a byte contra `ops/container-aliases.json` y los 11 `ops/manifests/*.yaml` commiteados. Sin esto, un cambio futuro rompe la Fase A en silencio.

## Tarea 2 — G-SNAP-2 al camino de escritura (deuda importante)
Las 3 comparaciones "no debe repetir el default" (dockerHost≠local, healthContainer≠container, registryContainer≠healthContainer efectivo) viven solo en el test; muévelas a la validación del propio `export-fleet-snapshot.py`/`generate-container-aliases.py` para que fallen ruidoso al escribir, no solo al testear.

## Tarea 3 — `runtime_state_directory()` (deuda menor): sin caller
O se cablea como chequeo de drift en el exportador (`assert row.state_directory == runtime_state_directory(alias, row)`, fail-loud) — probablemente la intención del diseño — o se borra (regla 0). Decide, ejecuta, justifica en el commit.

## Tarea 4 — Preparar K2 (para que el integrador conmute el snapshot real sin sorpresas)
El snapshot real tendrá **14 alias** (no 11): gaia (`agv2-miguel-finca-oc`, openclaw), heraclito (`agv2-jhon-heraclito-oc`, openclaw), tales (`agv2-jhon-tales-oc`, openclaw), argos pasa a **openclaw** (dictado del dueño), iza = openclaw@claw-miguel, kant = rama host. Simula en `/tmp` esa flota de 14 y verifica que TODA la cadena (export→generate→units) produce salida válida que pasa `container_alias_lib` + `manifest_lib` + `physical-fleet-gate` (que subirá a 14 contenedores exigidos). Reporta qué rompe, si algo.
