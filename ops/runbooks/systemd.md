# Runbook: Gestión de Servicios Systemd

## Cuándo usar
Administrar el ciclo de vida de los servicios centrales de Cauce V3 y los adaptadores de agentes mediante unidades systemd en el host (modos system y user/rootless).

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
3. Para adaptadores host-native o de contenedor, instalar las unidades correspondientes y configurar variables de entorno `0600` por alias:
   ```sh
   # [no ejecutable en verificación]
   systemctl enable --now cauce-v3-alias-<alias>.service
   ```

## Verificar efecto
1. Verificar estado y salud de las unidades centrales:
   ```sh
   # [no ejecutable en verificación]
   systemctl status cauce-v3-compose@prod.service
   systemctl status cauce-v3-health@prod.timer
   ```
2. Validar que la unidad del alias esté activa:
   ```sh
   # [no ejecutable en verificación]
   systemctl is-active cauce-v3-alias-<alias>.service
   ```
3. Consultar logs del servicio en journald asegurando que no se registren credenciales ni payloads sensibles:
   ```sh
   # [no ejecutable en verificación]
   journalctl -u cauce-v3-alias-<alias>.service -n 50 --no-pager
   ```

## Deshacer
1. Detener y deshabilitar las unidades afectadas:
   ```sh
   # [no ejecutable en verificación]
   systemctl disable --now cauce-v3-alias-<alias>.service
   systemctl disable --now cauce-v3-compose@prod.service
   ```
2. Recargar la configuración del demonio de systemd:
   ```sh
   # [no ejecutable en verificación]
   systemctl daemon-reload
   ```
