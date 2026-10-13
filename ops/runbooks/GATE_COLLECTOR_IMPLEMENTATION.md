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

La sonda no usa `gate-probe` como alias de flota ni lo registra en memberships, leases o routing.
Sí existe una fila `company_system_principals` de tipo `gate_probe`; en `publish-operation.ts`, el
gateway la consulta en la base al publicar una sonda de gate. Las publicaciones ordinarias no
consultan `systemGatePrincipal`. Gateway y adapter validan nuevamente la autoridad y la forma exacta.
El ACK probado conserva attempt, claim token y epoch reales, y debe corresponder a la misma lease
V3 viva y con heartbeat fresco.

Pruebas deterministas cubren validación pre-DB, timeouts, archivos privados, canary/cutover,
snapshot repeatable-read bajo una carrera de expiry, ACK terminal/epoch drift, ausencia de
modelo/sesión/egress, filtros de principals y paridad de conjuntos entre snapshot y base (alias
habilitados, principales de sistema y retirados).
