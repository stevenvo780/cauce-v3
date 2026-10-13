# Hospital: aislamiento antes del corte de Praxis

Este procedimiento prepara el destino y se ejecuta en una ventana autorizada por el
integrador. El compose `hospital-agent` vive fuera de este repositorio. Una revisión
de código o una sonda dentro del contenedor no acredita el aislamiento desplegado.
Los agentes Muse conservan `--yolo`: la frontera es el contenedor y la política del
host, no la aprobación de herramientas del arnés.

La importación de Praxis en la V4 central es otro procedimiento. `praxis-v4.json` es su inventario y
`praxis-perfiles-export.sql` la exportación de solo lectura de los perfiles vivos.
`cauce platform empresa importar` los consume. Los pasos están en
`docs/v4-migracion-plan.md`, §4, «Alta e importación de Praxis en la V4 central».

## Retirar el fallback del operador

Antes del aprovisionamiento, conservar una copia privada recuperable del estado y
del compose con el mecanismo de backup existente. En el estado del operador:

1. Retirar `muse-cli/*` de `agents.defaults.model.fallbacks` de
   `~/.openclaw/openclaw.json`, las entradas `hospital-muse-native` de
   `plugins.entries`, `plugins.allow` y `plugins.load.paths`, y cualquier definición
   de `muse-cli` en `cliBackends`. No imprimir la configuración: contiene secretos.
2. Retirar la extensión `~/.openclaw/extensions/hospital-muse-native`.
3. Quitar del servicio del operador los binds `state-muse-operator` y
   `muse-code-bin`, incluso si se montan bajo otro destino, y cualquier opt-in Muse
   de su entorno. Conservar los estados propios de Teseo y Perseo.
4. Mantener `CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK=0`. `provision-agents.sh`
   rechaza `1`: el contenedor independiente y su socket de propósito único siguen
   sin construir. El opt-in histórico del plugin no habilita el corte V4.

## Instalar la frontera confiable

Como root del host, desde el checkout revisado, instalar el runtime con la
herramienta existente antes de crear el bind. El instalador conserva el inodo del
directorio y reemplaza sus archivos; no sustituir el directorio montado.

```sh
python3 -I ops/instances/hospital/operator-runtime-guard.py install \
  --source ops/instances/hospital
```

Añadir este volumen al servicio existente; no crear una segunda pila:

```yaml
services:
  openclaw-operator-gateway:
    volumes:
      - type: bind
        source: /opt/cauce-hospital/runtime
        target: /opt/cauce-hospital/runtime
        read_only: true
        bind:
          create_host_path: false
```

Recrear solo el servicio modificado durante la ventana. El runtime y sus ancestros
deben ser de root y no escribibles por el agente. El backend y los productores de
evidencia se invocan desde ese bind con Python `-I -B`. La ruta legacy
`.cauce/runtime` está dentro de un workspace escribible: un archivo de root allí
puede sustituirse renombrando un ancestro. No ejecutar código confiable desde ella.

```sh
python3 -I ops/instances/hospital/operator-runtime-guard.py verify-boundary \
  --alias operador --container hospital-agent-openclaw-operator-gateway-1
python3 -I ops/instances/hospital/operator-runtime-guard.py verify \
  --container hospital-agent-openclaw-operator-gateway-1 --muse-fallback 0
python3 -I ops/instances/hospital/operator-runtime-guard.py verify-boundary \
  --alias teseo --container hospital-agent-muse-backend-1
python3 -I ops/instances/hospital/operator-runtime-guard.py verify-boundary \
  --alias perseo --container hospital-agent-muse-frontend-1
```

`verify-boundary` usa metadatos del daemon y lee la configuración del operador
desde su bind en el host, con lectura acotada y sin seguir enlaces. Exige uid/gid
1000, raíz de solo lectura, `no-new-privileges`, `cap_drop: [ALL]` sin `cap_add`, ausencia de privilegios y de
namespaces/dispositivos/socket Docker del host. Rechaza aliases escribibles del
runtime y montajes de estado Muse en el operador. Para los developers, la lista
cerrada contiene su estado Muse, binario fijado de solo lectura, workspace,
candidato CRM, Praxis propio, upstream del operador de solo lectura y delegación
tipada `hospital-access` propia de solo lectura; no sus credenciales de director.
Los binds y redes conservan los nombres canónicos de la instancia Hospital. Para
temporales se admite únicamente un tmpfs en `/tmp`; configurarlo con tamaño
acotado y `noexec,nosuid,nodev`. La raíz de solo lectura protege los ancestros del
bind incluso si los comandos de la imagen han sido sustituidos.

## Egress y aceptación pendiente

Las redes propias de los developers evitan compartir la red del navegador, CRM y
operador; no filtran por sí solas la salida. Revisar desde el host los metadatos
de `docker network inspect`, las reglas efectivas IPv4 e IPv6 y la política de
proxy/firewall. Deben permitir únicamente la API del proveedor y los endpoints
Cauce/dependencias explícitamente aprobados, y bloquear LAN, metadatos de nube,
Docker, CDP, hospital-ops y servicios ajenos. Los destinos e IP deben resolverse
desde el inventario real, sin asumir una lista estable de IP del proveedor.

Conservar un recibo del SHA, política y resultados permitidos/bloqueados. Ensayar
las reglas con un cliente de confianza en una red de prueba equivalente, sin
usar credenciales ni ejecutar herramientas del agente. Los `docker exec` del
guard son diagnósticos: el agente puede sustituir sus binarios o su salida. La
alerta `incomplete-trust-boundary` solo se cierra con el bind inspeccionado, la
custodia del host, el estado sin fallback y evidencia independiente de egress.

La raíz escribible de la imagen también puede contener código o credenciales
copiados anteriormente; revisar la imagen y la capa persistente antes del corte.
El timer de retención de sesiones sin actividad en `~/.muse/data` a 30 días sigue
sin construir. No purgar sesiones activas ni cambiar cuentas para esta revisión.

Pruebas focales adicionales:
`python3 -m pytest ops/tests/test_container_boundary.py ops/tests/test_membership_consistency.py -q`.
Estas pruebas están en `ops/tests`; el runner general `ops/tests/run-all.mjs`
las descubre y las ejecuta dentro de `pnpm test:ops`.
