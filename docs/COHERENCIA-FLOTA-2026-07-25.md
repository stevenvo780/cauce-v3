# Coherencia de flota Cauce V3 — informe accionable (2026-07-25)

Alcance: consolidación de **tres** investigaciones recibidas en esta sesión: (1) verificación de
harnesses declarados vs. binarios ejecutados en el adapter SDK, (2) estado del gate snapshot
collector para migraciones, (3) procesos zombie / almacenamiento acumulado en la flota
kratos/agora-storage.

> **Nota de reemplazo.** En esta misma ruta existía previamente un informe con fecha 2026-07-25
> generado por una corrida anterior de este encargo, que según su propio texto solo había recibido
> **una** de las tres investigaciones ("Nota de encuadre" en ese documento). Ese informe cubría una
> auditoría distinta y más granular (PATH hijack del binario del harness, zombies específicos de
> `ctrl-infra`, purga de `sessions.json`, código muerto de `opencode`), con verificación en vivo vía
> SSH que esta corrida no repitió. Este documento lo **reemplaza** porque la tarea actual pide
> consolidar explícitamente las tres investigaciones nuevas recibidas ahora. Si ese informe anterior
> contenía hallazgos vigentes no cubiertos acá (en particular R1 sobre PATH hijack del harness, que es
> de severidad alta), **no se perdieron**: quedan en el historial de artefactos de la sesión anterior
> y conviene que Steven los recupere y los concilie con este documento antes de cerrar el tema por
> completo. Este informe no los reafirma ni los descarta porque no forman parte del material de
> entrada de esta corrida.

Modo de trabajo de esta corrida: no se ejecutó ningún comando contra producción; todo lo que sigue
proviene de las tres investigaciones entregadas como texto. Ningún comando de este documento fue
corrido — se indica exactamente cuál es y quién debe ejecutarlo.

## Resumen ejecutivo

De las tres investigaciones, **una es una falsa alarma completa** (no hay divergencia de harnesses en
el adapter SDK) y **dos contienen deuda operativa real**, ninguna de ellas un incidente activo hoy.
La de mayor riesgo real es la falta de despliegue del gate collector mientras hay un rollout de
renovación de harness en curso (ver commits recientes `26361ff`, `44f4b41`, `5f46924`, `774a0bd`,
`480a611` en este mismo repo): si durante ese rollout se necesita un cutover o rollback, los scripts
que dependen del collector (`cutover.sh`, `cutover-rollback.sh`, `guard-check.sh`) no tienen con qué
capturar el snapshot de gate.

| # | Hallazgo | Severidad | Requiere aprobación de Steven | Es escritura en prod |
|---|---|---|---|---|
| H1 | Gate snapshot collector no está desplegado en producción | **Alta** (por timing: rollout de harness en curso) | Sí | Sí |
| H2 | ~1.1 TB acumulados en `/opt` (agora-storage): candidatos, failed-gate, archive | **Media** | Sí (parcial) | Sí |
| H3 | 2.113 procesos zombie en kratos | **Media-baja** | Sí para cualquier mitigación (reinicios) | Sí para mitigar, No para diagnosticar |
| FA1 | "Divergencia entre harness declarado y binario ejecutado" en el adapter SDK | **Falsa alarma** | — | — |

---

## H1 — Gate snapshot collector implementado pero no desplegado en producción

**Qué está mal.** Existe una implementación completa y aparentemente lista
(`ops/scripts/gate-collector.mjs`, `ops/GATE_CONTRACT.md`, `ops/tests/gate-collector.test.mjs`,
`ops/INSTALLATION.md`, `ops/GATE_SNAPSHOT_EXAMPLES.md`) para capturar snapshots de las 8 fases de gate
de migración, pero según la investigación **no hay evidencia de que esté instalada en kratos**: no
hay binario en `/usr/local/bin/cauce-gate-collector`, no hay `/etc/cauce-v3/guards/gate-collector.env`,
ni timers systemd `cauce-v3-watchdog.timer` / `cauce-v3-reconciler.timer` activos. Esto es una
inferencia a partir del contenido de la investigación (describe el despliegue como un procedimiento
pendiente, no como un hecho consumado) — **debe confirmarse en vivo antes de actuar** (ver
verificación abajo).

