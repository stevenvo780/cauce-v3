# Implementación del collector y la sonda

Componentes activos:

- `gate-collector.mjs`: snapshot PostgreSQL read-only y consistente (`REPEATABLE READ`).
- `migration-gate.mjs`: contrato exacto y reglas por fase.
- `gate-roundtrip-probe.mjs`: publish mTLS reservado, model-free.
- `canary.sh` / `cutover.sh`: crean y eliminan evidencia temporal, y nunca aceptan un snapshot
  post-cutover suministrado manualmente.
- `guard-check.sh`: watchdog/reconciler read-only con baseline absoluto, regular y no symlink.
- `physical-fleet-gate.py`: existencia de containers físicos antes de migrar.

El collector resuelve `pg` desde el package store, exige `CAUCE_DATABASE_URL`, inventario declarado
y parámetros enteros acotados. Para fases post/canary requiere baseline y evidencia del probe; para
guards requiere baseline. Escribe snapshot por rename atómico con modo 0600 y nunca imprime cuerpo,
IDs de mensaje/delivery/sesión ni valores de entorno. Un fallo SQL expone como máximo SQLSTATE.

La sonda no usa alias 16. `gate-probe` sólo existe en el mapa mTLS; no aparece en inventario, DB,
memberships, leases o routing. Gateway y adapter validan nuevamente la autoridad y la forma exacta.
El ACK probado conserva attempt, claim token y epoch reales, y debe corresponder a la misma lease
V3 viva y con heartbeat fresco.

Pruebas deterministas cubren validación pre-DB, timeouts, archivos privados, canary/cutover,
snapshot repeatable-read bajo una carrera de expiry, ACK terminal/epoch drift, ausencia de
modelo/sesión/egress, filtros de principals y paridad 15/1/3.
