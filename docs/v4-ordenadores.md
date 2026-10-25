# Ordenadores: enrolar y preparar el executor

Un ordenador nuevo pasa por dos pasos, ambos sin el super-admin de plataforma. La consola («Conectar un ordenador») muestra la invitación y, si el gateway firma la preparación, los comandos de enrolar y de preparar; si no firma, solo el de enrolar. Por cada ordenador enrolado indica si su ejecutor está listo.

Procedimiento para el dueño, de los requisitos a la baja: [Dar de alta un servidor de la empresa](v4-alta-servidor.md).

Requisitos del ordenador: Cauce CLI, Python 3.12 o superior (filtro `data` de `tarfile`) con PyYAML (el executor valida los manifiestos de flota), OpenSSL, Node.js 22, systemd de usuario, Docker en `/usr/bin/docker` con el usuario en el grupo `docker` y la tailnet de la plataforma (los agentes hablan mTLS con el gateway por ella).

### Identificador

El `host_id` es global y usa el mismo patrón que el id de empresa: `^[a-z][a-z0-9_-]{0,63}$` (1–64 caracteres). Quien no es `platform_admin` solo invita dentro de la partición de su empresa activa. El nombre no lleva guion, así que dos particiones no se solapan (`packages/store/src/host-enrollment.ts`, `assertCompanyHostId`).

- La consola muestra el prefijo `<empresa>-` fijo y el campo solo acepta `[a-z0-9_]+`. El identificador enviado cumple `^<empresa>-[a-z0-9_]+$`. El título del campo es «Solo letras minúsculas, números o guiones bajos; el identificador completo será <empresa>-nombre.» El largo del campo es `64` menos el largo del prefijo.
- Un 403 al invitar se muestra en español: «Este ordenador debe llamarse <empresa>-nombre, con letras minúsculas, números o guiones bajos en el nombre, o tu rol no permite invitar.» La misma frase cubre el nombre mal formado y la falta de rol. La API responde en inglés (`host id must be <empresa>-<name>, with lowercase letters, digits or underscores in the name`) y la consola no enseña ese texto.
- El super-admin de plataforma no lleva prefijo y puede usar cualquier `host_id` válido.
- Un id de empresa de 63 o 64 caracteres no deja sitio para el prefijo más un nombre de al menos un carácter dentro del tope de 64. Esa empresa no puede invitar un ordenador.

## 1. Enrolar (identidad)

```bash
cauce hosts enroll --gateway https://<gateway> --invitation-stdin   # pegar la invitación JSON de la consola
```

Genera una identidad Ed25519 propia en `~/.local/state/cauce-v3/hosts/<empresa>/<host>/`. Da identidad y latido firmado. Si el gateway firma paquetes de preparación, la invitación trae `setup_signer_fingerprint` (SHA-256 de la clave pública SPKI DER del firmante) y `enroll` la ancla en `setup-signer.json` (0600) junto a la identidad, antes de pedir ningún paquete. Una huella malformada invalida la invitación.

## 2. Preparar el executor

```bash
cauce hosts setup --dry-run   # muestra qué haría, sin escribir nada
cauce hosts setup             # instala y arranca el servicio
cauce hosts status            # ¿está listo? (salida 0 = executor_ready, 3 = no listo)
```

`setup` usa la identidad enrolada (si hay más de una, `--identity-directory`). Pide al gateway, por el canal firmado del host, el **paquete de preparación** de la empresa y hace lo siguiente:

