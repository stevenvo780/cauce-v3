# Ordenadores: enrolar y preparar el executor

Un ordenador nuevo pasa por dos pasos, ambos sin el super-admin de plataforma. La consola («Conectar un ordenador») muestra la invitación y, si el gateway firma la preparación, los comandos de enrolar y de preparar; si no firma, solo el de enrolar. Por cada ordenador enrolado indica si su ejecutor está listo.

Requisitos del ordenador: Cauce CLI, Python 3.12 o superior (filtro `data` de `tarfile`) con PyYAML (el executor valida los manifiestos de flota), OpenSSL, Node.js 22, systemd de usuario y, para crear agentes, Docker.

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
2. Descarga el release (`kind: release`, tar con `ops/cli/fleet-executor.py` y `services/gateway/dist/fleet/main.js`) y los ficheros (`kind: file`, en `files/<nombre>`) comprobando tamaño y SHA-256 firmados; rechaza rutas absolutas, `..` y enlaces. Se extrae en `~/.local/share/cauce-v3/hosts/<empresa>/<host>/release/<sha256>/`; los directorios toman el modo archivado, sea cual sea el umask, porque el digest de un bundle cubre los modos.
3. Compone `executor-policy.json` (0600): identidad, usuario y raíces los fija el cliente (la política del paquete no puede sobrescribirlos ni añadir runtimes nativos); plantillas, hooks, transporte, autoridad y bundles vienen del paquete, con `@release@`, `@install@`, `@identity@` y `@user@` (usuario local del executor) sustituidos. El digest de cada bundle se recalcula sobre el release extraído.
4. Valida con `fleet-executor.py --capabilities`; si el executor rechaza la política, no arranca el servicio.
5. Instala la unidad de usuario `~/.config/systemd/user/cauce-v3-host-executor-<empresa>-<host>.service` (plantilla incrustada en `host_setup.py`, que el instalador de la CLI ya copia), `enable --now`, y reinicia solo si cambió algo. Repetirlo es idempotente.

El servicio publica capacidades al gateway cada 30 s; la consola muestra `executor_ready` cuando la política tiene plantillas.

### Una empresa por usuario del sistema

Cada host tiene su propia unidad (nombre con empresa y host), así que un usuario puede ejecutar varios ordenadores de la misma empresa. `setup` rechaza (también con `--dry-run`) preparar una segunda **empresa** en el mismo usuario: compartirían UID y cada una podría leer la clave `private.pem` de la otra. Hace falta un usuario del sistema por empresa.

### Linger

Para que el servicio sobreviva al cierre de sesión (como el usuario `server` de Salva en server2), `setup` intenta `loginctl enable-linger`. Si no tiene permiso, avisa: `sudo loginctl enable-linger <usuario>`.

## Contrato del gateway

`POST /v3/fleet/hosts/:host_id/setup` con el paquete firmado del host (`{company_id, host_id, issued_at, nonce, payload: {"action":"package"}, proof}`, la misma identidad Ed25519 del latido de la migración 059) responde:

```json
{"package": {"version":1,"company_id":"…","host_id":"…","issued_at":1760000000000,"release_revision":"<sha de 40 hex>",
  "artifacts":[{"name":"release","kind":"release","url":"https://…","sha256":"<64 hex>","size":123},
               {"name":"fleet-ca","kind":"file","url":"https://…","sha256":"<64 hex>","size":1200}],
  "policy":{"container_templates":[],"profile_templates":[],"bundles":{},"hooks":{},"transport":{},"authority":{}}},
 "signature":"<base64 Ed25519 sobre JSON canónico de package>", "signer_public_key":"<base64 SPKI DER>"}
```

- **Autenticación y alcance.** El gateway verifica la prueba del host contra la identidad enrolada de *esa* empresa (`HostEnrollmentRepository.request`): host y empresa del paquete deben coincidir con la ruta y con la identidad, el nonce se consume una vez y una cookie de navegador da 403. El paquete lleva el `company_id`/`host_id` verificados, así que un ordenador de A no obtiene la política de B ni puede hacerse pasar por otro host (403); repetir un paquete da 409. Cada entrega deja `fleet_host.setup.package` en `audit_events` con la empresa.
- **Sin configuración** responde 404 `not_found`, solo después de verificar al host (un desconocido recibe 403 y no aprende si el gateway prepara ordenadores); el nonce no se consume. La CLI muestra el mensaje en inglés: `this gateway does not serve setup packages (HTTP 404); the platform administrator must configure host setup. Nothing was installed`.
- **Invitación.** `POST` y `GET /v3/console/fleet/hosts/enrollments` añaden `setup_signer_fingerprint` cuando el gateway firma la preparación.

### De dónde sale la política por defecto

Es la **plantilla aprobada por la plataforma** acotada a lo que la plataforma mantiene habilitado, no configuración de cada empresa: igual que el controlador V3.5 fija su política por `policy_sha256` en un fichero privado aprobado, el gateway lee `CAUCE_FLEET_HOST_SETUP_CONFIG_FILE` (JSON privado, 0600, del uid del gateway, como `api.v1.json`) con el release aprobado y la plantilla de política:

