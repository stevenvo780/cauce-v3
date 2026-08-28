# Codex — ORDEN ACTIVA: RONDA FLOTA-COMO-DATOS, carril C (la ruta crítica antes de la ventana)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → **`plan-reestructura/flota-como-datos.md` COMPLETO** (es tu especificación: §1 snapshot, §3 fórmulas, §4 generadores, §6 gates, §9 riesgos y prohibiciones) → `docs/flota-y-participantes.md` (contexto). Reglas: pathspec, `umask 022`, commit+push POR TAREA. El supervisor (tu vieja tarea 1) YA NO ES TUYO — lo tomó el integrador.

## C1 — `ops/scripts/fleet_derive.py` (módulo puro, sin IO)
HARNESS_RULES por arnés (rama stateDirectory contenedor/host, workspace de openclaw, operationalModelEnv de hermes), `env_name(alias, kind)`, `SYSTEMD_USER="stev"`, `alias_entry()`, `manifest_doc()`. Nombra `runtime_state_directory()` vs `HOST_STATE_DIRECTORY` (las DOS rutas homónimas — §3 del diseño). Con tests unitarios propios.

## C2 — `ops/scripts/export-fleet-snapshot.py` + `ops/scripts/fleet-query.sql`
La consulta ÚNICA (agents+memberships+role_policies) en el .sql; el exportador escribe `ops/flota.json` canónico (sort_keys, indent 2, SIN timestamp/hostname — idempotencia byte a byte) y `--check` sale 3 si difiere. Valida fail-loud: dockerHost ⊆ {local,kratos}, tenant ∈ enum del schema. JAMÁS lo invoca un gate (herméticos).

## C3 — Los generadores con purga (LA FASE A ES TU CRITERIO DE HECHO)
`generate-container-aliases.py` y `generate-manifests.py` (f-string reproduciendo el estilo flow actual, NO yaml.safe_dump; desenlaza huérfanos). **FASE A obligatoria**: construye a mano un `ops/flota.json` que iguale el inventario de HOY (11 alias) y demuestra que tus generadores reproducen `ops/container-aliases.json` y los 11 `ops/manifests/*.yaml` commiteados **BYTE A BYTE** (`cmp -s` verde, pégalo). NO conmutes el árbol al snapshot real (flota de 14): eso es del integrador (K2) tras la reconciliación en BD. Extiende `generate-units.py`/`generate-container-units.py` SOLO para importar fórmulas de fleet_derive (mínimo churn). `regenerate-fleet.sh` orquesta la cadena.

## C4 — Los gates del diseño §6
(1) `validate.sh`: +2 bloques `cmp -s` (regenerar json+manifests desde `ops/flota.json` a tmp y exigir identidad) — SOLO actívalos cuando `ops/flota.json` exista en el árbol (guarda con `[ -f ]` hasta K2). (2) `container_ops_digest.py`: añade `ops/flota.json` y `ops/flota-fisica.json` a sus fuentes. (3) G-SNAP-2 (overlay: 3 claves permitidas, sin defaults redundantes), G-SNAP-3 (idempotencia doble sobre fixture), G-SNAP-4 (paridad de los 4 lectores duplicados, pineo no unificación) como tests en `ops/tests/`.

## Recordatorios: byte-puro; prohibiciones del §9 del diseño (nada de borrar json/manifests, nada de escribir en BD, nada de /opt ni /etc); idioma nuevo del dueño: comentarios de CÓDIGO NUEVO en inglés.
