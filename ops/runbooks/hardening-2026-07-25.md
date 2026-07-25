# Runbook de hardening — 2026-07-25

Fuente: 4 diagnósticos de infraestructura viva (ut-nexus backups, Prometheus→Telegram,
watchdog/lifecycle de contenedores, certificados/capacidad). Este runbook es accionable:
cada ítem trae el comando exacto, quién lo corre y qué se verifica después. Orden por
urgencia real (impacto × probabilidad × tiempo ya transcurrido sin acción), no por el
orden en que llegaron los diagnósticos.

Reglas de ejecución: acceso `ssh agora-storage` (root) y `ssh kratos` (usuario `stev`,
shell fish → siempre `ssh kratos bash /tmp/script.sh`, nunca comandos bash inline directos
contra el prompt fish). Por defecto solo lectura; las escrituras de este runbook están
explícitamente autorizadas por ser no disruptivas (no reinician containers/units, no hacen
`docker compose up/down`, no migran, no borran nada salvo lo marcado explícitamente como
limpieza de basura). SQL siempre `BEGIN READ ONLY; ... COMMIT;`. Nunca imprimir secretos.

---

## P0 — urgente, actuar hoy

### 1. Alerta crítica lleva 2+ días firing sin que nadie la vea (`CauceOutboxDeadLettersOpen`)
**Riesgo:** 9 dead letters en el wake outbox desde 2026-07-23 20:13 UTC. Nadie fue
notificado porque Prometheus no tiene ruta de alerting configurada. Puede ser un
componente caído o lógica de reintento rota; cada minuto que pasa son más wakes perdidos.

**Quién ejecuta:** Steven (u operador con acceso root a agora-storage).

**Comando exacto — diagnóstico:**
```bash
ssh root@agora-storage 'docker exec cauce-v3-prod-prometheus-1 wget -q -O - http://localhost:9090/api/v1/alerts 2>/dev/null \
  | jq -r ".data.groups[].rules[] | select(.state==\"firing\") | {name:.name, since:.activeAt, labels:.labels}"'
```
Luego inspeccionar las filas concretas en dead-letter (solo lectura, vía el store de Postgres
del dispatcher — ajustar nombre de tabla/servicio si difiere):
```bash
ssh root@agora-storage 'docker exec cauce-v3-prod-postgres-1 psql -U cauce -d cauce -c "
BEGIN READ ONLY;
SELECT id, kind, reason, created_at, attempts
FROM outbox_dead_letters
WHERE kind='"'"'wake'"'"'
ORDER BY created_at DESC
LIMIT 20;
COMMIT;"'
```
```bash
ssh root@agora-storage 'docker logs cauce-v3-prod-dispatcher-1 --since 72h 2>&1 | grep -iE "dead.letter|wake|outbox" | tail -100'
```
**Verificación posterior:** cada dead letter tiene causa raíz identificada (componente caído,
timeout, payload inválido); si es reprocesable, documentar el plan de reproceso por
separado (este runbook no autoriza reprocesar/borrar filas). Confirmar que el conteo no
sube mientras se investiga: repetir el query cada hora y comparar `count`.

---

### 2. Prometheus no tiene salida a Telegram — 18 reglas de alerta evaluándose "al vacío"
**Riesgo:** el hallazgo #1 de arriba es síntoma de este problema estructural: cualquier
alerta crítica futura (dispatcher caído, leases atascados, colas desbordadas) tampoco se
va a notificar. `prometheus.yml` tiene la sección `alerting` comentada (`# - alertmanager:9093`).
El bridge de Telegram YA funciona (container `cauce-v3-prod-telegram-bridge-1` healthy,
Steven con acceso a alias `kant`/`socrates`) — solo falta cablear Prometheus → Alertmanager
→ webhook → bridge.

**Quién ejecuta:** Steven (decisión de arquitectura: Alertmanager containerizado vs. script
polling). Recomendado: Alertmanager real (más robusto, estándar). El script de polling
(`prometheus-alert-monitor.sh`, 30s de intervalo vía SSH+curl+jq) sirve como mitigación
inmediata de 5 minutos mientras se decide/despliega la solución robusta.

