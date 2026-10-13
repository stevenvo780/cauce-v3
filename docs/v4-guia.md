# Guía de uso y administración de Cauce V4

Describe el comportamiento implementado en este árbol. Publicarlo sigue [Desplegar V4](operacion.md#desplegar-v4). Cada apartado enlaza el documento de área, donde está el contrato largo.

## Uso desde la interfaz

La consola es la SPA de `console/`. El menú (`console/src/nav.ts`) abre estas vistas; la ruta es el id:

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

Estas direcciones antiguas abren la vista vigente: `overview`, `fleet`, `topology` y `activity` abren Oficina; `licenses`, `quotas` y `assignments` abren Cuentas y cuotas; `audit` y `relays` abren Señales y auditoría. Una dirección que la consola no declara conserva la URL y avisa que no existe.

Registro, empresa, cuotas, oficina, contextos, ordenadores y copias: [Consola V4](v4-consola.md). Armazón de la SPA: [Consola web](consola.md).

## Administración

`POST /v3/auth/register` (cuerpo máximo 8 KiB) responde 201 y crea, en una transacción, la empresa, el tenant hub, la sala `office`, el agente `owner`, su membresía de operador y la fila `company_admins` con rol `owner` (`cauce_register_company` en `055_company_registration.sql`, ampliada en `063_company_registration_director.sql`). También deja un principal `context-director` inactivo (`enabled=false`, estado `draft`) con rol `context_broker`: publica contexto y no consume entregas. Un identificador reservado por la plataforma responde 409, igual que uno ya ocupado. El inicio de sesión es `POST /v3/auth/login`.

La plataforma lista, crea, edita y retira empresas en `/v3/console/companies`. El retiro marca `retired` y conserva los datos. Crear una empresa exige `platform_admin`. El listado devuelve todas las empresas a ese rol y, al resto, la empresa de origen. El detalle de un id distinto de la empresa activa exige `platform_admin`. Los administradores se leen y se cambian en `GET`/`PUT /v3/console/companies/:company_id/admins`, con rol `owner`, `admin` o `null` y `expected_version`. La empresa activa de la sesión se elige en `/v3/auth/session/company`.

`cauce platform` despacha `admin`, `empresa`, `enlace`, `contexto` y `contenedor`. El resto entra en el CLI de configuración autenticado. Argumentos, transferencia y siembra: [CLI de Cauce V4](v4-cli.md). El inventario de conceptos de membresía está en [membresías](v4-membresias.md). `packages/store/migrations/` no contiene la migración que ese inventario propone.

## CLI

`ops/cli/cauce` conserva el despacho de terminales de un agente y, antes de ese despacho, acepta:

| Entrada | Qué hace |
|---|---|
| `cauce platform` | administración y transferencia de una empresa |
| `cauce hosts` | enrolar, latido, preparar y consultar el executor |
| `cauce login` | sesión nominal de consola |
| `cauce context` | contexto versionado por el gateway |
| `cauce context-native` | ingesta de una lista explícita de archivos |
| `cauce spaces` | registro durable del agente; `backup` y `restore` archivan el espacio |
| `cauce diagnose` | cadena de diagnóstico de la empresa de la sesión |

Instalación, permisos de los archivos de sesión y `CAUCE_FLEET_RUNTIME_STATE`: [CLI de Cauce V4](v4-cli.md).

## Arquitectura multitenant

PostgreSQL sigue siendo la fuente durable. La consola resuelve la autoridad de empresa en cada solicitud. `platform_admin` lista todas las empresas; el listado de los demás roles contiene la empresa de origen y el detalle usa la empresa activa. La migración `053_company_isolation.sql` rellena `company_id` al insertar, lo deja inmutable y aborta un par de tenants de empresas distintas que no tenga un enlace explícito.

El mapa del bus está en [arquitectura](arquitectura.md). Registro, empresas, canal firmado del ordenador y autoridad: [núcleo distribuido](v4-nucleo-distribuido.md).

## Registro de ordenadores

Un humano autorizado crea la invitación en la consola. El ordenador la reclama con `cauce hosts enroll --gateway <url> --invitation-stdin` y guarda una identidad Ed25519 en su estado local. `cauce hosts heartbeat` confirma presencia. `cauce hosts setup` instala el executor como servicio de usuario (`--dry-run` muestra el plan). `cauce hosts status` sale 0 cuando `executor_ready` es verdadero y 3 cuando no. El latido y el executor listo son estados distintos.

Firma del paquete, ancla y política: [Ordenadores](v4-ordenadores.md).

## Gestión de agentes

Ajustes (`/config`) crea, edita y retira tenants, salas, membresías y agentes con `POST /v3/console/config/changes`, y puede revertir una revisión. La ficha lee `GET /v3/console/agents` y `GET /v3/console/agents/:alias`.

`cauce spaces create|list|edit|retire` opera el registro durable. Sin `--apply` muestra el plan. `--registry-only` cambia el registro y deja el runtime como está. La relocalización entre ordenadores es una operación de flota. El censo y la ubicación prevista están en el [plan de migración](v4-migracion-plan.md).

## Harnesses

Cada harness publicado es un descriptor en `packages/adapter-sdk/descriptors/`. El parser acepta recetas cerradas. Operaciones declaradas:

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

## Credenciales

`credential_ref` es un localizador (variable de entorno, archivo o gestor de secretos). La lectura de configuración no lo devuelve, tampoco al pagador de la cuenta (`packages/store/src/configuration.ts`). Una empresa que toma prestada una cuenta compartida recibe proveedor, pagador y etiqueta; `external_account_id` y `credential_ref_kind` quedan en el alcance del pagador.

La credencial del proveedor permanece en el perfil del entorno o del agente. Consentimiento y verificación de identidad: [autenticación de runtime](v4-autenticacion-runtime.md).

## Cuotas

«Mis cuotas» (`/my-quotas`) administra cuentas propias de la empresa. `POST /v3/console/quota-accounts` acepta proveedor `claude`, `codex` o `grok`. Los entornos (`/v3/console/quota-environments`) aceptan las acciones `create`, `authenticate`, `query`, `update_cli` y `delete`. `authenticate` exige consentimiento. La ficha del agente lee y pide la cuota en `/v3/console/agents/:tenant/:alias/quota`.

Estados, imagen y capacidades del ordenador: [Cuotas](v4-cuotas.md).

## Oficina

`/live` muestra la oficina a partir de la topología. El plano editable es `GET`/`PUT /v3/console/office/layout`, con versión para el CAS. Las preferencias de la persona en la empresa, incluidos los pines de cuentas, son `GET`/`PUT /v3/console/preferences`. Estados de cuota en el plano y la ficha: [Consola V4](v4-consola.md).

## Estructura de archivos

`prepareSpaceLayout` (`packages/adapter-sdk/src/context/space-layout.ts`) exige una raíz absoluta y crea, en modo `0700` y sin salir por enlaces simbólicos, `context/`, `directives/`, `projects/`, `config/`, `data/`, `logs/` y `tmp/`. Quién escribe cada directorio y qué entra en una copia: [espacios y contextos](v4-archivos-contextos.md).

## Integración con GitHub

El historial durable está en PostgreSQL. El broker publica `context/` y `directives/` bajo `companies/<empresa>/tenants/<tenant>/agents/<alias>/` (`contextRepositoryPrefix`). Los agentes reciben el contenido por Cauce. La API de consola es `/v3/console/context/agents/:tenant/:alias`: `GET` y `GET /status` leen el snapshot, `PUT` escribe (202), `GET /history` y `GET /diff` consultan el historial, `POST /restore` y `POST /sync/retry` responden 202. `POST /apply` pide la aplicación al runtime y responde 202; si no hay runtime configurado responde 503 y conserva la versión. Contrato del broker: [espacios y contextos](v4-archivos-contextos.md).

## Migraciones de esquema

Las migraciones viven en `packages/store/migrations/`. `deploy/deploy.sh` las aplica dentro de su contrato (recibo de gates, build, migrate, pin, up, smoke) antes de levantar la pila. Ensayo y reversión: [operación](operacion.md#desplegar-v4).

## Copias de seguridad

La consola pide una copia del espacio del agente:

- `POST /v3/console/spaces/:tenant_id/:alias/backups`
- `GET /v3/console/spaces/:tenant_id/:alias/backups/:id`
- `GET .../download` cuando el recibo está `ready`

El host la ejecuta por `POST /v3/fleet/hosts/:host_id/space-backups`. En el ordenador, `cauce spaces backup` escribe un ZIP del directorio. Límites, omisiones y orden de despliegue: [copias de espacios](v4-copias-espacios.md).

## Restauración

`cauce spaces restore` llama a `space_archive.py restore`. El destino tiene que ser un directorio nuevo o vacío. La restauración comprueba el manifiesto, escribe los archivos admitidos y deja `space-restore-receipt.json`. El mismo contrato está en [copias de espacios](v4-copias-espacios.md) y en el [CLI](v4-cli.md).

## Despliegue

El primer despliegue de V4 usa `deploy/deploy.sh` con el overlay de flota, el proxy frontal, los identificadores reservados, el controlador, el enclave y la semilla de autoridad. Variables, orden, comprobaciones y reversión: [Desplegar V4](operacion.md#desplegar-v4).

## Diagnóstico

`cauce diagnose <id> --gateway <url> --origin <url> --session-file <archivo>` lee `GET /v3/console/diagnose/*` con la sesión de consola. La consulta usa la empresa activa de esa sesión. El id es una traza, una operación, una sesión, una entrega o una copia. El inventario de mecanismos de auditoría está en [diagnóstico](v4-diagnostico.md).

## Pruebas

Qué está ejecutado en local y qué sigue abierto: [inventario de pruebas](v4-pruebas.md).