**Por qué importa.** `ops/scripts/cutover.sh`, `cutover-rollback.sh` y `guard-check.sh` dependen de
`CAUCE_GATE_CAPTURE_PATH` para poder validar cada una de las 8 fases del contrato de migración
(preflight, drain, post-cutover, canary, rollback-drain, rollback-ready, watchdog, reconciler). Sin el
collector instalado, esa variable no apunta a nada ejecutable y esos scripts **no pueden certificar**
que una fase de migración cumple sus invariantes (cardinalidad de consumers/pollers/leaseOwners,
estado de drain, salud de acks, backlog de colas, validación round-trip). El repo tiene commits muy
recientes de renovación de harness (`26361ff` "hand off harness renewal rollout", `5f46924` "renew
durable agent delivery claims", `774a0bd` "defer nested responses until continuation", `480a611`
"resume delegated reviews before fan-in") — es decir, **hay actividad de migración/rollout en curso
ahora mismo**. Si en medio de eso hiciera falta un cutover o un rollback, se haría a ciegas respecto
del contrato de gate.

**Verificación previa (solo lectura, ejecutar primero para confirmar el hallazgo antes de instalar
nada).** Ejecuta: Steven (o Claude vía `ssh kratos`, ambos de solo lectura).

```bash
ssh kratos "test -x /usr/local/bin/cauce-gate-collector && echo PRESENTE || echo AUSENTE"
ssh kratos "systemctl --user list-timers 'cauce-v3-watchdog.timer' 'cauce-v3-reconciler.timer' 2>&1"
ssh kratos "test -f /etc/cauce-v3/guards/gate-collector.env && echo PRESENTE || echo AUSENTE"
```

**Corrección — solo si la verificación anterior confirma AUSENTE.** Procedimiento tal como lo entrega
la investigación (es escritura sobre producción: crear directorios, instalar binario, escribir
credenciales de DB, crear y habilitar units systemd). Ejecuta: **Steven**, como `stev` en kratos.

```bash
# 1. Directorios
mkdir -p /etc/cauce-v3/guards /var/lib/cauce-v3/gates
chmod 0700 /etc/cauce-v3/guards
chmod 0755 /var/lib/cauce-v3/gates

# 2. Instalar el collector (repo -> destino)
install -m 0755 /workspace/cauce-v3/ops/scripts/gate-collector.mjs /usr/local/bin/cauce-gate-collector

# 3. Env con credenciales de DB (mode 0600, revisar CAUCE_DATABASE_URL antes de escribir el archivo)
#    editar a mano /etc/cauce-v3/guards/gate-collector.env, luego:
chmod 0600 /etc/cauce-v3/guards/gate-collector.env

# 4. Units systemd --user (watchdog 300s, reconciler 600s) según ops/INSTALLATION.md,
#    iterando los 12 alias.
systemctl --user daemon-reload
systemctl --user enable cauce-v3-watchdog.timer cauce-v3-reconciler.timer
systemctl --user start cauce-v3-watchdog.timer cauce-v3-reconciler.timer

# 5. Verificación funcional (no destructiva) contra un alias de bajo riesgo, ej. kant
/usr/local/bin/cauce-gate-collector kant /tmp/test.json drain
node /workspace/cauce-v3/ops/scripts/migration-gate.mjs drain /tmp/test.json kant
# esperar: "gate drain passed for kant"

# 6. Monitoreo de los primeros ciclos
systemctl --user list-timers cauce-v3-*
journalctl --user-unit=cauce-v3-watchdog.service -f
```

**Antes de aplicar, revisar con la investigación 3 puntos que quedaron señalados como riesgo:** las
credenciales de DB en el `.env` deben quedar 0600 y solo legibles por el usuario del servicio; el
patrón de discriminación V2/V3 por `instance_id` (`systemd-*`, `*container*`, `cauce-v3-*`) debe
confirmarse contra los patrones reales en producción antes de confiar en el resultado; la lista de 12
alias está hardcodeada en el `ExecStart` de los timers y hay que actualizarla a mano si cambia la
flota.

**Quién ejecuta.** La verificación de ausencia/presencia la puede correr Claude (solo lectura). La
instalación completa (escritura, crea archivos con credenciales, habilita timers) la ejecuta
**Steven**.

---

## H2 — ~1.1 TB acumulados en `/opt` en agora-storage

**Qué está mal.** `/opt/_archive/cauce-v3-releases` (313.4M), `/opt/cauce-v3-candidates` (581M),
`/opt/cauce-v3-failed-gate` (273M) y `/opt/cauce-v3-builds` (6.9M) acumulan artefactos de releases,
candidatos y builds fallidos sin política de purga automática visible en la investigación.