```json
{"version":1,"signing_key_file":"/etc/cauce-v3/fleet-v35/gateway/host-setup-signer.pem",
 "release":{"name":"release","revision":"<sha de 40 hex>","url":"https://…/release.tar","sha256":"<64 hex>","size":123},
 "files":[{"name":"fleet-ca","url":"https://…/fleet-ca.pem","sha256":"<64 hex>","size":1200}],
 "policy":{"bundles":{"codex":{"directory":"@release@/adapter","digest":"sha256:<64 hex>","executable":"/usr/local/bin/python3.12","executable_sha256":null,"argv":[]}},
   "container_templates":[{"harness_id":"codex","prefix":"cauce-","image":"sha256:<64 hex>","runtime_user":"node","systemd_user":"@user@",
     "home_directory":"/home/node","state_root":"/home/node/.cauce","profile_root":"/home/node/.cauce-profiles","python":"/usr/bin/python3"}],
   "profile_templates":[…],"hooks":{"authenticate":{…,"user":"@user@"},"profile":{…},"verify":{…},"revoke":{…}},
   "transport":{"bootstrap_url":"https://…","gateway_url":"https://…","ca_certificate":"@install@/files/fleet-ca","network":"…"},
   "authority":{"identity_directory":"@identity@","host_id":"@host@","ca_certificate":"@install@/files/fleet-ca"}}}
```

- Por cada host, el gateway quita los bundles cuyo harness no está habilitado en `harness_definitions` (tabla de plataforma) y las `container_templates` que dependían de ellos, y sustituye `@host@` y `@company@`.
- El esquema rechaza claves que el ordenador fija por sí mismo (`executor_user`, `roots`, `native`, `signer`…), bundles fuera de `@release@/`, una autoridad que no sea `@identity@`/`@host@` y URLs con credenciales o sin TLS (HTTP solo hacia loopback, para pruebas). Los bundles exigen los mismos campos que el executor (`directory`, `digest` `sha256:`, `executable`, `executable_sha256`, `argv`).

### Clave de firma

La única clave de la autoridad de flota es la CA RSA X.509 que emite los certificados mTLS de los agentes; vive en el enclave root de la autoridad central y el gateway (uid 1000) no la lee por diseño ([despliegue del controlador](v3.5-controlador-despliegue.md)). Firmar JSON con ella mezclaría usos y obligaría a exponerla al gateway, y el contrato del ordenador ya exige Ed25519. Por eso la preparación usa **una clave Ed25519 propia del gateway** (`signing_key_file`, PEM PKCS#8 0600 del uid del gateway), cuya huella ancla cada invitación. Rotarla obliga a re-anclar cada ordenador con `cauce hosts setup --signer-fingerprint <huella nueva>`.

## Prueba de punta a punta

```bash
CAUCE_HOST_SETUP_E2E=1 npx vitest run services/gateway/src/fleet/host-setup.e2e-docker.test.ts
```

Arranca PostgreSQL de prueba, el gateway en loopback con la autoridad firmada real (issuer y CA de prueba) y un contenedor limpio (systemd como PID 1, usuario `cauce` con linger, Python 3.12 con PyYAML, OpenSSL, Node 22 y el socket Docker del anfitrión, red del host). El release se construye con los ficheros versionados del árbol de trabajo (`ops/cli`, `ops/scripts`, `ops/container-runtime`, `ops/schemas` y los descriptores) y el proceso del host empaquetado por esbuild; el arnés vive en `services/gateway/src/fleet/host-computer.fixtures.ts`. Un usuario recién registrado crea su empresa e invita el ordenador; en el contenedor, `cauce hosts enroll` y `cauce hosts setup` instalan el servicio de usuario, y el gateway ve `executor_ready=true`, `cauce hosts status` sale 0 y la capacidad de la empresa incluye el ordenador, sin ningún `platform_admins`. Otra empresa no ve el ordenador y una petición firmada por éste hacia el host de la otra empresa recibe 403.

Después, la persona crea un agente desechable `zz-canary-*` y la operación termina `succeeded`: su contenedor aparece en `docker ps` y las sondas de bootstrap y normal devuelven el nonce correlacionado. El usuario de ejecución de la plantilla comparte uid con el executor, porque el pin del CLI del proveedor solo confía en ancestros de root o del propio usuario y el release está bajo la raíz de instalación del executor. El ciclo completo desde la consola (update, contexto, stop, retiro y purga) está en `tests/e2e/v4-fleet-cycle-real-browser.test.ts`. Falta lo que ya pedía este documento:

- el constructor del release distribuible (hoy lo arma la prueba) y su publicación con URL HTTPS;
- la configuración y la clave de preparación en producción;
- Docker en el ordenador y una imagen de runtime (adapter y CLI del proveedor) fijada por digest;
- un login real del proveedor en el paso `authenticate` y el transporte mTLS del agente hacia el gateway;
- la política de autenticación de agentes enrolada (`CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`).