**Mitigación inmediata (hoy, mientras se decide la solución definitiva):**
```bash
ssh root@agora-storage 'docker exec cauce-v3-prod-prometheus-1 wget -q -O - http://localhost:9090/api/v1/alerts 2>/dev/null \
  | jq -r ".data.groups[].rules[] | select(.state==\"firing\") | .name" \
  | sort -u'
```
Correr este comando manualmente cada pocas horas hasta tener Alertmanager, o programarlo
como chequeo recurrente (ver skill `loop`/`schedule` si Steven quiere automatizarlo desde
Claude Code en vez de cron en el host).

**Solución definitiva (esta semana):**
1. Confirmar con el agente que generó el diagnóstico dónde quedaron los archivos ya
   preparados `alertmanager.yml` y `alert-webhook-handler.py` (el diagnóstico los declara
   como entregados pero no registra el path final — verificar antes de aplicar, no asumir).
2. Descomentar el target de alerting en `prometheus.yml`:
   ```bash
   ssh root@agora-storage 'grep -n "alertmanager:9093" /path/a/prometheus.yml'
   # editar manualmente: quitar el "#" de "- alertmanager:9093"
   ```
3. Levantar Alertmanager en la red `cauce-v3-prod_backend` apuntando al webhook handler,
   y el webhook handler apuntando al bridge de Telegram vía el DNS interno `prometheus`/
   `telegram-bridge`. Config de routing ya definida: `critical` cada 1h, `warning` cada 6h.
4. Recargar Prometheus sin reiniciar el container (hot reload, no interrumpe scraping):
   ```bash
   ssh root@agora-storage 'docker exec cauce-v3-prod-prometheus-1 wget -q -O - --post-data="" http://localhost:9090/-/reload'
   ```
**Verificación posterior:**
```bash
ssh root@agora-storage 'docker exec cauce-v3-prod-prometheus-1 wget -q -O - http://localhost:9090/api/v1/status/config 2>/dev/null | grep -A2 alerting'
```
Provocar una alerta de prueba (p. ej. bajar temporalmente un target no crítico) o esperar a
que la de dead-letters siga firing y confirmar que llega un mensaje a Telegram (alias
`kant`, chat 6979524541) dentro de los 5 minutos.

---

## P1 — crítico, esta semana

### 3. Backups de ut-nexus sin automatizar (hoy son corridas manuales)
**Riesgo:** sin cron, la continuidad de backups depende de que alguien se acuerde de
correr el script. `worker.api_keys` de 30 workers + 12 agents + 5 tenants viven en un
único SQLite de 4.1 MB — perderlo sin backup reciente es pérdida total de reconexión
automática.

**Ya resuelto (no repetir):** el mecanismo de backup en sí es robusto y está verificado —
usa `sqlite3 Connection.backup()` en modo `?mode=ro`, snapshot atómico de db+WAL sin
bloquear el servicio, y las dos corridas de hoy (02:53 y 02:54 UTC) pasaron
`PRAGMA integrity_check=ok`, checksums SHA256, 8 tablas y 49 filas verificadas. No hace
falta rehacer ni validar el script — solo programarlo.

**Quién ejecuta:** Steven (root en agora-storage).

**Comando exacto (Opción A del audit: diario 03:17 UTC, retención 30 días):**
```bash
ssh root@agora-storage 'test -f /opt/_archive/ultimate-terminal/backup-ut-nexus.py && echo FOUND || echo "AJUSTAR PATH: script no está donde se asume"'
```
```bash
ssh root@agora-storage 'cat > /etc/cron.d/ut-nexus-backup <<EOF
17 3 * * * root /usr/bin/python3 /opt/_archive/ultimate-terminal/backup-ut-nexus.py >> /var/log/ut-nexus-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/ut-nexus-backup'
```
**Verificación posterior:** al día siguiente después de las 03:17 UTC:
```bash
ssh root@agora-storage 'ls -la /var/log/ut-nexus-backup.log && tail -30 /var/log/ut-nexus-backup.log'
ssh root@agora-storage 'python3 /opt/_archive/ultimate-terminal/verify-backup.py --list --latest'
```
Confirmar que aparece un backup nuevo con timestamp de esa noche y `integrity_check=ok`.