**Por qué importa.** No es un incidente hoy (la investigación no reporta presión de disco crítica),
pero el volumen crece con cada ciclo de release/candidate/failed-gate y, si no se poda, termina
compitiendo por espacio con lo que sí debe conservarse: el release `2026-07-23` en
`/opt/_archive/cauce-v3-releases` es la base de rollback exigida por el handoff de renovación de
harness (commit `26361ff`) y **no puede borrarse**.

**Corrección — Fase 1, bajo riesgo, sin necesidad de aprobación adicional.** Ejecuta: **Steven** (o
quien tenga acceso root a agora-storage; esta sesión es de solo lectura y no puede ejecutar esto).

```bash
rm -rf /opt/cauce-v3-builds/fanin-*
```

**Corrección — Fase 2, requiere aprobación explícita de Steven antes de correr, porque toca
candidatos y directorios de failed-gate que podrían seguir siendo referenciados.** Ejecuta: Steven.

```bash
# Confirmar primero que 44f4b41 está en main y no fue revertido:
git -C /workspace/cauce-v3 log --oneline -1 44f4b41

# Si está confirmado estable:
rm -rf /opt/cauce-v3-failed-gate-44f4b41064113208fd53bc45289740994f3a5653   # 273M
rm -rf /opt/cauce-v3-candidates/774a0bdff5e6c0be2b234505560ce80a50ad7d21    # 35M
rm -rf /opt/cauce-v3-candidates/44f4b41064113208fd53bc45289740994f3a5653   # 257M, solo si el commit está estable
```

**Antes de tocar nada, verificar si los candidatos más nuevos siguen en evaluación** —
`842d42b...` (257M, capturado 25-jul 01:10) y `9d36aa75...` (35M, capturado 25-jul 00:41) son de hoy
mismo; no se deben borrar sin que Steven confirme que ya no están en evaluación para el próximo
deploy.

```bash
ls -lhd /opt/cauce-v3-candidates/842d42b* /opt/cauce-v3-candidates/9d36aa75* 2>/dev/null
```

**Nunca hacer (per handoff de harness renewal, commit `26361ff`).**

```bash
# PROHIBIDO — rompe la cadena de rollback documentada en el handoff:
rm -rf /opt/_archive/cauce-v3-releases/2026-07-23
```

**Verificación final tras cada fase.** Ejecuta: Steven.

```bash
du -sh /opt/cauce-v3-* /opt/_archive/cauce-v3-releases
```

**Quién ejecuta.** Todo lo anterior es escritura sobre producción (`rm -rf`), por lo que esta sesión
de solo lectura no puede ejecutarlo. Lo ejecuta **Steven** (o un operador con root en agora-storage
explícitamente autorizado por él), fase por fase, verificando `du -sh` entre una y otra.

---

## H3 — 2.113 procesos zombie en kratos

**Qué está mal.** `ps aux | grep '<defunct>'` en kratos devuelve 2.113 líneas: mayormente `node`
(~900+), `esbuild` (~150), `python3` (~100), y un remanente de `opencode` (~5) y `antigravity` (~5).
Procesos con `PPID=1` indican padres que no hicieron `wait()` sobre sus hijos.

**Por qué importa.** Los zombies no consumen memoria ni CPU relevantes, pero sí ocupan entradas de la
tabla de procesos; en un host compartido por varias flotas, una acumulación sin límite puede
eventualmente degradar la capacidad de crear procesos nuevos. Es también un síntoma — no la causa —
de servicios (probablemente test runners paralelos o workers en background) que no reapean hijos
correctamente. El remanente de procesos `opencode` es especialmente relevante: OpenCode-Go fue
removido como proveedor el 2026-07-17 por veto explícito de Steven (ver CLAUDE.md de la flota); que
todavía aparezcan procesos `<defunct>` de `opencode` sugiere código residual que sigue intentando
invocarlo.

**Diagnóstico (solo lectura, sin riesgo).** Ejecuta: Steven o Claude vía SSH de solo lectura.

```bash
ssh kratos "ps -eo pid,ppid,stat,etime,cmd | grep -c 'Z '"
ssh kratos "ps -eo ppid,cmd --no-headers | grep -v grep | awk '{print \$1}' | sort | uniq -c | sort -rn | head -20"
# para inspeccionar el padre de un zombie puntual:
ssh kratos "ps -o pid,ppid,cmd -p <PID_DEL_PADRE>"
```

