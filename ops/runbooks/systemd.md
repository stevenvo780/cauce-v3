# Runbook: systemd

## Stack Compose

`cauce-v3-compose@dev.service` usa `compose.dev.yaml`; `@prod` usa producción TLS. Crear `/etc/cauce-v3/ops.env` y el env runtime fuera del repo, ambos `0600`. `ExecStop` nunca borra volúmenes.
La instancia `@prod` ejecuta `release-gate.sh` antes de start/reload y falla si
no hay Compose v2, build/evidencia crítica o imágenes por digest.

```sh
systemctl start cauce-v3-compose@prod.service
systemctl start cauce-v3-health@prod.service
systemctl enable --now cauce-v3-health@prod.timer
```

## Consumers por alias

```sh
python3 /opt/cauce-v3/ops/scripts/validate-manifests.py
python3 /opt/cauce-v3/ops/scripts/generate-units.py --output /etc/systemd/system
systemctl daemon-reload
```

Las 12 unidades son concretas (`cauce-v3-alias-<alias>.service`), non-root y hardened. `SHA256SUMS` debe verificar las 12 antes de instalarlas. Cada una fija `CAUCE_ENVIRONMENT=production` y un `CAUCE_INSTANCE_ID=systemd-<alias>` durable, y requiere `/etc/cauce-v3/aliases/<alias>.env`; no usar un env compartido. `StateDirectory` es `/var/lib/cauce-v3/aliases/<alias>` y `alias-runner.sh` toma un `flock` exclusivo.

Estas units host-native siguen disponibles sin cambios. Para Kratos instalar en cambio `generated/container-systemd/cauce-v3-container-<alias>.service`; tienen límite finito de restart y no reinician ante exits permanentes `2/73/78`. `cutover.sh`/`cutover-rollback.sh` requieren familia explícita y bloquean overlap/auto-resurrection. Procedimiento completo: `container-adapters.md`.

No habilitar una unidad antes del drain V2 y `cutover.sh`. Instalar además watchdog/reconciler templates y habilitar sus timers solo con el marker `/etc/cauce-v3/guards/<alias>.enabled`. Los collectors son read-only; journals no deben contener URLs, PATHs sensibles, prompts ni respuestas CLI.