---

### 4. Backups de ut-nexus en el mismo disco que los datos vivos (single point of failure)
**Riesgo:** volumen Docker y TODOS los backups (incluidos los viejos en `/root/backups/`)
están en agora-storage. Una falla de disco de ese host es pérdida total, sin ruta de
recuperación.

**Quién ejecuta:** Steven decide el destino final (MinIO existente / disco secundario / S3
— Opción C del audit, sin decidir todavía). Mitigación de bajo costo mientras se decide:
espejar a kratos, que es un host físico distinto.

**Comando exacto (mitigación inmediata, requiere confirmar SSH saliente agora-storage→kratos):**
```bash
ssh root@agora-storage 'ssh -o BatchMode=yes -o ConnectTimeout=5 stev@kratos true && echo "SSH agora-storage -> kratos: OK" || echo "FALTA configurar clave SSH saliente"'
```
Si hay acceso, agregar al mismo cron (después del backup, con `&&` para no correr sobre un
backup a medio escribir; ajustar el directorio de salida real del script, no asumido aquí):
```bash
ssh root@agora-storage 'cat > /etc/cron.d/ut-nexus-backup <<EOF
17 3 * * * root /usr/bin/python3 /opt/_archive/ultimate-terminal/backup-ut-nexus.py >> /var/log/ut-nexus-backup.log 2>&1 && rsync -az --delete /opt/_archive/ultimate-terminal/backups/ stev@kratos:/home/stev/ut-nexus-backups-mirror/ >> /var/log/ut-nexus-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/ut-nexus-backup'
```
(Esto reemplaza el cron del ítem 3 con la versión que también espeja — no correr ambos.)

**Verificación posterior:**
```bash
ssh kratos bash -c 'ls -la /home/stev/ut-nexus-backups-mirror/ && du -sh /home/stev/ut-nexus-backups-mirror/'
```
Confirmar que el archivo más reciente en kratos tiene el mismo SHA256 que el original en
agora-storage:
```bash
ssh root@agora-storage 'sha256sum /opt/_archive/ultimate-terminal/backups/<archivo-mas-reciente>.sqlite'
ssh kratos bash -c 'sha256sum /home/stev/ut-nexus-backups-mirror/<mismo-archivo>.sqlite'
```

---

### 5. Kratos al 61% de disco con 36GB+ de imágenes Docker sin usar
**Riesgo:** partición en 176GB/300GB. Imágenes identificadas como no usadas: `speaches`
(8.6GB), `ollama` (8GB — nota: Ollama ya fue dado de baja por pedido de Steven, esta imagen
es puro desperdicio), `open-webui` (6.7GB), stack `wazuh` (~8GB). Sin acción, degrada
performance de operaciones Docker y reduce margen operativo.

**Quién ejecuta:** Steven (o cualquiera con acceso a kratos).

**Comando exacto:**
```bash
cat > /tmp/kratos-docker-cleanup.sh <<'EOF'
#!/bin/bash
set -euo pipefail
echo "Antes:"; df -h /
echo "Imagenes candidatas a prune (>30 dias sin uso):"
docker image prune -a --filter "until=720h" --dry-run 2>&1 || true
EOF
ssh kratos bash /tmp/kratos-docker-cleanup.sh
```
Revisar el dry-run manualmente (confirmar que no incluye nada en uso activo) y luego, con
confirmación explícita de Steven, ejecutar sin `--dry-run`:
```bash
ssh kratos bash -c 'docker image prune -a --filter "until=720h" --force'
```
**Verificación posterior:**
```bash
ssh kratos bash -c 'df -h / && docker images -a | wc -l'
```
Confirmar espacio liberado (~36GB esperado) y que ningún container en ejecución quedó sin
su imagen base (`docker ps` sigue mostrando todos los containers healthy, sin restarts
nuevos).