**Corrección.** No hay un comando de un solo paso que "limpie" zombies sin tocar producción: la única
forma de que el kernel reclame esas entradas es que el proceso padre haga `wait()` (requiere un fix de
código en el servicio que los genera) o que el proceso padre se reinicie. Esta sesión es de **solo
lectura sobre producción** y no puede reiniciar ningún servicio; cualquier reinicio dirigido a limpiar
zombies queda fuera de este mandato.

**Investigación de causa raíz (no destructiva, previa a cualquier mitigación).** Ejecuta: Steven,
delegable a Claude/Codex para el análisis de código una vez identificado el servicio.

1. Cruzar los PPID de los zombies con `systemctl --user status` / `docker ps` para identificar a qué
   servicio o container pertenecen.
2. Revisar configuración de test runners (jest/vitest) y workers en background del harness de Claude
   Code por procesos hijos sin `await`/`wait()`.
3. Para el remanente de `opencode`: buscar en el repo y en scripts de arranque cualquier referencia
   viva a `opencode-go` (debería estar completamente removido desde 2026-07-17) y abrir ticket de
   limpieza si aparece.

**Quién ejecuta.** El diagnóstico (comandos de arriba) lo puede correr esta sesión o Steven, ambos de
solo lectura. La mitigación real (reiniciar el servicio padre o corregir el código que no reapea
hijos) requiere escritura sobre producción y la ejecuta **Steven**, coordinado con quien mantenga el
servicio identificado como origen.

---

## Falsa alarma

### FA1 — "Divergencia entre harness declarado y binario ejecutado" en el adapter SDK: **no confirmada, la evidencia dice lo contrario**

La investigación 1 concluye que el adapter SDK de Cauce V3 está **completamente sincronizado** con los
manifiestos: los 12 alias ejecutan exactamente el binario del harness declarado en
`ops/manifests/{alias}.yaml`, sin overrides ocultos (`CAUCE_HARNESS_COMMAND` existe en
`packages/adapter-sdk/src/bin/config.ts:145-176` pero no está declarado en ningún manifiesto de
producción). Los procesos que en algún momento se atribuyeron como "divergentes" (`claude --settings
...`, `python3 codex_bridge_v3.py`, `node codex --dangerously-bypass-approvals`) **no pertenecen al
adapter de Cauce V3**: son de otras flotas que conviven en los mismos containers (clawbus,
claude-fleet, ultimate-terminal worker).

**No hay ningún cambio de código recomendado.** Si la confusión persiste, el procedimiento de
diagnóstico (solo lectura, sin riesgo) es:

```bash
ps --forest -p $(systemctl show -p MainPID --value cauce-v3-container-<alias>.service)
docker exec $(docker ps -q -f name=<container>) ps -o pid,ppid,cmd | grep -E 'codex|claude|hermes'
cat /proc/<pid>/cgroup   # confirmar que procesos de flotas distintas están en cgroups distintos
```

**Quién ejecuta.** Nadie tiene que corregir nada. Si se quiere dejar constancia para evitar que la
confusión se repita, alcanza con anotar en el runbook de la flota que kratos multiplexa varias flotas
en los mismos containers y que el árbol de procesos correcto del adapter Cauce siempre cuelga de
`python3 cauce-container-runtime.py run --alias <alias>` → `python3 guard-exec` → `node
{harness}.js`.

---

## Orden de ejecución sugerido

1. **Ya, sin riesgo:** verificación de presencia/ausencia del gate collector (H1) y diagnóstico de
   zombies (H3). Ninguna toca producción.
2. **Con aprobación de Steven, baja fricción:** Fase 1 de limpieza de `/opt/cauce-v3-builds/fanin-*`
   (H2), 6.9M, riesgo bajo.
3. **Antes de cualquier próximo cutover/rollback del rollout de harness en curso:** desplegar el gate
   collector (H1) si la verificación confirma que no está instalado — es el hallazgo de mayor riesgo
   real dado el timing.
4. **Con aprobación de Steven, tras confirmar candidatos recientes:** Fase 2 de limpieza de `/opt`
   (H2), ~565M adicionales.
5. **Investigación de código, sin apuro:** causa raíz de los zombies (H3) y limpieza de referencias
   residuales a `opencode-go`.
6. **Pendiente de conciliar por separado:** revisar el informe de la corrida anterior en esta misma
   ruta (ver nota de reemplazo arriba) para no perder el hallazgo de PATH hijack del binario del
   harness, que no formó parte del material de entrada de esta corrida pero es de severidad alta según
   ese documento.
