# Ampliaciones de agentes V4

Un contenedor de agente V4 nace con el perfil más seguro:
- raíz de solo lectura;
- `cap-drop ALL` más las seis capacidades mínimas;
- `no-new-privileges`;
- una sola red;
- cinco montajes;
- 128 procesos.

Así sigue siendo por defecto. Una **ampliación** es un permiso con nombre que el dueño añade a un agente concreto cuando ese agente lo necesita para su trabajo. Cada ampliación se ve en su ficha con lo que permite y su riesgo. Se puede quitar y queda registrada en el historial de configuración.

## Dos llaves

Una ampliación solo se aplica si la permiten **las dos** partes:

1. **El agente la declara.** Va en su configuración deseada, el campo `extensions` del registro del agente, y se cambia con las mutaciones normales de configuración: CAS, vista previa y revisión.
2. **El ordenador la admite.** La política firmada del ordenador lleva `extensions_allowed`:
   - los tipos admitidos;
   - para `mount`, las raíces de host permitidas;
   - para `network`, los nombres de red permitidos.

   La edita el dueño de la empresa en Computadoras → *Permisos del ordenador* y viaja en el paquete de setup firmado. Un agente no puede pedir lo que su ordenador no admite. El executor rechaza la operación con el motivo.

El executor sigue validando el contenedor **exactamente**. El conjunto esperado de montajes, redes, capacidades y límites se calcula como lo base más las ampliaciones. Cualquier diferencia con lo observado es un fallo, igual que hoy.

Cambiar las ampliaciones de un agente obliga a recrear su contenedor. La consola lo avisa y hace el cambio como una operación de flota con vista previa: detener, recrear con los volúmenes conservados y arrancar.

## Tipos

| Tipo | Campos | Efecto en el contenedor | Riesgo |
|---|---|---|---|
| `mount` | `source` (ruta absoluta del host, dentro de una raíz permitida), `target` (ruta absoluta), `mode` `ro`\|`rw` | `--volume source:target:mode,z` | medio (`ro`), alto (`rw`) |
| `network` | `name` (red Docker existente y permitida) | `docker network connect` tras crear | medio |
| `resources` | `memory` (p. ej. `2g`), `cpus`, `pids` (≤ 4096) | `--memory`, `--cpus`, `--pids-limit` | bajo |
| `gpu` | — | `--gpus all` | medio |
| `ssh` | `hosts` (lista de `usuario@host[:puerto]`) | `prepare` genera una clave ed25519 **dentro del volumen de perfil** (la privada no sale nunca) y la consola muestra la pública para añadirla al `authorized_keys` del destino. Hace falta salida de red al destino | alto |
| `docker` | `access` `read`\|`control` | Sidecar `docker-socket-proxy` propio del agente, en una red privada agente↔proxy, con allowlist (`read`: CONTAINERS, INFO, PING, VERSION; `control`: además POST, EXEC, IMAGES, NETWORKS, VOLUMES). `DOCKER_HOST` apunta al proxy | alto (`control`: equivale a root en el host) |
| `browser` | `mode` `sidecar`\|`ssh_tunnel`, y para el túnel `host` y `port` | `sidecar`: contenedor Chromium headless propio del agente en su red privada, con `CAUCE_BROWSER_CDP_URL`. `ssh_tunnel`: usa la ampliación `ssh` para abrir CDP de un navegador remoto | medio |
| `mcp` | `name`, `command`, `args`, `env` (solo nombres de variables o referencias a secretos del perfil, nunca valores) | `prepare` escribe la entrada en la configuración MCP del harness, dentro del volumen de perfil | según el MCP |
| `tools` | `packages`: lista de `npm:<paquete>@<versión>` o `pip:<paquete>==<versión>` | `prepare` los instala sin root dentro del volumen de estado (`~/.local`), con versión fija | medio |
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