---

## P2 — alto, próximas 1-2 semanas

### 6. Sin alerta de staleness/fallo de backup de ut-nexus
**Riesgo:** si el cron del ítem 3/4 falla silenciosamente (disco lleno, permiso, script
roto), nadie se entera hasta que haga falta restaurar.

**Ya existe la herramienta** (no hay que crearla): `verify-backup.py` soporta "monitor age
with alert thresholds".

**Quién ejecuta:** Steven, después de que el ítem 2 (Alertmanager→Telegram) esté en pie —
reusar el mismo canal en vez de crear uno paralelo.

**Comando exacto (chequeo diario de staleness, agregado al mismo `/etc/cron.d/ut-nexus-backup`):**
```bash
ssh root@agora-storage 'cat >> /etc/cron.d/ut-nexus-backup <<EOF
30 3 * * * root /usr/bin/python3 /opt/_archive/ultimate-terminal/verify-backup.py --check-age --max-age-hours 48 --notify-file /run/cauce-telegram/kant.token >> /var/log/ut-nexus-backup.log 2>&1
EOF'
```
(Ajustar flags reales del script — el diagnóstico confirma que soporta "monitor age with
alert thresholds" pero no lista los flags exactos; correr `--help` antes de asumir.)
```bash
ssh root@agora-storage 'python3 /opt/_archive/ultimate-terminal/verify-backup.py --help'
```
**Verificación posterior:** simular staleness bajando el `max-age-hours` a un valor menor
que el backup actual y confirmar que dispara la notificación; luego revertir al valor real
(48h).

---

### 7. Sin test de restore en frío (cold-start) fuera de agora-storage
**Riesgo:** el procedimiento de `RESTORE.md` está documentado y verificado *sobre el papel*,
pero nunca se ejecutó en una máquina aislada. Un RESTORE.md que falla en la práctica es
peor que no tenerlo, porque da falsa confianza.

**Quién ejecuta:** Steven (requiere una máquina/VM aislada, no producción).

**Comando exacto:** no aplica un one-liner — es un ejercicio manual siguiendo `RESTORE.md`
método (b) (container Docker con mount read-only) contra una copia del backup más reciente,
en una VM que no sea agora-storage ni kratos.

**Verificación posterior:** documentar tiempo total de restore, cualquier paso que no
coincidió con lo escrito en `RESTORE.md`, y corregir el doc si hace falta (fuera del
alcance de este runbook — abrir issue separado).

---

## P3 — monitoreo, sin cambios de código pendientes

### 8. Watchdog + claim renewal — ya resuelto, solo observar 7 días
**Estado: RESUELTO.** El patrón de disparo del watchdog ya fue acotado a
`SIGRE='Polling stall detected'` el 2026-06-14 (antes disparaba también por
`MissingAgentHarnessError` y `received SIGTERM`, causando restarts innecesarios). El
mecanismo de renovación de claims (`startClaimRenewal`/`loseClaim`/`confirmClaim`) se
desplegó el 2026-07-24 (commit `5f46924`) y ya maneja el caso de restart-en-medio-de-delivery
sin orfanar el trabajo. `claw-miguel` tiene 0 restarts y sin errores en los últimos 5+ días.
No hay acción de código pendiente — solo confirmar que se sostiene.

**Quién ejecuta:** cualquiera, chequeo liviano, correr una vez por día durante 7 días.

**Comando exacto:**
```bash
ssh kratos bash -c 'docker logs claw-miguel --since 24h 2>&1 | grep -c "Polling stall detected"'
ssh kratos bash -c 'docker inspect claw-miguel --format="{{.RestartCount}}"'
ssh kratos bash -c 'docker logs claw-miguel --since 24h 2>&1 | grep -c "CLAIM_OWNERSHIP_LOST"'
```
**Verificación posterior:** si "Polling stall" > 1/día, investigar falsos positivos en el
healthcheck del gateway. Si "CLAIM_OWNERSHIP_LOST" > 5/día, investigar por qué el
container reinicia tan seguido (síntoma de un problema distinto, no del mecanismo en sí).
Si ambos se mantienen en 0-bajo durante los 7 días, cerrar este ítem sin más acción.

---

### 9. Certificados — ya resuelto / sin acción, solo un checkpoint de calendario
**Estado: RESUELTO.** PKI interno (agentes, gateway, console, postgres) vence recién en
octubre 2028; la CA raíz en julio 2031 — sin riesgo en los próximos 3 años. Let's Encrypt
(12 dominios `prisma-enterprice.cloud`/`elenxos.com`) se renueva automáticamente vía Caddy
con ACME/ARI, sin errores en los logs. No requiere ninguna acción ahora.

**Quién ejecuta:** Steven, un solo checkpoint calendarizado.

**Comando exacto (correr el 2026-09-20, 5 días antes del primer vencimiento):**
```bash
ssh root@agora-storage 'journalctl -u caddy -S "2026-09-15" | grep -i renewal'
```
**Verificación posterior:** confirmar que los 12 dominios muestran renovación exitosa antes
del 2026-09-25 (primer vencimiento, `voz.prisma-enterprice.cloud`). Si Steven quiere que
este checkpoint sea automático en vez de manual, usar la skill `schedule` para crear un
recordatorio cloud agendado — no incluido en este runbook porque implica crear un recurso
nuevo, no solo documentarlo.

---

### 10. Limpieza de baja prioridad (opcional, impacto bajo)
**Riesgo:** ninguno urgente — housekeeping.

- Backups viejos degradados (`/root/backups/ultimate-terminal/`, solo `.db` sin WAL, de
  2026-07-19/20): mantener como último recurso histórico, no borrar hasta tener al menos
  30 días de backups automatizados nuevos (ítem 3) funcionando establemente.
- `/opt/cauce-v3-candidates` en agora-storage (584MB, 4 builds): retener solo los 2 más
  recientes cuando el disco de agora-storage se acerque al 50% (hoy 34%, sin apuro).
  ```bash
  ssh root@agora-storage 'ls -lt /opt/cauce-v3-candidates/ | tail -n +4'
  ```
  (listar primero, confirmar con Steven cuáles borrar, nunca automatizar el `rm` de esto
  sin revisión humana — son artefactos de build, no logs).

**Quién ejecuta:** Steven, sin fecha límite.
**Verificación posterior:** `df -h` antes/después en agora-storage.

---

## Resumen de estado

| # | Ítem | Prioridad | Estado |
|---|------|-----------|--------|
| 1 | Dead letters wake outbox firing 2+ días | P0 | **Pendiente — investigar hoy** |
| 2 | Prometheus sin ruta a Telegram | P0 | **Pendiente — mitigación hoy, definitivo esta semana** |
| 3 | Backup ut-nexus sin cron | P1 | Pendiente |
| 4 | Backup ut-nexus sin réplica off-host | P1 | Pendiente |
| 5 | Kratos 61% disco, 36GB imágenes sin usar | P1 | Pendiente |
| 6 | Sin alerta de staleness de backup | P2 | Pendiente (depende de #2) |
| 7 | Sin test de restore en frío | P2 | Pendiente |
| 8 | Watchdog / claim renewal | P3 | **Ya resuelto — solo observar 7 días** |
| 9 | Certificados (PKI interno + Let's Encrypt) | P3 | **Ya resuelto — checkpoint 2026-09-20** |
| 10 | Limpieza de baja prioridad | P3 | Opcional, sin apuro |

Mecanismo de backup de ut-nexus en sí (`sqlite3 Connection.backup()`, modo read-only,
snapshot atómico db+WAL): **ya validado, no requiere trabajo adicional** — el problema es
exclusivamente falta de automatización (#3) y falta de redundancia geográfica (#4), no la
calidad del backup.
