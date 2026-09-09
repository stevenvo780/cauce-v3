# Instalación de gates (procedimiento, no ejecutado)

1. Instalar desde el mismo release inmutable, sin symlinks: collector
   (`ops/scripts/gate-collector.mjs`), probe (`gate-roundtrip-probe.mjs`), gate de migración
   (`migration-gate.mjs`), canary/cutover/guard (`canary.sh`, `cutover.sh`, `guard-check.sh`),
   gate de flota física (`physical-fleet-gate.py`), sus ayudantes, los schemas y el inventario.

2. Configurar paths, nunca valores secretos:

   - collector: `CAUCE_DATABASE_URL` desde el mecanismo privado autorizado;
   - probe: `CAUCE_GATE_PROBE_URL` HTTPS y
     `CAUCE_GATE_PROBE_{CA,CERT,KEY}_FILE` absolutos;
   - `CAUCE_GATE_PROBE_KEY_FILE` y evidencia temporal sin permisos group/world;
   - `CAUCE_GATE_CAPTURE_PATH` / `CAUCE_GATE_PROBE_PATH` absolutos, ejecutables y no symlink.

3. Provisionar fuera del repo un certificado clientAuth independiente y añadir sólo su fingerprint
   al mapa mTLS por rename atómico. Principal exacto:

   ```json
   {"tenant_id":"<tenant>","alias":"gate-probe","session_id":"gate-probe","channel":"gate","roles":["agent"],"permissions":["route","read"]}
   ```

   El tenant y la sala de origen exactos que exige el gateway están en
   `services/gateway/src/routes/core/publish.ts`; el resto de los campos es literal.

   No crear agent row, membership, lease, cuota ni entrada en `container-aliases.json`. No reutilizar
   el certificado de consola o de un adapter. Ver `runbooks/authentication.md` para permisos del
   directorio y verificación de que el gateway ve el inode nuevo, sin imprimir el registro.

4. Antes de migrar producción:

   ```sh
   python3 ops/scripts/physical-fleet-gate.py
   ```

   Verifica que cada container declarado por la flota exista realmente en su host. Un container
   inexistente o un snapshot incompleto bloquea.

5. Capturar un drain v2 del alias, después ejecutar el cutover con `CAUCE_CHANGE_ID` y confirmación
   exacta. `cutover.sh` arranca una familia, lanza el probe, captura post-cutover y deshabilita la
   unit automáticamente ante fallo. V2 no se modifica desde el script.

6. Conservar como baseline privado el snapshot de cutover exitoso y pasarlo a watchdog/reconciler
   mediante `CAUCE_GATE_BASELINE_FILE`. Esos guards no crean probes ni reinician servicios.
