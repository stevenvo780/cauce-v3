# Runbook: Adapters V3 en Contenedores

## Cuándo usar
Supervisar, desplegar, actualizar y hacer rollback de adapters V3 que se ejecutan dentro de contenedores Docker existentes mediante systemd (rootless o system).

> **Importante**: `ops/container-aliases.json`, `ops/manifests/*.yaml` y `ops/generated/container-systemd/**` son estrictamente GENERADOS a partir de `ops/flota.json` (exportado desde PostgreSQL). La edición manual de estos archivos está estrictamente PROHIBIDA y bloqueada por el gate de validación (`ops/scripts/validate.sh`). Para altas, bajas o aprovisionamiento de adaptadores en contenedor, consultar [Runbook: Alta y Baja de Agente](file:///datos/workspaces/zeus/cauce-v3/ops/runbooks/alta-y-baja-de-agente.md) y utilizar `ops/scripts/regenerate-fleet.sh` junto con `cauce <alias> aprovisionar`.

## Pasos
1. Regenerar y verificar unidades systemd y digests desde el snapshot de flota:
   ```sh
   ops/scripts/regenerate-fleet.sh
   ops/scripts/validate.sh
   # O verificación directa de unidades de contenedor:
   python3 ops/scripts/generate-container-units.py --rootless --home "$HOME" --output ops/generated/container-systemd/rootless
   python3 ops/scripts/container_ops_digest.py --rootless --check
   ```
2. Instalar unidades y configurar entorno para el alias (`0600`) (para aprovisionar credenciales y entorno usar `cauce <alias> aprovisionar`):
   ```sh
   # [no ejecutable en verificación]
   install -d -m 0700 "$HOME/.config/systemd/user"
   install -m 0644 ops/generated/container-systemd/rootless/cauce-v3-container-*.service "$HOME/.config/systemd/user/"
   systemctl --user daemon-reload
   ```
3. Fijar el release mediante compare-and-swap (CAS):
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/pin-container-release.py pin kant \
     --expected-release release-anterior \
     --expected-sha256 sha256:<digest-anterior> \
     --release release-nuevo \
     --sha256 sha256:<digest-nuevo>
   systemctl --user restart cauce-v3-container-kant.service
   ```

## Verificar efecto
1. Validar el estado del proceso con el supervisor:
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/container-adapter-supervisor.sh check kant
   systemctl --user is-active cauce-v3-container-kant.service
   ```
2. Inspeccionar logs del servicio sin filtrar credenciales:
   ```sh
   # [no ejecutable en verificación]
   journalctl --user -u cauce-v3-container-kant.service --since -10m
   ```
3. Validar un round-trip real con entrega `done` por el bus.

## Deshacer
1. Revertir el pin mediante rollback CAS:
   ```sh
   # [no ejecutable en verificación]
   ops/scripts/pin-container-release.py rollback kant \
     --expected-release release-nuevo \
     --expected-sha256 sha256:<digest-nuevo> \
     --release release-anterior \
     --sha256 sha256:<digest-anterior>
   systemctl --user restart cauce-v3-container-kant.service
   ```
2. Si se requiere apagar el adapter por completo (para baja definitiva seguir `ops/runbooks/alta-y-baja-de-agente.md`):
   ```sh
   # [no ejecutable en verificación]
   systemctl --user disable --now cauce-v3-container-kant.service
   ops/scripts/container-adapter-supervisor.sh stopped kant
   ```