1. Verifica la firma Ed25519 del paquete y que su firmante coincide con el **anclado en la invitación**; nunca confía por primer uso. Una identidad enrolada sin ancla (antes de que el gateway firmara la preparación) se ancla con `--signer-fingerprint <huella>`, que la consola muestra bajo la lista de ordenadores; sin ancla ni huella explícita no instala nada. El paquete debe ser de este `company_id`/`host_id` y tener menos de una hora.
2. Descarga del propio gateway, por el canal firmado, el release (`kind: release`, tar con `ops/cli/fleet-executor.py` y `services/gateway/dist/fleet/main.js`) y los ficheros (`kind: file`, en `files/<nombre>`), comprobando tamaño y SHA-256 firmados. Si la conexión se corta, reanuda desde el último byte recibido con un desplazamiento firmado (hasta cinco intentos). El tar no puede traer rutas absolutas, `..` ni enlaces que salgan del release; sí los enlaces internos del `node_modules` del adapter. Se extrae en `~/.local/share/cauce-v3/hosts/<empresa>/<host>/release/<sha256>/`; los directorios toman el modo archivado, sea cual sea el umask, porque el digest de un bundle cubre los modos.
3. Si el paquete trae la **imagen de agentes** (`kind: image`, con su `image_id`), comprueba que cada plantilla de contenedor la usa y pregunta a Docker si ya la tiene con ese `Id`. Si no, la descarga igual que el release (un `docker save` comprimido, del orden de 700 MB), hace `docker load`, borra el fichero y exige que el `Id` cargado sea el de la plantilla. Si ya estaba, no descarga nada. La salida de `setup` lo dice con `image_id`, `image_present` y `image_loaded`.
4. Compone `executor-policy.json` (0600): identidad, usuario y raíces los fija el cliente (la política del paquete no puede sobrescribirlos ni añadir runtimes nativos); plantillas, hooks, transporte, autoridad y bundles vienen del paquete, con `@release@`, `@install@`, `@identity@` y `@user@` (usuario local del executor) sustituidos. El digest de cada bundle se recalcula sobre el release extraído.
5. Valida con `fleet-executor.py --capabilities`; si el executor rechaza la política, no arranca el servicio.
6. Si alguna plantilla de perfil firmada trae su receta `login`, escribe la política de login del proveedor (`provider-auth-policy.json`, ver [Login del proveedor desde la consola](#login-del-proveedor-desde-la-consola)); sin receta, borra una vieja.
7. Instala la unidad de usuario `~/.config/systemd/user/cauce-v3-host-executor-<empresa>-<host>.service` (plantilla incrustada en `host_setup.py`, que el instalador de la CLI ya copia), `enable --now`, y reinicia solo si cambió algo. Repetirlo es idempotente.

El servicio publica capacidades al gateway cada 30 s; la consola muestra `executor_ready` cuando la política tiene plantillas.

### Una empresa por usuario del sistema

Cada host tiene su propia unidad (nombre con empresa y host), así que un usuario puede ejecutar varios ordenadores de la misma empresa. `setup` rechaza (también con `--dry-run`) preparar una segunda **empresa** en el mismo usuario: compartirían UID y cada una podría leer la clave `private.pem` de la otra. Hace falta un usuario del sistema por empresa.

### Linger

Para que el servicio sobreviva al cierre de sesión de su usuario de ejecución, `setup` intenta `loginctl enable-linger`. Si no tiene permiso, avisa: `sudo loginctl enable-linger <usuario>`.

## Contrato del gateway

`POST /v3/fleet/hosts/:host_id/setup` con el paquete firmado del host (`{company_id, host_id, issued_at, nonce, payload: {"action":"package"}, proof}`, la misma identidad Ed25519 del latido de la migración 059) responde:

```json
{"package": {"version":1,"company_id":"…","host_id":"…","issued_at":1760000000000,"release_revision":"<sha de 40 hex>",
  "artifacts":[{"name":"release","kind":"release","sha256":"<64 hex>","size":123},
               {"name":"agent-image","kind":"image","sha256":"<64 hex>","size":700000000,"image_id":"sha256:<64 hex>"},
               {"name":"fleet-ca","kind":"file","sha256":"<64 hex>","size":1200}],
  "policy":{"container_templates":[],"profile_templates":[],"bundles":{},"hooks":{},"transport":{},"authority":{}}},
 "signature":"<base64 Ed25519 sobre JSON canónico de package>", "signer_public_key":"<base64 SPKI DER>"}
```

Cada artefacto se descarga con `POST /v3/fleet/hosts/:host_id/setup/artifact` y el mismo paquete firmado del host, con `payload: {"action":"artifact","name":"…","sha256":"<64 hex>","offset":0}`:

- Responde `200` con los bytes (`application/octet-stream`, `Content-Length`) o, con `offset` mayor que cero, `206` con `Content-Range: bytes <offset>-<último>/<tamaño>`. El desplazamiento va firmado en el paquete en vez de en una cabecera `Range`, porque el canal del host solo firma cuerpos `POST`. El gateway lo sirve por streaming desde su disco, sin redirecciones ni URLs de terceros, y nginx lo pasa sin búfer.
- Un nombre que el paquete no tiene da 404, un `sha256` distinto 409 (hubo un despliegue nuevo entre el paquete y la descarga) y un desplazamiento fuera del fichero 422. En los tres casos el nonce no se consume. Cada descarga admitida deja `fleet_host.setup.artifact` en `audit_events` con nombre, digest y desplazamiento.
- Cuenta en el límite por red de las peticiones del host (120 por minuto) y en uno propio de 30 descargas por minuto y ordenador. Otra empresa o una cookie de navegador reciben 403.

- **Autenticación y alcance.** El gateway verifica la prueba del host contra la identidad enrolada de *esa* empresa (`HostEnrollmentRepository.request`): host y empresa del paquete deben coincidir con la ruta y con la identidad, el nonce se consume una vez y una cookie de navegador da 403. El paquete lleva el `company_id`/`host_id` verificados, así que un ordenador de A no obtiene la política de B ni puede hacerse pasar por otro host (403); repetir un paquete da 409. Cada entrega deja `fleet_host.setup.package` en `audit_events` con la empresa.
- **Sin configuración** responde 404 `not_found`, solo después de verificar al host (un desconocido recibe 403 y no aprende si el gateway prepara ordenadores); el nonce no se consume. La CLI muestra el mensaje en inglés: `this gateway does not serve setup packages (HTTP 404); the platform administrator must configure host setup. Nothing was installed`.
- **Invitación.** `POST` y `GET /v3/console/fleet/hosts/enrollments` añaden `setup_signer_fingerprint` cuando el gateway firma la preparación.

### De dónde sale la política por defecto

Es la **plantilla aprobada por la plataforma** acotada a lo que la plataforma mantiene habilitado, no configuración de cada empresa: igual que el controlador V3.5 fija su política por `policy_sha256` en un fichero privado aprobado, el gateway lee `CAUCE_FLEET_HOST_SETUP_CONFIG_FILE` (JSON privado, 0600, del uid del gateway, como `api.v1.json`). Lo que depende de cada build (digest del adapter, hash del hook, `Id` de la imagen y de los CLI del proveedor) no se escribe a mano: la plantilla lo nombra con `@pin:<nombre>@` y el gateway lo toma del paquete de ordenadores del candidato desplegado.

```json
{"version":1,"signing_key_file":"/run/cauce-fleet/config/host-setup-signer.pem",
 "release_directory":"/run/cauce-host-release",
 "files":[{"name":"fleet-ca","path":"/run/cauce-fleet/config/fleet-ca.pem"}],
 "policy":{"bundles":{"codex":{"directory":"@release@/adapter","digest":"@pin:adapter_digest@","executable":"/usr/local/bin/node",
     "executable_sha256":null,"argv":["@release@/adapter/packages/adapter-sdk/dist/src/bin/codex.js"]}},
   "container_templates":[{"harness_id":"codex","prefix":"cauce-","image":"@pin:image@","runtime_user":"node","systemd_user":"@user@",
     "home_directory":"/home/node","state_root":"/home/node/.cauce","profile_root":"/home/node/.cauce-profiles","python":"/usr/bin/python3"}],
   "profile_templates":[{"provider":"codex","runtime_user":"node","path_root":"/home/node/.cauce-profiles","runtime_mode":"container",
     "command":"@pin:codex_command@","command_sha256":"@pin:codex_command_sha256@","container_prefix":"cauce-"}],
   "hooks":{"authenticate":{"executable":"@release@/ops/cli/fleet-provider-hook.py","sha256":"@pin:hook_sha256@","argv":[],"user":"@user@"},
     "profile":{…},"verify":{…},"revoke":{…}},
   "transport":{"bootstrap_url":"https://<IP de la tailnet del VPS>:8443","gateway_url":"https://<IP de la tailnet del VPS>:8443",
     "ca_certificate":"@install@/files/fleet-ca","network":"…"},
   "authority":{"identity_directory":"@identity@","host_id":"@host@","ca_certificate":"@install@/files/fleet-ca"}}}
```

- En producción las rutas son las de dentro del contenedor: el overlay de flota monta `/etc/cauce-v3/fleet-v35/gateway` (uid 1000, `0700`) en `/run/cauce-fleet/config` y pasa `CAUCE_FLEET_HOST_SETUP_CONFIG_FILE` desde `prod.env` (`CAUCE_FLEET_HOST_SETUP_CONFIG_FILE=/run/cauce-fleet/config/host-setup.v1.json`). Vacía o ausente, el gateway no prepara ordenadores. El gateway lee la configuración, el manifiesto del release, los ficheros y la clave al arrancar: un fichero ausente, con otro dueño o modo, escribible por grupo u otros o de otro tamaño que el declarado impide el arranque, y un cambio exige recrear el gateway (`deploy.sh` lo recrea con cada candidato).
- `files` son ficheros pequeños (hasta 1 MiB) que el gateway lee al arrancar y sirve con su SHA-256; aquí, la CA de flota.
- Un `@pin:<nombre>@` que `host-release.json` no trae impide el arranque. Si el release trae imagen, toda plantilla de contenedor tiene que usar ese `Id` (`@pin:image@`).
- Por cada host, el gateway quita los bundles cuyo harness no está habilitado en `harness_definitions` (tabla de plataforma) y las `container_templates` que dependían de ellos, y sustituye `@host@` y `@company@`.
- El esquema rechaza claves que el ordenador fija por sí mismo (`executor_user`, `roots`, `native`, `signer`…), bundles fuera de `@release@/`, una autoridad que no sea `@identity@`/`@host@` y rutas relativas o con `..`. Los bundles exigen los mismos campos que el executor (`directory`, `digest` `sha256:`, `executable`, `executable_sha256`, `argv`).

### Paquete de ordenadores: construcción y publicación

`ops/scripts/build-host-release.sh <directorio nuevo y absoluto> [aprobaciones.json]` arma el paquete desde un clon limpio, en el commit exacto que se despliega (exige git, node, pnpm con `pnpm install --frozen-lockfile` hecho, python3 y Docker):

| Fichero | Contenido |
|---|---|
| `release.tar` | `ops/cli`, `ops/scripts`, `ops/container-runtime` y `ops/schemas` del commit (`git archive`), el proceso del host `services/gateway/dist/fleet/main.js` empaquetado por esbuild y `adapter/`, el bundle real de `ops/scripts/build-adapter-release.sh` (con las aprobaciones de descriptores si se pasan). Nada de fixtures. |
| `agent-image.tar.gz` | `docker save` comprimido con `gzip -n` de la imagen de `ops/agent-runtime/Dockerfile`: `node:22-slim` fijado por digest, Python 3, git, ripgrep y los CLI reales de Claude Code, Codex y Grok en las versiones de `ops/cuotas/Dockerfile`, usuario `node`. Su etiqueta es `cauce-agent-runtime:<sha256 del Dockerfile>`, así que un candidato que no la cambia suele dejar el mismo `Id` y los ordenadores no la vuelven a descargar. |
| `host-release.json` | versión, commit, tamaño y SHA-256 de los dos ficheros, `Id` de la imagen y los pins: `adapter_digest`, `hook_sha256`, `image` y, por cada CLI, `<proveedor>_command` (ruta real dentro de la imagen) y `<proveedor>_command_sha256`. |

`ops/scripts/host-release.py pack` es quien escribe el tar y el manifiesto: dueño 0, fecha del commit y modos fijos (`0755`/`0644`), así que el mismo árbol da los mismos bytes; los enlaces duros se guardan como ficheros. Mide `adapter_digest` sobre el árbol tal como lo extrae el ordenador. Comprueba dentro de la imagen que cada CLI es un fichero de root con un solo enlace y sin escritura de grupo u otros, lo que exige el adaptador al fijar un comando. La imagen no es reproducible byte a byte (npm y apt dejan fechas); queda fijada por su SHA-256 y su `Id`.

Publicación, con el overlay de flota:

1. En `prod.env`, declarar `CAUCE_FLEET_HOST_RELEASE_DIR=` (vacía la primera vez) junto a `CAUCE_FLEET_HOST_SETUP_CONFIG_FILE`.
2. `deploy.sh` toma `/var/lib/cauce-v3/host-releases/<commit>` (raíz cambiable con `CAUCE_DEPLOY_HOST_RELEASE_ROOT`). Si no existe, lo construye con `build-host-release.sh`; si el VPS no tiene pnpm, se construye en otra máquina con el mismo commit y se copia ahí (root, directorio `0755`, ficheros `0644`). Después lo verifica con `host-release.py deploy`: commit, tamaños, SHA-256 y modos. Un paquete de otro commit o alterado para el despliegue antes de migrar.
3. Escribe el directorio en el `prod.env` candidato, como los pins de imagen. El overlay lo monta de solo lectura en `/run/cauce-host-release`, que es el `release_directory` de la configuración. Volver al `prod.env` anterior vuelve al paquete anterior, que no se borra.

Ocupa en el VPS unos 700 MB por candidato con una imagen nueva; los directorios viejos se borran a mano cuando ya no hay vuelta atrás posible.

Docker guarda las imágenes en el almacén de containerd (por defecto en Docker 29 en adelante, el de Ubuntu 26.04) o en el clásico, y el `Id` de una misma imagen cambia de uno a otro. El ordenador tiene que usar el mismo almacén que la máquina que construyó el paquete; si no, `setup` lo dice al comparar el `Id` y no arranca el servicio.

### Login del proveedor desde la consola

Un alta con un proveedor real se para en `authenticate` (`awaiting_auth`) hasta que alguien inicia la sesión del proveedor dentro del contenedor del agente. En un ordenador enrolado lo hace el proceso del host (`AgentProviderAuthHost`), que atiende los comandos del canal firmado `agent-auth`: el terminal de la consola (`/v3/console/provider-auth/…`) habla con el gateway, el gateway encola `stop`, `open`, `start`, `input`, `verify` y `cleanup`, y el host los ejecuta con `provider-login.py`, que entra en el contenedor exacto (`docker exec --user 0 … --container-child`) y lanza el login como el usuario de ejecución con un PTY.

El host solo monta ese servicio si la unidad fija `CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`. `setup` lo hace cuando alguna plantilla de perfil firmada trae su receta `login`:

```json
"profile_templates":[{"provider":"codex","runtime_user":"node","path_root":"/home/node/.cauce-profiles","command":"@pin:codex_command@",
  "command_sha256":"@pin:codex_command_sha256@","runtime_mode":"container","container_prefix":"cauce-",
  "login":{"method":"device","command":["@pin:codex_command@","login","--device-auth"],"sha256":"@pin:codex_command_sha256@"}}]
```

- La receta es fija por proveedor y la validan el executor y el host: Codex `login --device-auth` (`device`) o `login` (`terminal`); Claude `auth login` (`terminal`); `command[0]` y `sha256` son los de la plantilla. El ejecutable tiene que ser un binario del root en la imagen de los agentes: el helper comprueba, como root dentro del contenedor, el digest del fichero y que el proceso lanzado sea exactamente ese `argv` (un script con `#!` no lo cumple). Con Codex instalado por npm, `command` es el binario nativo `…/lib/node_modules/@openai/codex/…/vendor/x86_64-unknown-linux-musl/bin/codex` que ya usa el login de Mis cuotas (`ops/cli/quota_runtime.py`), no el atajo `/usr/local/bin/codex`, que es un enlace a un script de Node. Los pins `codex_command` y `codex_command_sha256` los mide `host-release.py pack --provider codex=<ruta>` dentro de la imagen de los agentes, así que esa ruta tiene que ser la del binario nativo.
- Con esa receta, `setup` escribe `<raíz de instalación>/provider-auth-policy.json` (`0600`) con `host_id`, las mismas `profiles` y `profile_templates` que la política del executor (el host exige que coincidan), el helper `@release@/ops/cli/provider-login.py` y sus módulos fijados por sha256 desde el release verificado, y `state_root` `<raíz>/provider-login` (`0700`). No lleva ningún secreto. La unidad añade `Environment=CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE=…`, y `setup`/`status` informan `"provider_auth": true`. Sin receta no se escribe nada y una política vieja se borra.
- Al arrancar, el host comprueba la política y, si no casa (perfiles distintos, pines del helper cambiados…), lo dice en el diario: `Host provider authentication policy is unusable: auth policy rejects <campos>`.
- El login para el runtime del agente (`login-stop`) para que el CLI no se use a la vez; tras verificar la identidad y reanudar, el paso `profile` lo vuelve a arrancar antes de sus sondas.
- La sesión del proveedor queda en el volumen `<contenedor>-provider-profiles`; la consola no guarda el contenido del terminal.
- La parada del login al cerrar o al caducar una sesión ya no se espera dentro de la transacción que libera la reserva: la reserva pasa a `releasing`, la parada remota se ejecuta fuera de la transacción y otra transacción corta confirma `released` o devuelve la reserva a `reserved` si la parada no se acreditó (`STOP_UNCONFIRMED`). Mientras la liberación está en curso, otro login sobre el mismo ordenador, usuario y perfil recibe `SESSION_CONFLICT`. El detalle y los códigos están en [Autenticación de proveedores](v4-autenticacion-runtime.md).
- Si el contenedor quedó con una imagen anterior tras un despliegue, la operación puede registrar `RUNTIME_DRIFT` y permanece en `awaiting_auth`. El proceso del host reconcilia esas operaciones cada 30 segundos y confirma la deriva sin esperar a un nuevo intento. Pulsa **Iniciar sesión**: el login prepara o recrea el contenedor antes de abrir el terminal, conservando volúmenes, sesión y ampliaciones. La recreación solo se hace si no hay un login abierto sobre ese contenedor. Tras verificar la cuenta, la ficha reanuda la operación; si el panel de la operación pide **Reanudar**, púlsalo. Diagnóstico completo: [diagnóstico de login](v4-autenticacion-runtime.md#diagnóstico-de-login-de-agente-para-operadores).
- Todo el Python que entra en el contenedor con `docker exec` va aislado (`-I -B`, trabajo en `/`, módulos solo desde el executor y su ciclo de vida); el helper de login solo importa la biblioteca estándar y los módulos fijados del executor. Un agente OpenClaw usa además un `TMPDIR` privado dentro de su perfil, con su caché de compilación, tanto en runtime como durante el login.

### Clave de firma

La única clave de la autoridad de flota es la CA RSA X.509 que emite los certificados mTLS de los agentes; vive en el enclave root de la autoridad central y el gateway (uid 1000) no la lee por diseño ([despliegue del controlador](v3.5-controlador-despliegue.md)). Firmar JSON con ella mezclaría usos y obligaría a exponerla al gateway, y el contrato del ordenador ya exige Ed25519. Por eso la preparación usa **una clave Ed25519 propia del gateway** (`signing_key_file`, PEM PKCS#8 0600 del uid del gateway), cuya huella ancla cada invitación. Rotarla obliga a re-anclar cada ordenador con `cauce hosts setup --signer-fingerprint <huella nueva>`.

## Prueba de punta a punta

```bash
CAUCE_HOST_SETUP_E2E=1 npx vitest run services/gateway/src/fleet/host-setup.e2e-docker.test.ts
```

Arranca PostgreSQL de prueba, el gateway en loopback con la autoridad firmada real (issuer y CA de prueba) y un contenedor limpio (systemd como PID 1, usuario `cauce` con linger, Python 3.12 con PyYAML, OpenSSL, Node 22 y el socket Docker del anfitrión, red del host). El release se arma con los ficheros versionados del árbol de trabajo (`ops/cli`, `ops/scripts`, `ops/container-runtime`, `ops/schemas` y los descriptores), el proceso del host empaquetado por esbuild y un adapter de prueba (runtime de bootstrap del SDK y un CLI de proveedor de fixture fijado por hash). Lo empaqueta `host-release.py pack`, el mismo código que en producción, junto con una imagen de agentes pequeña (la del ordenador más una capa propia); la imagen se borra de Docker antes de arrancar el ordenador. El gateway lee el directorio con `resolveHostSetup` y sirve los tres artefactos; el arnés vive en `services/gateway/src/fleet/host-computer.fixtures.ts`.

Un usuario recién registrado crea su empresa e invita el ordenador. En el contenedor, `cauce hosts enroll` y `cauce hosts setup` descargan release, CA e imagen del gateway, cargan la imagen (`image_loaded: true`, mismo `Id`) e instalan el servicio de usuario; un segundo `setup` no descarga ni carga nada. El gateway ve `executor_ready=true`, `cauce hosts status` sale 0 y la capacidad de la empresa incluye el ordenador, sin ningún `platform_admins`. Otra empresa no ve el ordenador y una petición firmada por éste hacia el host de la otra empresa recibe 403.

Después, la persona crea un agente desechable `zz-canary-*` y la operación termina `succeeded`: su contenedor corre con la imagen que cargó `setup`, aparece en `docker ps` y las sondas de bootstrap y normal devuelven el nonce correlacionado. El usuario de ejecución de la plantilla comparte uid con el executor, porque el pin del CLI del proveedor solo confía en ancestros de root o del propio usuario y el release está bajo la raíz de instalación del executor. El ciclo completo desde la consola (update, contexto, stop, retiro y purga) está en `tests/e2e/v4-fleet-cycle-real-browser.test.ts`.

El login del proveedor tiene su propia prueba con el mismo arnés (`providerLogin: true`), que recorre el alta entera de un ordenador sin nada precargado:

```bash
CAUCE_HOST_SETUP_E2E=1 npx vitest run services/gateway/src/fleet/host-setup-provider-auth.e2e-docker.test.ts
```

La imagen de los agentes trae un CLI de Codex de fixture (binario estático del root) que arranca sin sesión y pide un código de dispositivo. `host-release.py pack` lo mide dentro de la imagen con `--provider codex=<ruta>`, como hace `build-host-release.sh` con los CLI reales, y la plantilla de perfil fija el comando y la receta `login` con `@pin:codex_command@` y `@pin:codex_command_sha256@`. Tras `enroll` y `setup`, que descargan el release y la imagen del gateway y cargan la imagen (`image_loaded: true`), el ordenador informa `provider_auth: true`, con la política `0600` y la unidad con `CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`. El alta se para en `awaiting_auth`; la prueba recorre las mismas rutas que la consola (ámbito, sesión, ticket y WebSocket del terminal), escribe el código, verifica la identidad, reanuda y la operación termina `succeeded` con las sondas de bootstrap y normal respondidas por el agente. El código del terminal no aparece en los eventos de la operación.

Falta lo que ya pedía este documento:

- la configuración y la clave de preparación en producción, y la primera publicación del paquete de ordenadores con `deploy.sh`;
- la receta `login` de cada plantilla de perfil en la configuración de preparación de producción. Para Codex tiene que fijar el binario nativo de la imagen, y `build-host-release.sh` mide hoy `codex`, que resuelve al script de Node `codex.js`: sirve al adapter, pero no al login (ver [Login del proveedor desde la consola](#login-del-proveedor-desde-la-consola));
- el adapter real dentro de la imagen de agentes en una prueba de punta a punta: la prueba usa un runtime de bootstrap y un CLI de fixture, no `dist/src/bin/<harness>.js` con un proveedor real;
- el transporte mTLS del agente hacia el gateway: en producción solo escucha en `CAUCE_PRIVATE_BIND_IP`, así que el ordenador entra en la tailnet ([alta](v4-alta-servidor.md)) y `transport` apunta a la IP de la tailnet del VPS.
