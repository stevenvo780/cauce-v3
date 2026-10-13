# Dar de alta un servidor de la empresa

Guía para conectar una máquina Linux de tu empresa a Cauce como **computadora** y ejecutar agentes en ella, sin pasar por el administrador de la plataforma. Detalle técnico del enrolamiento y del paquete de preparación: [ordenadores](v4-ordenadores.md).

En esta guía, `<consola>` es la dirección de la consola (sin `https://`), `<empresa>` el identificador de tu empresa y `<nombre>` el nombre corto que eliges para la máquina (minúsculas, números o guion bajo, por ejemplo `maquina1`). El identificador completo de la computadora será `<empresa>-<nombre>`.

## Antes de empezar: qué tiene que estar listo en la plataforma

En la consola, abre **Ajustes → Computadoras → Conectar un ordenador** y mira el final del panel:

- Si aparece la línea «Un ordenador enrolado antes de que la plataforma firmara la preparación la ancla con `cauce hosts setup --signer-fingerprint …`», la plataforma firma la preparación: cada invitación mostrará dos comandos («Comando de enrolamiento» y «Comando de preparación») y puedes seguir esta guía entera.
- Si no aparece, la invitación solo mostrará el comando de enrolamiento con el aviso «Esta plataforma no firma la preparación del ejecutor»: puedes enrolar la máquina, pero no ejecutar agentes en ella. Pide a la plataforma que active la preparación (ver [Límites actuales](#límites-actuales)).

## 1. Requisitos de la máquina

| Requisito | Cómo comprobarlo |
|---|---|
| Linux con systemd (la prueba automática usa Debian 12; en Ubuntu 26.04 comprueba cada fila de esta tabla) | `systemctl --version` |
| Docker con daemon de root y CLI en `/usr/bin/docker` (paquete `docker.io` o `docker-ce`; **no** el snap) | `command -v docker` → `/usr/bin/docker`; `sudo docker info` |
| Python 3.12 o superior con PyYAML | `python3 --version`; `python3 -c 'import yaml'` |
| OpenSSL 3 | `openssl version` |
| Node.js 22 o superior | `node --version` |
| git, para traer la CLI | `git --version` |
| Reloj sincronizado: el gateway rechaza peticiones con más de 2 minutos de desfase | `timedatectl show -p NTPSynchronized --value` → `yes` |
| Salida HTTPS (443) directa hacia `<consola>` y hacia la URL de descarga del paquete, **sin proxy**: la CLI ignora las variables de proxy a propósito | `curl -sS -o /dev/null -w '%{http_code}\n' https://<consola>/` → `200` |
| Ruta de los contenedores de agentes hacia el gateway (ver [Límites actuales](#límites-actuales)) | la indica la plataforma |
| Disco: el paquete puede ocupar hasta 2 GB descomprimido, más la imagen de los agentes | `df -h /` |

No hace falta abrir puertos de entrada: la máquina siempre llama hacia fuera.

## 2. Preparar la máquina (una sola vez, como administrador de la máquina)

Cada empresa necesita **su propio usuario del sistema**: si dos empresas compartieran usuario, cada una podría leer la clave privada de la otra, y `cauce hosts setup` lo rechaza. Ese usuario entra en el grupo `docker`, que en la práctica da control de root sobre la máquina: usa máquinas o usuarios dedicados, nunca tu usuario personal.

```bash
sudo apt-get update
sudo apt-get install -y git openssl python3 python3-yaml systemd-container   # Node.js 22 y Docker, si faltan
sudo useradd --create-home --shell /bin/bash cauce-<empresa>
sudo usermod -aG docker cauce-<empresa>          # antes del linger: el gestor de usuario arranca con sus grupos
sudo loginctl enable-linger cauce-<empresa>       # el servicio sigue vivo sin sesión abierta
```

Si el linger ya estaba activo cuando añadiste el grupo, reinicia su gestor: `sudo systemctl restart user@$(id -u cauce-<empresa>).service`.

Entra como ese usuario **con una sesión real**, para que funcione `systemctl --user`:

```bash
sudo machinectl shell cauce-<empresa>@     # o por SSH directamente como cauce-<empresa>
```

`sudo -iu cauce-<empresa>` o `su - cauce-<empresa>` no abren sesión de systemd: `cauce hosts setup` fallaría al arrancar el servicio.

Instala la CLI de Cauce desde la versión publicada:

```bash
git clone --branch main <url-del-repositorio> ~/cauce
CAUCE_DESTINO_AVISO_INICIAL=<tu-destino-de-avisos> ~/cauce/ops/scripts/install-cauce-cli.sh
exec bash -l                 # para que ~/.local/bin entre en el PATH
docker ps                    # sin sudo: confirma el grupo docker
cauce hosts setup --help
```

El instalador exige un destino para los avisos de terminal aunque este servidor no los use: pon el mismo que usas en tu ordenador.

## 3. Alta desde la consola

1. En la consola, **Ajustes → Computadoras → Conectar un ordenador → Añadir ordenador**.
2. **Identificador del ordenador**: el prefijo `<empresa>-` ya está puesto; escribe solo `<nombre>`.
3. **Nombre del ordenador**: el que verás en la consola.
4. **Crear invitación**. La invitación se muestra **una sola vez** y **caduca a los 10 minutos**. Pulsa **Copiar invitación**.

En la máquina, como `cauce-<empresa>`:

```bash
cauce hosts enroll --gateway https://<consola> --invitation-stdin
# pega la invitación, Intro y Ctrl-D
```

Responde con `"state": "enrolled"` y `"executor_ready": false`. La invitación no va nunca en la línea de comandos ni en un fichero que se quede en la máquina.

Para comprobar solo la identidad, sin ejecutor:

```bash
cauce hosts heartbeat --identity-directory ~/.local/state/cauce-v3/hosts/<empresa>/<empresa>-<nombre>
```

Responde `"accepted": true` y, durante 90 segundos, la tarjeta de la computadora aparece **Conectada**.

Después, prepara el ejecutor:

```bash
cauce hosts setup --dry-run   # qué va a hacer, sin escribir nada
cauce hosts setup             # descarga el paquete firmado, escribe la política e instala el servicio
```

`setup` comprueba que el paquete lo firmó la plataforma que anclaste con la invitación, descarga y verifica cada fichero, valida la política con el ejecutor e instala y arranca el servicio de usuario `cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service`. Repetirlo no cambia nada si no hay novedades.

## 4. Comprobación

En la máquina:

```bash
cauce hosts status; echo "salida=$?"     # salida=0, "executor_ready": true y "provider_auth": true
systemctl --user status cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service
```

`"provider_auth": true` significa que la máquina puede iniciar la sesión del proveedor de cada agente desde la consola (paso 5 de [Asignar agentes](#5-asignar-agentes)). Si sale `false`, la plataforma no aprobó todavía la receta de login del proveedor: los agentes se crearán, pero se quedarán en «Esperando autenticación» (ver [Límites actuales](#límites-actuales)).

En la consola, con **Releer invitaciones**:

- la fila de la invitación dice **«Ejecutor listo»**;
- en **Computadoras**, la tarjeta de `<empresa>-<nombre>` aparece **Conectada** y **Habilitada**.

El ejecutor publica su estado cada 30 segundos; si deja de hacerlo, la fila pasa a «Identidad confirmada; el ejecutor no responde».

## 5. Asignar agentes

1. **Ajustes → Agentes → Añadir agente → «Solo preparar, sin desplegar»**.
2. Elige el espacio de trabajo, el alias, el nombre visible, la clave física de ejecución y sus grupos.
3. En **Host operativo**, elige `<empresa>-<nombre>`; en **Plantilla de ejecución**, la que ofrece esa computadora; en **Cuenta principal de ejecución**, la cuenta del proveedor que pagará al agente.
4. **Previsualizar operación** y, si el resumen es correcto, **Encolar operación**. La operación avanza paso a paso. La primera vez que un agente usa su cuenta en esta computadora se para en **«Esperando autenticación»**: su contenedor ya existe, pero el proveedor todavía no tiene sesión dentro.
5. **Autentica el proveedor del agente** desde la consola, en el mismo recibo de la operación o en la pestaña **Operación** de la ficha del agente:
   1. En **«Autenticar la cuenta principal»** comprueba el proveedor, la cuenta y la computadora, y pulsa **Conectar cuenta**.
   2. Se abre un terminal con el login del proveedor, que corre dentro del contenedor del agente en tu máquina. Sigue lo que pide: con Codex, abre en tu navegador la dirección que muestra y escribe el código; con Claude, abre la dirección y pega en el terminal el código que te devuelve. Entra con la cuenta que elegiste como «Cuenta principal de ejecución».
   3. Cuando el terminal confirme el inicio de sesión, pulsa **Verificar conexión**. Cauce comprueba que la identidad es la de esa cuenta y que el CLI del proveedor responde; aparece **«Cuenta e identidad verificadas»**.
   4. Pulsa **Reanudar operación** y espera a **«Completada»**.

   La sesión del proveedor se queda en el volumen de perfiles del agente, en tu máquina; ni el terminal ni el código pasan a la plataforma. Si la operación no se para en «Esperando autenticación», la cuenta ya tenía sesión en ese agente y puedes saltar este paso.
6. Escríbele en su sala: el agente tiene que contestar.

En la máquina, `docker ps --filter label=cauce.fleet.host=<empresa>-<nombre>` muestra su contenedor. Para pararlo, arrancarlo, cambiar su configuración o retirarlo, usa la pestaña **Operación** del agente; nunca `docker stop` ni `docker rm` a mano: el ejecutor lo detectaría como divergencia.

## 6. Si algo falla

Los mensajes de `cauce hosts setup` y `status` salen en inglés, con el prefijo `cauce:`. `enroll` y `heartbeat` dan siempre el mismo mensaje en español; la causa suele ser una de las primeras filas.

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| `enroll`: «no se pudo verificar el enrolamiento o canal; identidad local conservada» | la invitación caducó (10 min) o ya se usó, la dirección no es `https://<consola>` o no hay salida HTTPS | repite el mismo comando con la misma invitación: es seguro, y también registra en la máquina una identidad que la consola ya muestra como «Identidad confirmada». Si la invitación caducó sin confirmarse, cancélala, crea otra y, antes de usarla, borra la identidad pendiente: `rm -r ~/.local/state/cauce-v3/hosts/<empresa>/<empresa>-<nombre>` (solo si su `identity.json` dice `"state":"pending"`) |
| `this gateway does not serve setup packages (HTTP 404)` | la plataforma no tiene activada la preparación | ver [Antes de empezar](#antes-de-empezar-qué-tiene-que-estar-listo-en-la-plataforma) |
| `no setup signer is anchored for this computer` | enrolaste antes de que la plataforma firmara la preparación | `cauce hosts setup --signer-fingerprint <huella>`, con la huella que muestra la consola bajo la lista de invitaciones |
| `setup package signer differs from the anchored one` | la plataforma cambió su clave de firma | confirma la huella nueva con la plataforma y repite con `--signer-fingerprint <huella nueva>` |
| `host request rejected (HTTP 403)` | reloj desfasado más de 2 minutos, computadora deshabilitada o eliminada, o empresa retirada | sincroniza la hora (`timedatectl`); revisa la tarjeta en Computadoras |
| `host request rejected (HTTP 429)` | demasiados intentos seguidos | espera un minuto |
| `setup package is stale or belongs to another computer` | reloj desfasado más de una hora | sincroniza la hora |
| `artifact download unavailable; retry is safe` | la máquina no llega a la URL del paquete | revisa salida HTTPS, DNS y que no dependa de un proxy |
| `artifact digest differs from the signed package` | el paquete publicado no es el aprobado | avisa a la plataforma; no se instaló nada |
| `executor policy was written but the executor rejects it (executor_unconfigured)` | la plataforma no tiene lista la autoridad firmada o la plantilla | avisa a la plataforma; el servicio no se arrancó |
| `Node.js 22 or newer is required` | falta `node` en el PATH | instala Node.js 22 y repite |
| `could not start the user service; check XDG_RUNTIME_DIR` | entraste con `sudo -iu` o `su` | entra con `sudo machinectl shell cauce-<empresa>@` o por SSH |
| `this system user already runs the executor of company …` | ese usuario ya pertenece a otra empresa | crea otro usuario para esta empresa |
| `host identity directory must belong to the current user with mode 0700` | ejecutaste algún paso con `sudo` o como otro usuario | repite como `cauce-<empresa>`; corrige dueño y permisos de `~/.local/state/cauce-v3` |
| `host identity directory cannot contain symlinks` | el HOME está bajo un enlace simbólico | usa un HOME sin enlaces |
| aviso `enable linger so the service survives logout` | no se activó el linger | `sudo loginctl enable-linger cauce-<empresa>` |
| `cauce hosts status` sale con 3, `reason: service_inactive` | el servicio está parado | `journalctl --user -u cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service -n 50` |
| al crear un agente: `approved image digest is unavailable` | la imagen de los agentes no está cargada en esta máquina | la plataforma indica cómo cargarla (ver Límites) |
| al crear un agente: permiso denegado en Docker | el usuario no está en `docker`, o su gestor arrancó antes de añadirlo | `sudo usermod -aG docker cauce-<empresa>` y `sudo systemctl restart user@$(id -u cauce-<empresa>).service` |
| la operación queda en «Esperando autenticación» | el proveedor aún no tiene sesión en el contenedor del agente | autentícalo desde la consola (paso 5 de [Asignar agentes](#5-asignar-agentes)); si no vas a hacerlo, **Cancelar operación** |
| **Conectar cuenta** falla («La conexión no se pudo verificar») o no aparece el terminal | la máquina no sirve el login (`cauce hosts status` da `"provider_auth": false`) o su política de login no casa con la del ejecutor | repite `cauce hosts setup`; el diario lo explica: `journalctl --user -u cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service \| grep 'provider authentication'` |
| **Verificar conexión**: «La cuenta conectada no corresponde a la identidad autorizada» | iniciaste sesión con otra cuenta del proveedor | **Cancelar conexión**, **Conectar cuenta** otra vez y entra con la cuenta correcta |
| **Verificar conexión**: «La conexión caducó» | pasaron más de 10 minutos desde **Conectar cuenta** | vuelve a pulsar **Conectar cuenta** |

## 7. Dar de baja la computadora

1. **Agentes primero.** En la pestaña **Operación** de cada agente de esa computadora: **stop**, después **retire**, y luego **Eliminar definitivamente** (escribe el alias para confirmar). La consola no deja eliminar una computadora con agentes.
2. **Para el servicio** en la máquina, como `cauce-<empresa>`:
   ```bash
   systemctl --user disable --now cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service
   ```
3. **En la consola**, en la tarjeta de la computadora, apaga **Habilitada**: desde ese momento el gateway rechaza cualquier petición firmada por esa máquina. **Eliminar** la quita del registro y borra su identidad; solo puede usarlo el administrador de la plataforma, y no toca la máquina.
4. **Limpia la máquina**, como `cauce-<empresa>`:
   ```bash
   rm -f ~/.config/systemd/user/cauce-v3-host-executor-<empresa>-<empresa>-<nombre>.service
   systemctl --user daemon-reload
   rm -rf ~/.local/share/cauce-v3/hosts/<empresa>/<empresa>-<nombre> ~/.local/state/cauce-v3/hosts/<empresa>/<empresa>-<nombre>
   docker ps -a --filter label=cauce.fleet.host=<empresa>-<nombre>        # vacío
   docker volume ls --filter label=cauce.fleet.host=<empresa>-<nombre>    # vacío
   ```
   Si la máquina deja de usarse para Cauce, como administrador: `sudo loginctl disable-linger cauce-<empresa>`, `sudo userdel -r cauce-<empresa>` y `sudo docker image rm <imagen>` de la imagen de agentes.

## Límites actuales

Hasta que la plataforma resuelva estos puntos, una computadora nueva se puede **enrolar** y confirmar su identidad con un latido firmado (`cauce hosts heartbeat`), pero **no puede ejecutar agentes**:

- **Preparación activada en producción.** El gateway necesita su configuración y su clave de firma (`CAUCE_FLEET_HOST_SETUP_CONFIG_FILE`, [parámetros](parametros.md)). Sin ellas, la consola solo muestra el comando de enrolamiento.
- **Paquete publicado.** Falta construir y publicar en una URL HTTPS el paquete que descarga `setup`; hoy solo lo construye la prueba automática.
- **Imagen de los agentes.** El ejecutor usa una imagen fijada por su digest y no la descarga: hay que cargarla en cada máquina.
- **Receta de login del proveedor.** `setup` solo habilita el login desde la consola si cada plantilla de perfil de la configuración de preparación trae su receta `login` (ver [ordenadores](v4-ordenadores.md#login-del-proveedor-desde-la-consola)); sin ella, `cauce hosts status` da `"provider_auth": false` y el alta se queda esperando autenticación. La imagen de los agentes tiene que traer el CLI del proveedor fijado por su digest.
- **Ruta de los agentes hacia el gateway.** Los agentes se conectan con mTLS al gateway, que solo escucha en la red privada de la plataforma; la máquina tiene que estar en esa red o la plataforma tiene que publicar otra ruta.
