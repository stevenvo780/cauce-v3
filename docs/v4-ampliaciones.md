# Ampliaciones de agentes V4

Un contenedor de agente V4 nace con el perfil más seguro:
- raíz de solo lectura;
- `cap-drop ALL` más las seis capacidades mínimas;
- `no-new-privileges`;
- una sola red;
- cinco montajes;
- 128 procesos; 512 para el arnés `grok`, cuya TUI y sonda de autenticación necesitan más hilos.

Así sigue siendo por defecto. Una **ampliación** es un permiso con nombre que el dueño añade a un agente concreto cuando ese agente lo necesita para su trabajo. Cada ampliación se ve en su ficha con lo que permite y su riesgo. Se puede quitar y queda registrada en el historial de configuración.

## Dos llaves

Una ampliación solo se aplica si la permiten **las dos** partes:

1. **El agente la declara.** Va en su configuración deseada, el campo `extensions` del registro del agente, y se cambia con las mutaciones normales de configuración: CAS, vista previa y revisión.
2. **El ordenador la admite.** La política firmada del ordenador lleva `extensions_allowed`:
   - los tipos admitidos;
   - para `mount`, las raíces de host permitidas;
   - para `network`, los nombres de red permitidos.
   - para `docker`, `docker_access`: `['read']` o `['read', 'control']`; ambos niveles sin duplicados y siempre con lectura. Si el campo falta, Docker queda denegado aunque su tipo esté admitido.
   - `docker_daemon_dedicated`, booleano opcional: declara que el daemon es exclusivo de la empresa. Solo se marca cuando ese aislamiento existe realmente. Ausente o `false`, el executor comprueba las etiquetas de empresa de los contenedores y rechaza las ajenas; esa comprobación no acredita el origen de contenedores sin etiquetas.

   La edita el dueño de la empresa en Computadoras → *Permisos del ordenador* y viaja en el paquete de setup firmado. Un agente no puede pedir lo que su ordenador no admite. El executor rechaza la operación con el motivo.

El executor sigue validando el contenedor **exactamente**. El conjunto esperado de montajes, redes, capacidades y límites se calcula como lo base más las ampliaciones. Cualquier diferencia con lo observado es un fallo, igual que hoy.

Cambiar las ampliaciones de un agente obliga a recrear su contenedor. La consola lo avisa y hace el cambio como una operación de flota con vista previa: detener, recrear con los volúmenes conservados y arrancar. La misma recreación ocurre cuando cambia la imagen aprobada o el release del executor: el reemplazo se crea con los mismos montajes, la sesión del proveedor que vive en los volúmenes persistentes y las ampliaciones ya declaradas, y se valida de forma exacta antes de darlo por bueno. Si la validación falla, se restaura el contenedor anterior y los volúmenes no se tocan. Una sesión de login abierta o sin verificar bloquea la recreación hasta que se cierra y se confirma su parada.

La operación debe enviar directamente `fleet update` con `parameters.extensions`; guardar antes una mutación de configuración perdería la declaración anterior necesaria para decidir la recreación. La mutación `host_extensions_allowed` rechaza retirar tipos, raíces, redes o niveles Docker que un agente aún declara. Primero se quita la ampliación y se completa su recreación; después se reduce el permiso del ordenador y se descarga su paquete de setup firmado actualizado.

Los límites de recursos de un agente solo existen como ampliación `resources` (`memory`, `cpus`, `pids`). No hay un segundo camino de límites fuera de esa declaración: una herramienta que traslada un agente rechaza un campo de límites suelto en su plan y exige declararlos en `extensions` antes de crear el destino, para que la forma aprobada, la validación del contenedor y el traslado hablen de lo mismo. Un contenedor cuyos límites observados no coinciden con esa forma se detecta como deriva de límites (`CONTAINER_RESOURCE_LIMITS_DRIFT`, ver [Autenticación de proveedores](v4-autenticacion-runtime.md)). La única excepción es el límite de procesos base de 128 en un agente cuyo arnés tiene ahora un valor por defecto mayor y que no fija `pids`: ese contenedor sigue siendo válido para arrancar, parar y consultar, y la siguiente observación que lo prepara lo recrea in situ con el nuevo límite, igual que con una imagen o un release nuevos.

## Tipos

