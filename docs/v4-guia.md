# Guía de uso y administración de Cauce V4

Describe el comportamiento implementado en este árbol. Publicarlo sigue [Desplegar V4](operacion.md#desplegar-v4). Cada apartado enlaza el documento de área, donde está el contrato largo.

## Uso desde la interfaz

La consola es la SPA de `console/` (`console/src/App.tsx:40-95`). El menú (`console/src/nav.ts:53-112`) abre estas vistas; la ruta es el id:

| Ruta | Vista |
|---|---|
| `/` | redirige a Chat |
| `/messages` | Chat |
| `/live` | Oficina |
| `/accounts` | Cuentas y cuotas |
| `/my-quotas` | Mis cuotas |
| `/queues` | Colas y DLQ |
| `/observability` | Señales y auditoría |
| `/config` | Ajustes |
| `/terminal` | Terminal |
| `/ayuda` | Ayuda |

Estas direcciones antiguas abren la vista vigente (`console/src/nav.ts:24-48`): `overview`, `fleet`, `topology` y `activity` abren Oficina; `licenses`, `quotas` y `assignments` abren Cuentas y cuotas; `audit` y `relays` abren Señales y auditoría. Una dirección que la consola no declara conserva la URL y avisa que no existe.

- **Operación:** iniciar sesión en `/login` (`POST /v3/auth/login`) o registrarse en `/register` (`POST /v3/auth/register`), navegar por el menú lateral y ejecutar cambios con previsualización o confirmación explícita antes de aplicar.
- **Recuperación:** ante fallo de lectura o conflicto `409` de revisión, las vistas de oficina, contextos, cuotas y ajustes conservan el borrador abierto, bloquean el envío para no sobrescribir a ciegas y ofrecen releer el estado vigente desde PostgreSQL antes de reintentar ([estados de la consola](v4-consola-estados.md)). Si la sesión expira (`401`), volver a autenticar en `/login` y recargar la vista.

Registro, empresa, cuotas, oficina, contextos, ordenadores y copias: [Consola V4](v4-consola.md). Armazón de la SPA: [Consola web](consola.md).

## Administración

`POST /v3/auth/register` (`services/gateway/src/password-auth.ts:590-655`, cuerpo máximo 8 KiB) responde 201 y crea, en una transacción, la empresa, el tenant hub, la sala `office`, el agente `owner`, su membresía de operador y la fila `company_admins` con rol `owner` (`cauce_register_company` en `055_company_registration.sql`, ampliada en `063_company_registration_director.sql`). También deja un principal `context-director` inactivo (`enabled=false`, estado `draft`) con rol `context_broker`: publica contexto y no consume entregas. Un identificador reservado por la plataforma responde 409, igual que uno ya ocupado. El inicio de sesión es `POST /v3/auth/login`.

La plataforma lista, crea, edita y retira empresas en `/v3/console/companies` (`services/gateway/src/routes/console/companies.ts:56-125`). El retiro marca `retired` y conserva los datos. Crear una empresa exige `platform_admin`. El listado devuelve todas las empresas a ese rol y, al resto, la empresa de origen. El detalle de un id distinto de la empresa activa exige `platform_admin`. Los administradores se leen y se cambian en `GET`/`PUT /v3/console/companies/:company_id/admins` (`services/gateway/src/routes/console/companies.ts:127-165`), con rol `owner`, `admin` o `null` y `expected_version`. Las personas de la empresa se administran en `/v3/console/people` (`services/gateway/src/console/people-admin-routes.ts:58-120` y `services/gateway/src/console/people-admin-store.ts:24-32`). La empresa activa de la sesión se elige en `POST /v3/auth/session/company` (`services/gateway/src/console-security.ts:26`).

`cauce platform` (`ops/cli/cauce-platform` y `ops/cli/platform_admin.mjs:29-175`) despacha `admin`, `empresa`, `enlace`, `contexto` y `contenedor`. El resto entra en el CLI de configuración autenticado. Argumentos, transferencia y siembra: [CLI de Cauce V4](v4-cli.md). La migración `081_membresia_rol_derivado.sql` elimina `human_tenant_memberships.role`, deriva el rol de `console_users.role` y aplica el techo de permisos `read` para `reader` ([membresías](v4-membresias.md)).

- **Operación:** dar de alta o editar personas en `/config` (sección Personas, `/v3/console/people`), asignar `owner` o `admin` en `/v3/console/companies/:company_id/admins` con `expected_version`, o administrar roles de plataforma con `cauce platform --actor-email <correo> --company <id> --dsn-file <dsn> admin otorgar|revocar`.
- **Recuperación:** las invariantes SQL impiden revocar o degradar al último `owner` de una empresa (`054_company_admin_guards.sql`) o al último `platform_admin`. Ante un conflicto `409` de revisión en administradores o personas, releer el estado (`GET /v3/console/companies/:company_id/admins` o `GET /v3/console/people`) y reintentar con la versión vigente. Si un dueño pierde acceso de sesión o contraseña, un `platform_admin` restablece la cuenta o concede un dueño adicional con `cauce platform admin otorgar` o `maintainConsoleUser` (`services/gateway/src/console-user-maintenance.ts:53-92`, que al degradar a `reader` recorta automáticamente la membresía hogar a `['read']` mediante `clampReaderHomeMembership`).

## CLI

`ops/cli/cauce` (`ops/cli/cauce:12-65`) conserva el despacho de terminales de un agente y, antes de ese despacho, acepta:

| Entrada | Qué hace |
|---|---|
| `cauce platform` | administración y transferencia de una empresa (`ops/cli/platform_admin.mjs`) |
| `cauce hosts` | enrolar, latido, preparar y consultar el executor (`ops/cli/host_enrollment.py`, `ops/cli/host_setup.py`) |
| `cauce login` | iniciar, consultar (`--status`) o renovar (`--renew`) la sesión nominal de consola (`ops/cli/cauce-login`) |
| `cauce <alias>` | abrir terminal dinámica (`harness_rw`, `shell` o `harness`) por gateway y `terminal-relay` con la sesión de `cauce login` (`ops/cli/context_client.py`) |
| `cauce context` | contexto versionado por el gateway (`ops/cli/context_client.py`) |
| `cauce context-native` | ingesta, con sesión humana de consola, de una lista explícita de archivos de `context/` o `directives/` (`ops/cli/context_native.py`) |
| `cauce spaces` | registro durable del agente (`ops/cli/cauce-spaces`); `backup`, `restore`, `inventory` y `migrate` archivan o migran el espacio (`ops/cli/space_archive.py`) |
| `cauce diagnose` | cadena de diagnóstico de la empresa de la sesión (`ops/cli/cauce-diagnose`) |

Instalación (`ops/scripts/install-cauce-cli.sh`), permisos de los archivos de sesión y `CAUCE_FLEET_RUNTIME_STATE`: [CLI de Cauce V4](v4-cli.md).

Las ediciones hechas en el espacio del agente entran al historial por dos vías con autoridades distintas:

- **`cauce context-native`, a petición de una persona.** Usa la sesión humana. Lee el snapshot y envía `PUT /v3/console/context/agents/:tenant/:alias` con `source: native`, la versión esperada y los archivos de la lista, que pueden estar en cualquier ruta permitida de `context/` o `directives/`. Código: `ops/cli/context_native.py:12-28` y `services/gateway/src/context-version.routes.ts:70-74`.
- **El SDK, sin intervención, al preparar el turno siguiente.** Solo registra cambios bajo `context/notes/**`. Usa `POST /v3/context/ingest` con el certificado del propio agente. Código: `packages/adapter-sdk/src/sdk/engine/native-context-ingest.ts:61` y `services/gateway/src/context-version.routes.ts:48-53`. Cualquier otra ruta cambiada se rechaza como `context_governed_path` (`packages/store/src/context-version.ts:134-137`). Esas ediciones no crean versión: el turno sigue con el snapshot autorizado y la divergencia queda apartada o local ([CLI](v4-cli.md#ingesta-de-archivos-locales)).

Una edición local de perfil o directivas solo llega al historial si una persona la ingiere con la CLI o la escribe en la consola.

- **Operación:** iniciar sesión con `cauce login --gateway <url> --email <correo>`, abrir terminal con `cauce <tenant>/<alias>` (salir con `Ctrl-]`), operar espacios con `cauce spaces list|create|edit|retire` (previsualización por defecto, `--apply` para ejecutar) y gestionar contextos con `cauce context`.
- **Recuperación:** si un comando devuelve `401`, renovar con `cauce login --renew` o iniciar sesión de nuevo. Si se corta la red durante `cauce <alias>`, la sesión y la concesión de control se liberan al cerrar el WebSocket; basta repetir `cauce <alias>`. Si `cauce spaces --apply` queda en `queued` o `running` tras un corte de red, consultar `cauce spaces list --tenant <tenant>` o reintentar con la misma `--idempotency-key` y `--expected-revision`.

## Arquitectura multitenant

PostgreSQL sigue siendo la fuente durable (`packages/store/migrations/051_companies.sql`–`081_membresia_rol_derivado.sql`). La consola resuelve la autoridad de empresa en cada solicitud mediante `resolveCompanyAuthority` (`packages/store/src/company-authority.ts:55-145`). `platform_admin` lista todas las empresas; el listado de los demás roles contiene la empresa de origen y el detalle usa la empresa activa. La migración `053_company_isolation.sql` rellena `company_id` al insertar, lo deja inmutable y aborta un par de tenants de empresas distintas que no tenga un enlace explícito en `company_links`. La matriz `ROUTE_ISOLATION_MATRIX` (`services/gateway/src/security/route-isolation-matrix.ts`) y la suite `services/gateway/src/security/route-isolation.postgres.test.ts` verifican que todas las rutas `/v3` rechacen IDs cruzados sin efectos laterales.

- **Operación:** cada persona opera dentro de su `company_id` de origen; un `platform_admin` cambia explícitamente su empresa activa con `POST /v3/auth/session/company` o desde el selector de empresa de la consola, quedando cada acción registrada con `platform_override: true` en `audit_events`. Los enlaces entre empresas se administran con `cauce platform enlace crear|borrar`.
- **Recuperación:** cualquier intento de cruzar recursos de otra empresa se rechaza con `403`/`404` o por las restricciones e invariantes de PostgreSQL (`053_company_isolation.sql`). Si un cambio de empresa activa queda apuntando a una empresa retirada, volver a la empresa de origen con `POST /v3/auth/session/company`. Para verificar el aislamiento tras un incidente o antes de publicar, ejecutar `pnpm --filter @cauce/gateway exec vitest run src/security/route-isolation.postgres.test.ts`.

El mapa del bus está en [arquitectura](arquitectura.md). Registro, empresas, canal firmado del ordenador y autoridad: [núcleo distribuido](v4-nucleo-distribuido.md).

## Registro de ordenadores

Un humano autorizado crea la invitación en la consola (`POST /v3/console/fleet/hosts/enrollments`, `services/gateway/src/console/host-enrollment.routes.ts:55-76`). El ordenador la reclama con `cauce hosts enroll --gateway <url> --invitation-stdin` (`ops/cli/host_enrollment.py:120-210`, que llama a `POST /v3/fleet/hosts/enrollments/:enrollment_id/claim` en `services/gateway/src/console/host-enrollment.routes.ts:78-85`) y guarda una identidad Ed25519 en su estado local (`~/.local/state/cauce-v3/hosts/<empresa>/<host_id>`). `cauce hosts heartbeat` (`POST /v3/fleet/hosts/:host_id/heartbeat`) confirma presencia. `cauce hosts setup` (`ops/cli/host_setup.py:420-560`, que consulta `POST /v3/fleet/hosts/:host_id/setup`) instala el executor como servicio de usuario `cauce-fleet-executor.service` (`--dry-run` muestra el plan). `cauce hosts status` sale 0 cuando `executor_ready` es verdadero y 3 cuando no. El latido y el executor listo son estados distintos.

- **Operación:** emitir invitación en Ajustes → Ordenadores (TTL de 10 min, un solo uso), ejecutar `cauce hosts enroll` en el servidor destino, verificar `cauce hosts setup --dry-run`, aplicar `cauce hosts setup` y confirmar `cauce hosts status` con salida 0 (`executor_ready: true`).
- **Recuperación:** si `enroll` falla por corte de red tras reclamar la invitación, repetir el mismo comando con la misma invitación (es idempotente y recupera la identidad ya confirmada). Si la invitación caducó sin confirmarse y dejó `"state":"pending"` en `identity.json`, cancelar la invitación en la consola (`DELETE /v3/console/fleet/hosts/enrollments/:id`), borrar el directorio local pendiente `~/.local/state/cauce-v3/hosts/<empresa>/<host_id>` y emitir una invitación nueva. Si `cauce-fleet-executor.service` cae o cambia el artefacto del controlador, ejecutar `cauce hosts setup` y `systemctl --user restart cauce-fleet-executor.service` ([alta de servidor](v4-alta-servidor.md)).

Firma del paquete, ancla y política: [Ordenadores](v4-ordenadores.md).

## Gestión de agentes

Ajustes (`/config`) crea, edita y retira tenants, salas, membresías y agentes con `POST /v3/console/config/changes`, y puede revertir una revisión. Las operaciones físicas de ciclo de vida del agente (`create`, `update`, `start`, `stop`, `retire`, `purge`, `relocate`) se encolan con CAS e idempotencia en `POST /v3/console/fleet/operations` (`services/gateway/src/console/fleet-operations.routes.ts:96-180`) y las reclama el ordenador destino por su canal firmado (`POST /v3/fleet/hosts/:host_id/channel` en `services/gateway/src/fleet/host-channel.routes.ts:65-120` y `ops/cli/fleet-executor.py:45-110`). La ficha lee `GET /v3/console/agents` y `GET /v3/console/agents/:alias`.

`cauce spaces create|list|edit|retire` (`ops/cli/cauce-spaces:1-380`) opera el registro durable y las operaciones de flota desde la CLI. Sin `--apply` muestra el plan. `--registry-only` cambia el registro y deja el runtime como está. El censo y la ubicación prevista están en el [plan de migración](v4-migracion-plan.md).

- **Operación:** previsualizar el alta, edición, parada, retiro o purga en Ajustes o con `cauce spaces`, aplicar con `expected_revision` e `idempotency_key`, y seguir el recibo en `GET /v3/console/fleet/operations/:id` hasta `succeeded`.
- **Recuperación:** si una operación queda en `awaiting_auth`, completar el login del proveedor en la consola y reanudarla con `POST /v3/console/fleet/operations/:id/resume`. Si falla (`failed`), inspeccionar el motivo y el paso en `GET /v3/console/fleet/operations/:id` o `cauce diagnose <operation_id>`, corregir la causa en el host y lanzar una nueva operación con la revisión vigente. Para limpiar contenedores o directorios huérfanos de pruebas o fallos previos en el host, ejecutar `ops/cli/fleet_orphan_sweep.py` (`ops/cli/cauce-huerfanas`).

## Harnesses

Cada harness publicado es un descriptor en `packages/adapter-sdk/descriptors/` validado por `packages/adapter-sdk/src/context/harness-descriptor.ts:1-190` y ejecutado en el host por `ops/cli/harness_operations.py:1-290`. El parser acepta recetas cerradas. Operaciones declaradas:

| Harness | Operaciones | Documento nativo |
|---|---|---|
| `claude` | install, execute, authenticate, update, quota | `CLAUDE.md` |
| `codex` | install, execute, authenticate, update, quota | `AGENTS.md` |
| `grok` | install, execute, authenticate, quota | `AGENTS.md` |
| `muse` | install, execute, authenticate | `AGENTS.md` |
| `openclaw` | install, execute, authenticate | `AGENTS.md` |
| `hermes` | install, execute | `AGENTS.md` |
| `opencode` | install, execute | `AGENTS.md` |
| `fake`, `fake2` | install, execute | `AGENTS.md` |

`grok`, `muse` y `openclaw` declaran además `fleet_module`. `fake` y `fake2` no están en el catálogo de documentos de Ajustes. Alta de un harness y mapa proveedor: [espacios y contextos](v4-archivos-contextos.md). Autenticación en el ordenador: [autenticación de runtime](v4-autenticacion-runtime.md).

- **Operación:** declarar o modificar el descriptor en `packages/adapter-sdk/descriptors/<harness>.json`, generar el mapa de aprobaciones firmadas del dueño con `python3 ops/scripts/harness-descriptor-approvals.py --descriptors packages/adapter-sdk/descriptors --approve <harness>... --output <archivo>` (`ops/scripts/harness-descriptor-approvals.py:27-85`) y publicar la política firmada del host.
- **Recuperación:** si el gateway o el executor rechazan una operación de harness (`descriptor_unapproved` o discrepancia de `descriptor_sha256`), verificar el digest del descriptor frente al archivo de aprobaciones montado en `CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE`, regenerar la aprobación y la política del host con `ops/scripts/fleet-authority-install.py` y reejecutar `cauce hosts setup`.

## Credenciales

`credential_ref` es un localizador (variable de entorno, archivo o gestor de secretos) cifrado con AES-256-GCM en `secret_ciphertext` (`packages/store/src/configuration.ts:180-260`). La lectura de configuración no lo devuelve, tampoco al pagador de la cuenta (`packages/store/src/configuration.ts:510-560`). Una empresa que toma prestada una cuenta compartida recibe proveedor, pagador y etiqueta; `external_account_id` y `credential_ref_kind` quedan en el alcance del pagador.

La credencial del proveedor permanece en el perfil del entorno o del agente, gestionada por `ops/cli/provider-login.py:29-65`, `services/gateway/src/fleet/agent-provider-auth-broker.ts:25-110` y `services/gateway/src/fleet/quota-auth-broker.ts:185-240`. El monitor `ops/guardias/cred-guard.py:214-260` vigila caducidades sin exponer secretos. Consentimiento y verificación de identidad: [autenticación de runtime](v4-autenticacion-runtime.md).

- **Operación:** autenticar el perfil del agente o del entorno de cuota desde la consola (con consentimiento explícito y sesión acotada con TTL) o mediante `cauce <alias> reautenticar` (`ops/cli/cauce-credenciales.lib.sh`).
- **Recuperación:** si `cred-guard.py` o la consola reportan credencial vencida, revocada o `awaiting_auth`, lanzar una nueva operación `authenticate` sobre la cuenta o el agente; si el login falla o expira el TTL, el host limpia la sesión temporal y conserva el estado anterior hasta completar una autenticación verificada (`ops/cli/fleet_provider_revoke.py`).

## Cuotas

«Mis cuotas» (`/my-quotas`, `console/src/features/accounts/MyQuotasPage.tsx:1-260`) administra cuentas propias de la empresa. `POST /v3/console/quota-accounts` (`services/gateway/src/routes/console/quota-environments.ts:62-95`) acepta proveedor `claude`, `codex` o `grok`. Los entornos (`/v3/console/quota-environments`, `services/gateway/src/routes/console/quota-environments.ts:96-145`) aceptan las acciones `create`, `authenticate`, `query`, `update_cli` y `delete`, ejecutadas en el host por `ops/cli/quota_runtime.py:41-190`. `authenticate` exige consentimiento. La ficha del agente lee y pide la cuota en `/v3/console/agents/:tenant/:alias/quota` mediante `ops/cli/fleet_executor_agent_quota.py:119-185`.

- **Operación:** dar de alta la cuenta en «Mis cuotas», crear su entorno en un ordenador enrolado con capacidad de cuotas, autenticar con consentimiento y ejecutar `query` para actualizar las ventanas reales o `update_cli` para actualizar el binario del proveedor.
- **Recuperación:** los estados `unknown`, `error` y `stale` se distinguen de `exhausted` (`docs/v4-cuotas.md`). Si `query` falla por sesión caducada (`auth_expired`), ejecutar `authenticate` en el entorno y repetir `query`. Si el contenedor del entorno queda corrupto o falla la creación, ejecutar `delete` en `/v3/console/quota-environments` (que limpia contenedor y perfil en el host) y volver a crearlo.

Estados, imagen (`ops/cuotas/Dockerfile`) y capacidades del ordenador: [Cuotas](v4-cuotas.md).

## Oficina

`/live` (`console/src/features/live/LiveFleetPage.tsx:70-210` y `console/src/features/office/OfficeWorkspace.tsx:20-160`) muestra la oficina a partir de la topología. El plano editable es `GET`/`PUT /v3/console/office/layout` (`services/gateway/src/console/company-office.routes.ts:9-24`), con `expected_version` para el CAS. Las preferencias de la persona en la empresa, incluidos los pines de cuentas, son `GET`/`PUT /v3/console/preferences` (`services/gateway/src/console/company-office.routes.ts:9-24`). Los favoritos y la apariencia por agente se guardan en `/v3/console/agent-preferences` (`services/gateway/src/routes/console/agent-preferences.ts:118-205`). Estados de cuota en el plano y la ficha: [Consola V4](v4-consola.md).

- **Operación:** editar salas y puestos en `/live`, guardar el plano con `PUT /v3/console/office/layout` pasando `expected_version`, y fijar favoritos o apariencia de agentes desde la ficha.
- **Recuperación:** si otro operador guardó antes y la API devuelve `409 conflict`, o si falla la red (`console/src/features/office/office-errors.ts`), la consola conserva el borrador en pantalla y muestra el aviso en español; recargar el plano actual (`GET /v3/console/office/layout`) o restablecer la apariencia de un agente con `DELETE /v3/console/agent-preferences` (`resetAppearance`) devuelve al estado consistente en PostgreSQL.

## Estructura de archivos

`prepareSpaceLayout` (`packages/adapter-sdk/src/context/space-layout.ts:9-25`) exige una raíz absoluta y crea, en modo `0700` y sin salir por enlaces simbólicos, `context/`, `directives/`, `projects/`, `config/`, `data/`, `logs/` y `tmp/`. El supervisor de contenedor monta y conmuta el directorio de trabajo a `space/projects` cuando el espacio está migrado (`ops/scripts/container-adapter-supervisor.sh:132-185`). Quién escribe cada directorio y qué entra en una copia: [espacios y contextos](v4-archivos-contextos.md).

- **Operación:** inspeccionar un espacio existente sin modificarlo con `python3 ops/cli/space_archive.py inventory --directory <ruta> --dry-run --identity-file <json>` y migrar el workspace legado a la estructura estándar con `python3 ops/cli/space_archive.py migrate --directory <ruta> --workspace <workspace-origen> --identity-file <json>` (`ops/cli/space_archive.py:591-735`).
- **Recuperación:** `migrate` copia verificando hashes sin borrar el workspace de origen y es reanudable. Si un archivo falla o hay conflicto de destino, `space_archive.py` aborta sin truncar el origen; se corrige el archivo en conflicto y se repite `migrate`, o se mantiene el agente sin el marcador de conmutación (`container-adapter-supervisor.sh:179`) para que siga operando sobre el workspace previo.

## Integración con GitHub

El historial durable está en PostgreSQL (`packages/store/src/context-version.ts`). `ContextGitBroker` (`packages/store/src/context-git.ts:25-180`) publica `context/` y `directives/` bajo `companies/<empresa>/tenants/<tenant>/agents/<alias>/` (`contextRepositoryPrefix`). Los agentes reciben el contenido por Cauce. La API de consola es `/v3/console/context/agents/:tenant/:alias` (`services/gateway/src/context-version.routes.ts:70-160`): `GET` y `GET /status` leen el snapshot, `PUT` escribe (202), `GET /history` y `GET /diff` consultan el historial, `POST /restore` y `POST /sync/retry` responden 202. `POST /apply` pide la aplicación al runtime y responde 202; si no hay runtime configurado responde 503 y conserva la versión. Contrato del broker: [espacios y contextos](v4-archivos-contextos.md).

- **Operación:** verificar la preparación del repositorio del broker con `ops/scripts/context-broker-preflight.py` (`ops/scripts/context-broker-preflight.py:42-90`), editar o restaurar versiones en la consola o con `cauce context`, y solicitar `POST .../apply` para entregar la versión al agente a través del `context-director` de la empresa.
- **Recuperación:** si el push a GitHub falla (`context_push_failed`, estado `failed`), la versión queda guardada en PostgreSQL y el commit retenido en `main` local del broker; tras diagnosticar con `context-broker-preflight.py` y restablecer el remoto o la deploy key, pulsar **Reintentar** (`POST /v3/console/context/agents/:tenant/:alias/sync/retry` o `cauce context retry`) para hacer fetch, integrar por carpeta y publicar sin perder commits. Si una edición choca con otra versión (`409`), usar `GET .../diff` o `POST .../restore` para crear una versión nueva con `expected_version` actualizada.

## Migraciones

- **Migraciones de esquema (`packages/store/migrations/`):** `runMigrations` (`packages/store/src/db.ts:93-195`) toma los bloqueos declarados en `packages/store/src/migration-locks.ts:20-78` con `lock_timeout` de 5 s y aplica todas las migraciones pendientes en **una sola transacción**.
  - *Operación:* ensayar primero contra un dump en contenedor desechable con `ops/scripts/rehearse-migrations-clone.sh` (`ops/scripts/rehearse-migrations-clone.sh:13-120`); en producción las ejecuta `deploy/deploy.sh` tras verificar un backup de ≤2 h y detener temporalmente `dispatcher`.
  - *Recuperación:* si una migración falla o supera `lock_timeout`, PostgreSQL revierte toda la transacción, `deploy/deploy.sh` (`deploy/deploy.sh:573-580,735`) termina el backend `cauce-migrator`, reanuda `dispatcher` y no toca `prod.env`. Si se requiere revertir una migración ya aplicada en un entorno de prueba o tras incidente, usar su script en `packages/store/migrations/down/` o restaurar el backup previo con `ops/scripts/restore-postgres.sh`.
- **Migración de agentes entre servidores ([plan de migración](v4-migracion-plan.md)):**
  - *Operación:* medir huella «antes» con `ops/scripts/v4-medicion-migracion.sh medir` (`ops/scripts/v4-medicion-migracion.sh:14-95`), crear y validar copia del espacio (`cauce spaces backup` y restauración de prueba), detener el agente en el origen antes de refrescar credenciales en destino, activar en el servidor destino y verificar turno con nonce, terminal, cuota y contexto antes de medir «después» con `--alcance-de`.
  - *Recuperación:* el origen se conserva detenido durante 7 días sin borrarse; si el agente falla en el servidor destino, detener el contenedor/servicio en el destino, reactivar las unidades del origen y reautenticar el proveedor si el refresh token rotó.

## Copias de seguridad

La consola pide una copia del espacio del agente (`services/gateway/src/console/space-backup.routes.ts:11-90`):

- `POST /v3/console/spaces/:tenant_id/:alias/backups`
- `GET /v3/console/spaces/:tenant_id/:alias/backups/:id`
- `GET .../download` cuando el recibo está `ready`

El host la ejecuta por `POST /v3/fleet/hosts/:host_id/space-backups` (`services/gateway/src/fleet/space-backup.routes.ts:9-65` y `ops/cli/space_backup_runtime.py:21-85`). En el ordenador, `cauce spaces backup` (`ops/cli/space_archive.py:220-310`) escribe un ZIP del directorio con manifiesto y SHA-256. Límites, omisiones y orden de despliegue: [copias de espacios](v4-copias-espacios.md) y [runbook de copias](v4-runbook-copias.md).

- **Operación:** solicitar el backup desde la ficha del agente (`SpaceBackupPanel.tsx`) o con `cauce spaces backup`, esperar a que el recibo pase a `ready`, descargar el archivo y verificar su `sha256` y la lista de omisiones del manifiesto.
- **Recuperación:** si el directorio cambia durante la lectura o supera los topes de tamaño/entradas, `space_archive.py` aborta y marca el recibo `failed` sin dejar archivos parciales descargables; aquietar la escritura del agente (o pausarlo) y solicitar un backup nuevo con otra `idempotency_key`.

## Restauración

`cauce spaces restore` llama a `restore_space` en `ops/cli/space_archive.py:387-490` tras validar el archivo con `ops/cli/space_backup_validate.py:18-55`. El destino tiene que ser un directorio nuevo o vacío. La restauración comprueba el manifiesto y la identidad esperada (`company_id`, `tenant_id`, `agent_id`), escribe los archivos admitidos en modo seguro y deja `space-restore-receipt.json`. El mismo contrato está en [copias de espacios](v4-copias-espacios.md), [runbook de copias](v4-runbook-copias.md) y en el [CLI](v4-cli.md).

- **Operación:** validar el ZIP con `python3 ops/cli/space_backup_validate.py`, ejecutar `cauce spaces restore` hacia un directorio destino nuevo o vacío pasando la identidad esperada del agente y comprobar `status: "restored"` en `space-restore-receipt.json`.
- **Recuperación:** si el archivo está corrupto, contiene enlaces simbólicos o rutas fuera del espacio, o la identidad no coincide, `restore_space` rechaza la operación antes de habilitar el espacio; eliminar el directorio destino fallido, corregir la identidad o recurrir al backup anterior verificado, y tras restaurar reautenticar las credenciales del proveedor (que nunca viajan en el backup).

## Despliegue

El despliegue de V4 usa `scripts/release-gates.sh` (`scripts/release-gates.sh:44-340`), `deploy/deploy.sh` (`deploy/deploy.sh:570-760`) y `ops/scripts/fleet-authority-install.py` (`ops/scripts/fleet-authority-install.py:34-490`) con el overlay de flota, el proxy frontal, los identificadores reservados, el controlador, el enclave y la semilla de autoridad. Variables, orden, comprobaciones y reversión: [Desplegar V4](operacion.md#desplegar-v4).

- **Operación:** correr `scripts/release-gates.sh` hasta obtener el recibo en verde, ensayar migraciones en un clon con `ops/scripts/rehearse-migrations-clone.sh`, ejecutar `deploy/deploy.sh` y actualizar el enclave de autoridad firmada con `ops/scripts/fleet-authority-install.py`.
- **Recuperación:** si `migrator` o `smoke.sh` fallan, `deploy/deploy.sh` conserva o restaura `prod.env.pre-deploy-<STAMP>` y reanuda `dispatcher`; para revertir manualmente una release ya publicada, restaurar `prod.env.pre-deploy-<STAMP>` a `prod.env` y ejecutar `docker compose up -d --wait --remove-orphans`. Si falla la actualización de `cauce-fleet-signed-authority.service`, `fleet-authority-install.py` revierte al enclave anterior conservado por el kit y `journalctl -u cauce-fleet-signed-authority` indica la etapa exacta (`configuration`, `database configuration`, `issuer command` o `socket`).

## Diagnóstico

`cauce diagnose <id> --gateway <url> --origin <url> --session-file <archivo>` (`ops/cli/cauce-diagnose:1-85`) lee `GET /v3/console/diagnose/*` (`services/gateway/src/routes/console/diagnose.ts:255-295`) con la sesión de consola. La consulta usa la empresa activa de esa sesión y recorre trazas, mensajes, entregas, sesiones, operaciones de flota y copias en PostgreSQL (`packages/store/src/repository/observability.ts:75-210`). El inventario de mecanismos de auditoría y los pasos ante fallos están en [diagnóstico](v4-diagnostico.md) y [rupturas](v4-rupturas.md).

- **Operación:** ejecutar `cauce diagnose <id>` (con `message_id`, `delivery_id`, `correlation_id`, `operation_id` o `backup_id`) o consultar `/observability` y `/queues` en la consola para inspeccionar la cadena causal dentro de la empresa activa.
- **Recuperación:** si el endpoint devuelve `429 diagnose_busy` (`Retry-After: 1`), esperar un segundo y reintentar. Una vez localizado el eslabón fallido en la cadena: para entregas en DLQ, reconciliar o reencolar desde `/queues` (`cauce_dlq_apply_030`); para contextos en `failed`, lanzar `POST .../sync/retry`; para operaciones de flota o backups fallidos, corregir la causa en el host reportado por el evento y emitir una operación nueva.

## Pruebas

Qué está ejecutado en local y qué sigue abierto: [inventario de pruebas](v4-pruebas.md).

