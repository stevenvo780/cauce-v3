# Instancia Cauce de Hospital Conecta

Este perfil instala una instancia separada de la flota central. Usa el proyecto Compose
`hospital-cauce`, PostgreSQL, PKI, identidades, volúmenes, puertos y rutas propias. No reutiliza
`/etc/cauce-v3`, su base ni sus certificados.

## Topología

- tenant `Hospital`, sala `grp.hospital`;
- `operador`: director, único receptor de Telegram y supervisor; delega todo desarrollo y no
  implementa cambios;
- `teseo`: developer generalista Grok en contenedor, contexto y candidato propios;
- `perseo`: developer generalista Grok en contenedor, contexto y candidato propios;
- los tres usan Grok con workspace, estado, sesión y contexto independientes;
- cada developer puede recibir cualquier capa con archivos disjuntos; el operador ve ambos
  candidatos y los integra al canónico; los developers no tienen red clínica, navegador ni
  `hospital_ops`;
- Cauce publica gateway y consola sólo sobre `172.17.0.1`, fuera de la interfaz pública del VPS.

## Orden de instalación

1. Desplegar primero la rama complementaria `socrates/cauce-builders-20260905` de
   `hospital-openclaw-deploy`. Deben existir y estar saludables los tres gateways OpenClaw.
2. Clonar este checkout exactamente en `/opt/hospital-cauce`, rama
   `socrates/hospital-fleet-20260905`, y ejecutar:

   ```bash
   sudo ./ops/instances/hospital/install.sh
   ```

3. Mostrar el acceso privado a la consola:

   ```bash
   sudo hospital-cauce-access
   ```

4. Steven autentica únicamente los dos builders, sin pegar la clave en el chat:

   ```bash
   sudo /opt/hospital-agent/authenticate-grok.sh api-key builders
   ```

5. Revocar en BotFather el token que apareció en Telegram y generar otro. Con el token rotado,
   ejecutar en una terminal interactiva:

   ```bash
   sudo ./ops/instances/hospital/activate-telegram.sh
   ```

   El asistente verifica que el token pertenece a `@hospitales_builder_developer_bot`, pide un
   `/start` privado, deriva la allowlist sin imprimir el identificador y activa sólo `operador`.

## Verificación

- `deploy/smoke.sh` resuelve contenedores por Compose y exige tres leases frescos después del
  aprovisionamiento.
- Los tres adapters deben quedar `active` y PostgreSQL debe observar tres leases del tenant.
- El backup nocturno debe mostrar dump, checksum y una restauración completa dentro de un
  contenedor sin red; `hospital-cauce-backup-monitor.service` valida su integridad cada seis horas.
- Antes de considerar Telegram cerrado: mensaje permitido → operador → una tarea a `teseo` y otra
  a `perseo` → dos respuestas materializadas → una sola respuesta al DM.
- El token del bot vive únicamente en
  `/etc/cauce-v3-hospital/telegram-runtime/operador.token`, propietario 1000 y modo `0600`.
- Las credenciales xAI viven en los estados OpenClaw separados; ningún script las copia.

## Nombres lógicos de los developers

Los aliases activos son `operador`, `teseo` y `perseo`. Teseo y Perseo son developers generalistas
con las mismas capacidades; el director reparte archivos por entrega. Los nombres técnicos de los
contenedores (`backend` y `frontend`) se conservan sólo como slots físicos para no migrar redes,
volúmenes ni tokens.

Una instalación que todavía tenga los aliases históricos debe detener primero Telegram y los tres
adapters, ejecutar `rename-developers.sql` con psql y volver a correr `provision-agents.sh`. El SQL
conserva `backend` y `frontend` deshabilitados para que mensajes y auditoría históricos no pierdan
integridad; activos siguen siendo exactamente tres. Antes de que los nombres nuevos produzcan
mensajes, `restore-developer-aliases.sql` ofrece la reversa transaccional. Después de la primera
entrega nueva, la reversa restaura el dump completo tomado antes del corte y los estados respaldados.

## Rollback

No usar `docker compose down -v`.

1. Detener el canal y los adapters:

   ```bash
   sudo docker compose --env-file /etc/cauce-v3-hospital/prod.env \
     --profile telegram -f deploy/compose.yaml -f deploy/compose.postgres.yaml \
     --project-directory deploy stop telegram-bridge
   sudo systemctl disable --now \
     cauce-v3-container-operador.service \
     cauce-v3-container-teseo.service \
     cauce-v3-container-perseo.service
   ```

2. Restaurar los dos pins `CAUCE_RUNTIME_IMAGE` y `CAUCE_CONSOLE_IMAGE` desde el respaldo
   `/etc/cauce-v3-hospital/prod.env.pre-deploy-*` correspondiente y ejecutar `up -d --wait` sólo
   sobre el proyecto `hospital-cauce`.
3. Conservar PostgreSQL, estados OpenClaw, tokens y PKI para investigación o reactivación.
4. El stack original `/opt/hospital-agent` continúa independiente; el rollback de Cauce no debe
   detener CRM, atención WhatsApp ni el operador privado.

Un segundo `install.sh` se niega a desplegar si ya existe el volumen PostgreSQL y el estado no
acredita el dump con restauración aislada de menos de 24 horas; el bypass automático existe sólo
en la primera instalación vacía. La copia es local al VPS: el mirror off-site requiere una
ubicación y credencial separadas y no se inventa dentro de este instalador.

## Gates de la rama

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
./ops/scripts/validate.sh
pnpm test
```
