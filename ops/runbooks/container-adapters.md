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
3. **Paso del dueño, fuera de este árbol**: construir el bundle `release-nuevo` y calcular su digest.
   Este repositorio no trae —ni traerá— el script que lo construye (`/opt` está en la lista NO TOCAR
   de `AGENTS.md`): lo hace el dueño en la máquina destino. `release-nuevo` es el nombre de un
   directorio bajo `<raíz del bundle>/<alias>/releases/`, donde la raíz depende de quién corre el
   supervisor: `/opt/cauce-v3-adapter` en el despliegue como root de la flota, y
   `$XDG_DATA_HOME/cauce-v3-adapter` (`~/.local/share/cauce-v3-adapter`, lo que fijan las unidades
   rootless generadas) cuando lo corre un usuario. El release tiene que cumplir lo que comprueba
   `validate_bundle` (`ops/scripts/container-adapter-supervisor.sh:414-441`):
   - contiene `packages/adapter-sdk/dist/src/bin/<harness>.js`, fichero regular, ejecutable y no
     enlace simbólico (`<harness>` es el arnés asignado al alias);
   - el directorio del release, todas sus entradas y todos sus enlaces simbólicos pertenecen al
     uid que ejecuta el supervisor (`safe_owner_uid` es `$EUID`: root en la flota, el usuario del
     servicio en rootless), sin ningún bit de escritura (`chown -R <uid> …`, `chmod -R a-w …`), y el
     propio release no es un enlace;
   - no hay entradas que no sean fichero, directorio o enlace simbólico (nada de sockets, FIFOs ni
     dispositivos), y todo enlace resuelve dentro del propio release: ninguno se escapa;
   - el digest calculado sobre el release coincide con el `BUNDLE_SHA256` que se fija en el paso 4.

   El `sha256:<digest-nuevo>` sale del mismo ayudante que usan `validate_bundle` y
   `pin-container-release.py` —cualquier otro cálculo dará un digest distinto y el arranque morirá
   con `configured bundle digest differs from pinned immutable release`—:
   ```sh
   # [no ejecutable en verificación]
   python3 ops/container-runtime/cauce-container-runtime.py bundle-digest \
     "$HOME/.local/share/cauce-v3-adapter/kant/releases/release-nuevo"   # rootless; /opt/... como root
   ```
4. Fijar el release mediante compare-and-swap (CAS):
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

El mecanismo entero es el POST a `/v3/console/agents/<alias>/context/reload` con el certificado
mTLS del propio alias y cuerpo vacío: la forma alias-self de la recarga de contexto reescribe los
ficheros de gobierno desde el perfil desired, vuelve a medir el runtime y, si lo mide como
`current`, registra la expectativa desde esa medición (el GET del perfil es de sólo lectura y ya no
escribe nada). No puede mentir a favor del alias — una presencia de una encarnación anterior da
hechos vacíos y `runtime_unverified`, nunca un `current` con generación rancia, y el script
reintenta—, así que el bucle sólo termina bien cuando el adaptador y su pty-agent coinciden en la
misma encarnación viva. `profile_absent` termina en 0 (no hay expectativa que refrescar); los
rechazos que ningún reintento levanta (400/401/403/404, `agent_disabled`, `context_contaminated`)
matan el oneshot al primer intento.

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