| Tipo | Campos | Efecto en el contenedor | Riesgo |
|---|---|---|---|
| `mount` | `source` (ruta absoluta del host, dentro de una raíz permitida), `target` (ruta absoluta), `mode` `ro`\|`rw` | `--volume source:target:mode,z` | medio (`ro`), alto (`rw`) |
| `network` | `name` (red Docker existente y permitida) | `docker network connect` tras crear | medio |
| `resources` | `memory` (p. ej. `2g`), `cpus`, `pids` (≤ 4096; por defecto 128, y 512 para un agente Grok) | `--memory`, `--cpus`, `--pids-limit` | bajo |
| `gpu` | — | `--gpus all` | medio |
| `ssh` | `hosts` (lista de `usuario@host[:puerto]`) | `prepare` genera una clave ed25519 **dentro del volumen de perfil** (la privada no sale nunca) y la consola muestra la pública para añadirla al `authorized_keys` del destino. Hace falta salida de red al destino | alto |
| `docker` | `access` `read`\|`control` | Sidecar `docker-socket-proxy` propio del agente, en una red privada agente↔proxy, con allowlist (`read`: CONTAINERS, INFO, PING, VERSION; `control`: además POST, EXEC, IMAGES, NETWORKS, VOLUMES). `DOCKER_HOST` apunta al proxy. `read` expone los metadatos y el entorno de todos los contenedores del ordenador. Para `control`, la opción preferida es un daemon propio del agente (Docker rootless o sysbox) en lugar del socket del host | alto (`read`: metadatos y entorno de todos los contenedores; `control`: equivale a root en el ordenador) |
| `browser` | `mode` `sidecar`\|`ssh_tunnel`, y para el túnel `host` y `port` | `sidecar`: contenedor Chromium headless propio del agente en su red privada, con `CAUCE_BROWSER_CDP_URL`. `ssh_tunnel`: usa la ampliación `ssh` para abrir CDP de un navegador remoto | medio |
| `mcp` | `name`, `command`, `args`, `env` (solo nombres de variables o referencias a secretos del perfil, nunca valores) | `prepare` escribe la entrada en la configuración MCP del harness, dentro del volumen de perfil | según el MCP |
| `tools` | `packages`: lista de `npm:<paquete>@<versión>` o `pip:<paquete>==<versión>` | `prepare` los instala sin root dentro del volumen de estado (`~/.local`), con versión fija | medio |
| `model_fallback` | `agent` (alias del otro agente del par, misma empresa y mismo ordenador), `model` (modelo Muse, sin prefijo) | Solo en un OpenClaw (cliente) y en el agente Muse que le responde (servidor); los dos se declaran mutuamente. El servidor crea el volumen del par y lo monta `rw` en `/cauce/model-fallback`; el cliente lo monta solo lectura y no se crea antes que él. `openclaw.json` lleva `agents.defaults.model = {primary, fallbacks: ["muse-cli/<model>"]}` y el backend `muse-cli` (sin sesión de CLI, prompt de sistema en fichero), que reenvía cada turno por el socket. El servidor atiende solo a su mismo uid de ejecución y ejecuta cada turno nuevo, sin log retenido ni `--session-id`, en un solo paso de modelo sin escritura, shell ni web: la herramienta de lectura de Muse llega fuera del workspace, así que un turno con cualquier actividad de herramienta falla sin reenviar nada. Los turnos propios del agente servidor tampoco tienen shell ni escritura (sin `--yolo`) y no admite TUI compartida. El servidor solo admite además `resources`; el cliente no admite `docker` ni `full_control`. El volumen se retira con la ampliación del servidor o con su purga, cuando ningún cliente lo monta: quitar primero la del cliente | medio |
| `full_control` | — | Raíz escribible, sin `cap-drop`, `--privileged` desactivado igualmente. Es la salida de emergencia para agentes de infraestructura; la consola la pinta en rojo y pide escribir el alias | máximo |

Fuera del catálogo no hay nada. Un tipo nuevo se añade aquí, en el esquema y en el executor, nunca como opción libre.

## Secretos

Ninguna ampliación guarda secretos en el registro ni en la política:
- Las claves SSH se generan en el volumen de perfil.
- Los MCP referencian variables del perfil.
- La consola solo muestra la parte pública y las huellas.

## Dónde vive cada pieza

- **Esquema y registro:** `packages/protocol` (esquema de `extensions`), `packages/store` (columna y mutación) y `services/gateway` (validación, vista previa y paso a la operación de flota).
- **Política del ordenador:** `extensions_allowed` en el paquete de setup y su edición desde Computadoras.
- **Executor:** `ops/cli/fleet_executor_container.py` (crear y validar con ampliaciones) y `ops/cli/fleet_executor_sidecars.py` (proxy Docker y navegador).
- **Prepare:** los drivers `ops/cli/fleet_provider_*.py`, para escribir los MCP, instalar las herramientas y generar la clave SSH.
- **Consola:** la pestaña «Ampliaciones» en la ficha del agente y «Permisos del ordenador» en Computadoras.
