# Runbook: Gestión de Servicios Systemd

## Cuándo usar
Administrar el ciclo de vida de los servicios centrales de Cauce V3 (ámbito system) y de los adaptadores. `generate-units.py` emite unidades de sistema `cauce-v3-alias-<alias>.service` (`WantedBy=multi-user.target`). El adaptador de contenedor es `cauce-v3-container-<alias>.service`: de sistema, o de usuario si se generó con `generate-container-units.py --rootless` (`WantedBy=default.target`). En ese caso el comando lleva `systemctl --user`, que es lo que usa `ops/cli/cauce`.

## Pasos
1. Validar manifiestos y generar unidades de servicio:
   ```sh
   python3 ops/scripts/validate-manifests.py
   python3 ops/scripts/generate-units.py --output /etc/systemd/system
   ```
2. Para el stack central de Compose:
   ```sh
   # [no ejecutable en verificación]
   systemctl daemon-reload
   systemctl start cauce-v3-compose@prod.service
   systemctl enable --now cauce-v3-health@prod.timer
   ```
3. Instalar la unidad del adaptador y configurar variables de entorno `0600` por alias. Descomenta una sola línea. Si el contenedor se generó con `--rootless`, el comando lleva `--user`:
   ```sh
   # [no ejecutable en verificación]
   # systemctl enable --now cauce-v3-alias-<alias>.service
   # systemctl enable --now cauce-v3-container-<alias>.service
   ```

## Verificar efecto
1. Verificar estado y salud de las unidades centrales:
   ```sh
   # [no ejecutable en verificación]
   systemctl status cauce-v3-compose@prod.service
   systemctl status cauce-v3-health@prod.timer
   ```
2. Validar que la unidad habilitada en el paso 3 esté activa. Misma elección de nombre y de `--user`:
   ```sh
   # [no ejecutable en verificación]
   # systemctl is-active cauce-v3-alias-<alias>.service
   # systemctl is-active cauce-v3-container-<alias>.service
   ```
3. Consultar logs del servicio en journald asegurando que no se registren credenciales ni payloads sensibles:
   ```sh
   # [no ejecutable en verificación]
   # journalctl -u cauce-v3-alias-<alias>.service -n 50 --no-pager
   # journalctl -u cauce-v3-container-<alias>.service -n 50 --no-pager
   ```

## Deshacer
1. Detener y deshabilitar las unidades afectadas:
   ```sh
   # [no ejecutable en verificación]
   # systemctl disable --now cauce-v3-alias-<alias>.service
   # systemctl disable --now cauce-v3-container-<alias>.service
   systemctl disable --now cauce-v3-compose@prod.service
   ```
2. Recargar la configuración del demonio de systemd:
   ```sh
   # [no ejecutable en verificación]
   systemctl daemon-reload
   ```
