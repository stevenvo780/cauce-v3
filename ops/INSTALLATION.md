# Instalación de gates (procedimiento, no ejecutado)

1. Instalar desde el mismo release inmutable, sin symlinks: collector, probe, migration gate,
   canary/cutover/guard, fleet parity/mode, physical fleet gate, helper, schemas e inventario.

2. Configurar paths, nunca valores secretos:

   - collector: `CAUCE_DATABASE_URL` desde el mecanismo privado autorizado;
   - probe: `CAUCE_GATE_PROBE_URL` HTTPS y
     `CAUCE_GATE_PROBE_{CA,CERT,KEY}_FILE` absolutos;
   - `CAUCE_GATE_PROBE_KEY_FILE` y evidencia temporal sin permisos group/world;
   - `CAUCE_GATE_CAPTURE_PATH` / `CAUCE_GATE_PROBE_PATH` absolutos, ejecutables y no symlink.

3. Provisionar fuera del repo un certificado clientAuth independiente y añadir sólo su fingerprint
   al mapa mTLS por rename atómico. Principal exacto:

   ```json
   {"tenant_id":"Steven","alias":"gate-probe","session_id":"gate-probe","channel":"gate","roles":["agent"],"permissions":["route","read"]}
   ```

   No crear agent row, membership, lease, cuota ni entrada en `container-aliases.json`. No reutilizar
   el certificado de consola o de un adapter. Ver `runbooks/authentication.md` para permisos del
   directorio y verificación de que el gateway ve el inode nuevo, sin imprimir el registro.

4. Antes de migrar producción:

   ```sh
   python3 ops/scripts/physical-fleet-gate.py
   CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/release-gate.sh
   ```

   El primero sólo verifica nombres de containers Docker; el segundo incluye ese gate y la paridad
   de catálogo. Un container inexistente, policy divergente o snapshot incompleto bloquea.

5. Capturar un drain v2 del alias, después ejecutar el cutover con `CAUCE_CHANGE_ID` y confirmación
   exacta. `cutover.sh` arranca una familia, lanza el probe, captura post-cutover y deshabilita la
   unit automáticamente ante fallo. V2 no se modifica desde el script.

6. Conservar como baseline privado el snapshot de cutover exitoso y pasarlo a watchdog/reconciler
   mediante `CAUCE_GATE_BASELINE_FILE`. Esos guards no crean probes ni reinician servicios.

7. Si Zeus debe estar offline durante mantenimiento, usar sólo `--maintenance-offline-zeus` junto
   con `CAUCE_CHANGE_ID` y la confirmación exacta. Ejecutar después el modo final sin excepción.
