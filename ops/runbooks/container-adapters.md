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

## Expectativa de perfil nativo: los dos nombres de una encarnación

La fila `(tenant, alias)` de `agent_profile_runtime_expectations` guarda la `generation` del
contenedor y los sha256 de los documentos de perfil. El gateway la sella dentro de cada entrega
capability-aware y el adaptador la compara contra su propia generación viva antes de ejecutar. Si
no cuadra, la entrega muere al instante con `NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED`, sin
reintento útil y sin que nadie se entere: el alias queda sordo.

Una misma encarnación de contenedor tiene **dos nombres distintos**, y hay que tenerlo presente
porque no se parecen ni en longitud:

| Nombre | Fórmula | Quién lo produce | Quién lo consume |
|---|---|---|---|
| generación del supervisor | `sha256(id \0 startedAt \0 restartCount \0 /proc/1 starttime)`, 64 hex | `container-adapter-supervisor.sh` → `CAUCE_CONTAINER_GENERATION` | el adaptador, y la medición de `runtime_facts` del pty-agent |
| generación de presencia | `sha256(id \| startedAt \| restartCount)` truncada a 32 hex | `cauce-pty-launcher.sh`, va en el hello del pty-agent | el relay, el registro del gateway y **la fila de expectativa** |

La consola sólo observa la presencia que le reporta el relay, así que la fila —y todo contrato
sellado— lleva **siempre** la generación de presencia. Un adaptador que sólo conociera la del
supervisor rechaza el 100% de los contratos reales. Por eso el supervisor deriva las dos y exporta
también `CAUCE_CONTAINER_PRESENCE_GENERATION`, y el preflight acepta cualquiera de las dos: son dos
nombres de la MISMA encarnación, ambos derivados de los mismos hechos del contenedor por el mismo
supervisor. Una tercera generación se sigue rechazando.

### Re-registro automático tras cada arranque

La fila sólo la escribía la consola, así que un contenedor que volvía bajo otra encarnación dejaba
la fila rancia para siempre. `cauce-v3-profile-expectation@<alias>.service` (oneshot) la vuelve a
registrar en cada arranque del adaptador; el `ExecStartPost` de `cauce-v3-container-<alias>.service`
lo lanza con `--no-block`, de modo que ni retrasa ni puede tumbar al adaptador.

El mecanismo entero es el GET a `/v3/console/agents/<alias>/perfil` con el certificado mTLS del
propio alias: cuando el gateway mide el runtime como `current`, re-registra la expectativa desde
esa medición. No puede mentir a favor del alias — una presencia de una encarnación anterior da
hechos vacíos y `unverified`, nunca un `current` con generación rancia—, así que el bucle sólo
termina bien cuando el adaptador y su pty-agent coinciden en la misma encarnación viva.

Comprobarlo:

```sh
# [no ejecutable en verificación]
systemctl --user restart cauce-v3-container-<alias>.service
journalctl --user -u cauce-v3-profile-expectation@<alias>.service -n 20
docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce \
  -c "SELECT alias,generation,updated_at FROM agent_profile_runtime_expectations WHERE alias='<alias>';"
```

Deshacer: borrar los drop-in `cauce-v3-container-<alias>.service.d/profile-expectation.conf`,
`systemctl --user daemon-reload`, y —si además se quiere revertir el supervisor— restaurar
`container-adapter-supervisor.sh.bak-presence-gen`. Sin el drop-in nada más cambia: la variable
extra que exporta el supervisor es inerte para cualquier adaptador que no la lea.
