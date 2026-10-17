# Runbook: Recolector de Cuotas de IA

## Cuándo usar
Instalar, operar y verificar el recolector periódico de cuotas de consumo de IA (`quota-collector.py`) que muestrea `ai-usage`, normaliza el formato y publica muestras vía mTLS en `POST /v3/quotas/samples`.

## Pasos
1. Instalar el ejecutable que arranca la unidad y preparar directorios. `ExecStart` llama a `quota-collector.py` sin intérprete. En git el fichero es modo `100644`, así que hay que dejarlo ejecutable en la ruta de la unidad. Estos comandos no copian `client.crt`, `client.key` ni `ca.crt`:
   ```sh
   # [no ejecutable en verificación]
   install -d -m 0700 ~/.local/share/cauce-v3/ops/scripts
   install -m 0755 ops/scripts/quota-collector.py \
     ~/.local/share/cauce-v3/ops/scripts/quota-collector.py
   install -d -m 0700 ~/.config/cauce-v3/container-pki/quota-collector
   install -d -m 0700 ~/.config/cauce-v3/quota-collector
   install -m 0600 ops/config/quota-collector.env.example ~/.config/cauce-v3/quota-collector.env
   install -m 0600 ops/config/quota-collector-account-bindings.json.example \
     ~/.config/cauce-v3/quota-collector/account-bindings.json
   ```
   `client.crt`, `client.key` (modo `0600`) y `ca.crt` tienen que estar ya en el directorio PKI antes de publicar. Si falta uno, `build_ssl_context` sale con código 2 (`falta <fichero> en <directorio>`). El dry-run del paso 3 vuelve antes de `post_samples` y no lo detecta.
   Antes de habilitar el servicio, sustituir los valores de ejemplo del fichero privado: `CAUCE_QUOTA_GATEWAY_URL` debe apuntar al gateway real y `CAUCE_QUOTA_HOST` al identificador del ordenador. La URL es obligatoria para publicar; `--gateway-url` permite indicarla en una corrida manual. El modo dry-run no necesita destino. Ajustar también los identificadores `zz-canary-*` de `account-bindings.json` a las cuentas registradas; el repositorio público solo contiene datos ficticios.
2. Instalar y habilitar las unidades systemd de usuario:
   ```sh
   # [no ejecutable en verificación]
   install -d -m 0700 ~/.config/systemd/user
   install -m 0644 ops/systemd/cauce-v3-quota-collector.service ~/.config/systemd/user/
   install -m 0644 ops/systemd/cauce-v3-quota-collector.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now cauce-v3-quota-collector.timer
   ```
3. Ejecutar prueba local en modo dry-run:
   ```sh
   CAUCE_QUOTA_DRY_RUN=1 python3 ops/scripts/quota-collector.py
   ```

## Verificar efecto
1. Ejecutar una corrida manual del servicio:
   ```sh
   # [no ejecutable en verificación]
   systemctl --user start cauce-v3-quota-collector.service
   ```
2. Inspeccionar logs del servicio y verificar código HTTP 202:
   ```sh
   # [no ejecutable en verificación]
   journalctl --user -u cauce-v3-quota-collector.service -n 20 --no-pager
   ```
3. Ejecutar tests unitarios del recolector:
   ```sh
   python3 ops/tests/test_quota_collector.py
   ```
4. Confirmar que la consola web muestra las muestras actualizadas en `/v3/console/quotas`.

## Deshacer
1. Detener y deshabilitar timer y servicio:
   ```sh
   # [no ejecutable en verificación]
   systemctl --user disable --now cauce-v3-quota-collector.timer
   systemctl --user stop cauce-v3-quota-collector.service
   ```
2. Remover configuración y directorio PKI del recolector si se retira definitivamente.
