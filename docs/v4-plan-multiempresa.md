# V4: plan multiempresa

Auditoría de solo lectura sobre `5311c165`; las citas `archivo:línea` salen del código de ese commit.

## 0. Verificación propia de las afirmaciones críticas

| Afirmación de los auditores | Resultado |
|---|---|
| Un solo hub por instalación | CONFIRMADA. `tenants_single_hub_idx UNIQUE(is_hub) WHERE is_hub` en `migrations/003_adversarial_hardening.sql:18`. |
| `acl_edges` obliga a que una punta sea Steven (CHECK, "blocker") | REFUTADA. `001_initial.sql:40` lo define, pero `003:20-31` borra todo CHECK de `acl_edges` que contenga 'Steven'. Lo que rige hoy es la regla de estrella: `cauce_assert_hub_star` y su trigger (`004_runtime_gates.sql:13-15,50-64`). Cada arista debe tocar el hub. Es datos (`is_hub`), no un literal. |
| La sonda de gate está atada a Steven | CONFIRMADA, con matiz. `publish-operation.ts:41` exige tenant `'Steven'`, alias `'gate-probe'` y mTLS. `:47` exige sala `'grp.steven'`. `:57` usa `'kant'` solo como actor durable por la FK. `messages/publishing.ts:151-153` repite el triple Steven/grp.steven/kant. |
| Lista de directores fija | CONFIRMADA. `adapter-sdk/src/harnesses/shared/prompt.ts:150` define `DIRECTORES = {'Steven/argos','Hospital/operador'}`. |
| Todo lo administrativo es solo del hub | CONFIRMADA. `configuration/shared.ts:61-68`: un actor que no es hub solo puede operar `room`, `membership`, `egress_destination` y `acl_edge`. El resto queda con `scope:'none'`. El hub ve todo (`configuration.ts:78`, `scope = hub ? null : actorTenant`). |
| Administrar personas exige ser hub | CONFIRMADA. `people-admin-authority.ts:14-26`: el administrador efectivo debe ser `tenant.is_hub`. |
| No hay RLS | CONFIRMADA. No hay `ROW LEVEL SECURITY` ni `CREATE POLICY` en `migrations/`. |
| No hay exportar ni importar por empresa | CONFIRMADA. En `ops/scripts` solo existe `export-fleet-snapshot.py`, que es una vista operativa, y `backup.sh`, que respalda toda la base. |
| `runtime_key` global | CONFIRMADA. `048_ui_fleet_lifecycle.sql:14` (`UNIQUE` en `agents`) y `:55` (PK en `fleet_runtime_identities`). |
| `rooms` con clave global | PARCIAL. `rooms.id` es PK global (`001:14-15`), pero la tabla sí tiene `tenant_id` (`people-admin-authority.ts:20`). El riesgo es de colisión de ids, no de falta de dueño. |

Se descarta por no estar verificada la sospecha sobre `viewerTenant` (`registry.ts:224`). Tampoco se afirma que falten botones en la UI. Eso exige abrir el navegador, ver sección 3.

## 1. Diagnóstico (qué soporta hoy)

| Capacidad | Estado hoy | Evidencia |
|---|---|---|
| Aislamiento de mensajes y estado por espacio | SÍ, a nivel de aplicación, con claves compuestas (tenant, alias) | `001:28`, `010`, `043` |
| Ids de espacio libres (sin lista fija) | SÍ | `003:5` |
| Entidad "empresa" sobre los espacios | NO. Una empresa hoy es solo un id de tenant. | `001:8-12` |
| Varios hubs | NO | `003:18` |
| Tráfico entre espacios sin pasar por un hub | NO | `004:13-15,50-64` |
| Administrador acotado a su empresa | NO. Admin = hub = omnipotente. | `shared.ts:61-68`, `configuration.ts:78` |
| Persona en varias empresas | PARCIAL. `human_tenant_memberships` permite varias, pero la sesión toma una sola (`human-identity.ts:68-71`, `console-human-authority.ts:48-50`). | `044:39-53` |
| Recursos globales sin dueño de empresa | `fleet_hosts`, `provider_accounts` (con `payer_tenant_id`), `harness_definitions`, `role_policies`, `config_revisions`, clientes OAuth, `bot_id` de Telegram | `050`, `010`, `003`, `005`, `045` |
| Aislamiento reforzado por la base (RLS) | NO | grep vacío |
| Branding o dominio por empresa | NO. El dominio sale de variables de entorno. | `deploy/compose.mcp-human.yaml:4` |
| Defaults de "Steven" en código de producción | SÍ | `publish-operation.ts:41`, `publishing.ts:151`, `auth.ts:171`, `console-user-maintenance.ts:54`, `client-mailbox.ts:10` |
| Exportar o importar una empresa | NO | solo `backup.sh` (base entera) |

## 2. Modelo objetivo

Decisión de arquitectura: **una instalación, varias empresas** (opción A). Es lo que pidió el dueño ("unificar ya todo cauce"). La rama `codex/company-instances` propone lo contrario, una instalación por empresa. Eso no sirve para unificar y queda como alternativa descartada.

- **`companies(id, name, slug, enabled, hub_tenant_id, branding jsonb, domain, created_at, retired_at)`.** Cada espacio recibe `tenants.company_id NOT NULL`. Humanizar es la empresa 1 y se rellena con una migración aditiva.
- **Hub por empresa.** `is_hub` pasa a ser índice único por `company_id`: `UNIQUE(company_id) WHERE is_hub`. La función `cauce_assert_hub_star` compara contra el hub de la misma empresa. Una arista entre dos empresas se rechaza por defecto y solo se admite con una tabla explícita `company_links` (par de hubs, default-deny).
- **Super-administrador de plataforma.** Es un rol nuevo en una tabla `platform_admins`, separado de `is_hub`. Solo puede crear, retirar y migrar empresas, y emitir el primer administrador. Ya no es "omnipotente por ser hub".
- **Administrador de empresa.** Pasa a ser lo que hoy es hub, pero acotado a su `company_id`. En `configurationCapabilities` el scope `'hub'` se vuelve `'company'`. Las lecturas de `configuration.ts:78` filtran por `company_id`, no por "todo".
- **Tablas que pasan a ser por empresa** (añadir `company_id` o clave compuesta):
  - `rooms`: id único por empresa.
  - `provider_accounts`.
  - `fleet_hosts`: dueño o arriendo por empresa, con pool de plataforma opcional.
  - `harness_definitions`, `role_policies`, `agent_role_templates`, `agent_chain_policies`.
  - `config_revisions`.
  - `channel_bridge_*`: `bot_id` único por empresa.
  - `cauce_oauth_clients`.
  - `console_users`, con email global pero membresía por empresa.
  - `blobs`: FK a tenants y deduplicación acotada a la empresa.
  - `fleet_runtime_identities`: `runtime_key` calculada con el slug de empresa.
- **Defensa en profundidad.** RLS por `company_id` con `SET LOCAL cauce.company_id` en cada transacción, más un test de regresión que recorra cada consulta de `repository/` con dos empresas.
- **Identidad, dominio y branding.** Una sola instalación, con el dominio de la empresa guardado en `companies.domain`. Es un host virtual detrás del proxy: el origen de consola y el issuer OAuth siguen siendo uno solo. El branding (nombre, logo, color) se guarda en `companies.branding` y la consola lo lee al arrancar la sesión.
- **Quitar literales de Steven.**
  - La sonda de gate pasa a configuración (`CAUCE_GATE_TENANT`, sala y actor) o se deriva de `platform_admins`.
  - `DIRECTORES` y `steven_dm` (`praxis-supervision-notice.ts:62`) salen de membresías y de la configuración de empresa.
  - `ruteo_alias.json:10` y `AccountsInventory.tsx:26-32` leen datos, no constantes.

## 3. Editabilidad (priorizada)

Estado actual: la matriz `docs/v3.5-matriz-crud.md` dice que hay CRUD en código con E2E pendiente. Los auditores solo contrastaron la UI con el código, sin navegador.

- **P0, lo que reportó el dueño (agentes y equipos).**
  - Primero verificar con el navegador qué ve cada rol. `AgentRow.tsx:56-57` ofrece Perfil, Editar registro, Operar y Retirar, pero Eliminar solo está dentro del editor y solo si no hay runtime (`AgentRegistryEditor.tsx:162,287`).
  - `config-form-access.ts:46` oculta retire/restore si el snapshot no trae `capabilities`.
  - Un no-hub recibe `scope:'none'` en agentes (`shared.ts:61`), así que ve cero botones. Esto probablemente explica lo que describe el dueño.
  - Acción: botón Eliminar en la fila, y un motivo visible cuando una acción está bloqueada.
  - Equipos (rooms): el no-hub ya puede editar los suyos, pero `shared.ts` solo lo ofrece si `control` es verdadero. Falta mostrar el motivo cuando no lo es.
- **P1, administración de la empresa.**
  - Alta, edición y retiro de empresa (super-admin).
  - Gestión de personas por empresa. Hoy solo el hub, y `human_tenant_memberships` no tiene editor.
  - Selector de empresa en la sesión.
- **P2, recursos hoy solo del hub.**
  - Computadoras (`ComputadorasSection.tsx:25,39`).
  - Cuentas de proveedor (escritura solo hub).
  - Arneses y políticas de rol.
  - Espacios: `shared.ts:52-70`, crear/retirar/restaurar solo hub.
- **P3.**
  - DELETE de perfil (matriz:38).
  - Traslado de agente entre hosts (rechazado hoy, matriz:23, 49).
  - Inventario de cuentas desde la base.

## 4. Migración de una empresa desde otra instancia

No existe export ni import por empresa. Hay que crear:

- **Exportar:** `cauce-company export --tenants <a,b> --out <dir>`.
  - Lo ejecuta en una transacción de solo lectura.
  - El bundle lleva un `manifest.json` con `schema_version`, la versión de migración de origen, el sha256 de cada archivo NDJSON y el sha256 del manifest.
  - Contenido:
    - Estructura: tenants, rooms, memberships, agents, perfiles y sus revisiones, preferencias, aristas que tocan a esos tenants, configuración.
    - Datos: mensajes, entregas y auditoría del tenant, blobs por sha256 (copia de los bytes).
  - Se excluyen siempre: `secret_handoffs`, claves de sellado, tokens, grants OAuth, hashes de contraseña, certificados y `credential_ref` (locales al host).
- **Importar:** `import --bundle <dir> --company <slug> --dry-run|--apply`.
  - `--dry-run` produce un plan con hash. `--apply` exige que el hash coincida y que la base no haya cambiado.
  - Se registra en `import_runs(bundle_sha256 PK, plan_sha256, status, applied_at)`. Un segundo `--apply` del mismo bundle no hace nada.
  - Los agentes entran con `enabled=false` y `lifecycle_state=draft`.
  - Se escribe una fila en `config_revisions` con el hash del bundle y un evento de auditoría.
- **Colisiones y su resolución:**

| Colisión | Resolución |
|---|---|
| `rooms.id` global | Prefijo con el slug de empresa, con tabla de mapeo guardada en el bundle (o clave compuesta después de V4.1). |
| `runtime_key` global (`048:14,55`) | Recalcular con la regla de 048 bajo el tenant destino y comprobar contra `fleet_runtime_identities`. |
| Id de tenant ya existente o purgado | El dry-run consulta `purged_at` (`mutations/tenants.ts:14,26`); bloquea o remapea. |
| `provider_accounts.id` y `UNIQUE(provider, external_account_id)` | Remapear el id. Si la cuenta externa ya existe, vincular y no duplicar. |
| `role_policies.role`, `harness_definitions.id` | Prefijo por empresa, o reutilizar si el contenido es idéntico. |
| `console_users.email_normalized` | Enlazar al usuario existente y crear solo la membresía por empresa. |
| `client_id` OAuth, `bot_id` Telegram | No migrar; volver a registrar en el destino. |
| `audit_events.id` (bigserial) | Re-insertar con id nuevo y guardar el original en metadata. Los uuid de mensajes se conservan. |
| Hub | Cada empresa importada llega con su propio hub (requiere V4.1). |

- **Pasos en las máquinas de los agentes:**
  1. Parar el adaptador y el polling de Telegram en el origen para evitar dos consumidores del mismo bot.
  2. Apuntar `CAUCE_GATEWAY_URL` al destino (`bootstrap-runner.ts:101`).
  3. Emitir un leaf nuevo con la CA del destino, o configurar cross-trust, y registrar el fingerprint y el token (`issue-alias-token.py`, `register-agent-identity.py`).
  4. Volver a enlazar `credential_ref` en el host destino.
  5. Regenerar `flota.json`, `container-aliases` y la configuración de Telegram con `export-fleet-snapshot.py`.
  6. Los grants OAuth se revocan en el origen y se re-consienten. Las contraseñas se resetean.
  7. Verificar con `provider-smoke` y activar los agentes uno a uno. El rollback es volver a apuntar al origen, que no se borra hasta cerrar.

## 5. Fases de entrega

| Fase | Contenido | Verificación | Delegable / revisión |
|---|---|---|---|
| **V4.0 Cimiento** | Tabla `companies`. `tenants.company_id` rellenado con Humanizar. Los hubs pasan a ser uno por empresa y la estrella usa el hub de la misma empresa. Rol `platform_admins`. Migración aditiva y reversible. | Suite existente verde. Los datos de Humanizar quedan idénticos. Un test con 2 empresas y 2 hubs. | Esquema y triggers: revisión fuerte (Opus o codex-sol). |
| **V4.1 Aislamiento** | Claves por empresa en rooms, cuentas, hosts, políticas, `config_revisions`, bridges y OAuth. Scope `'company'` en `shared.ts`. Quitar los literales de Steven. RLS opcional. | Test cross-company por consulta de `repository/`. Pruebas negativas por endpoint. | Quitar literales y generar tests: minimax. Autorización y RLS: revisión fuerte. |
| **V4.2 Consola** | Selector de empresa, administración de empresas, personas, hosts, cuentas y arneses por empresa. Botones P0 y P1. Branding. | E2E en navegador por rol (platform, admin de empresa, operador, lector). | UI y formularios: minimax o Sonnet. La matriz de permisos la revisa Opus. |
| **V4.3 Migración** | CLI de export e import, `import_runs`, dry-run, runbook de máquinas. Ensayo con una instancia de prueba. | Exportar, importar y comparar conteos y sha256. Importar dos veces da no-op. Rollback ensayado. | Export/import y remapeo: codex-sol con revisión adversarial. Runbook y scripts de máquina: gemini. |
| **V4.4 Migración real** | Migrar la empresa de la otra instancia, en ventana acordada. | `provider-smoke`, conteos, entrega de mensajes extremo a extremo. | Ejecución a cargo del dueño; el plan lo supervisa Opus. |

Orden obligatorio: V4.0, V4.1, V4.2 y V4.3 en ese orden. V4.2 y V4.3 pueden avanzar en paralelo después de V4.1.

**Riesgos principales:**
- El aislamiento hoy es solo de aplicación, sin RLS. Hay que hacer la auditoría de consultas completa antes de alojar a otra empresa real.
- Cambiar PK de `rooms` toca muchas FKs.
- Cada trigger y cada predicado `is_hub` se debe recorrer a mano. Auditoría: `acl-edges.ts:14,26`, `agents.ts:314`, `client-mailbox.ts:62`, `publish-policy.ts:597`, `fanin.ts:44`.
- La importación depende de remapeos que hoy no existen.
- Despliegue: la base de Humanizar es producción. Toda migración debe ser aditiva, con respaldo previo (`backup.sh`) y prueba en un clon.

## 6. Decisiones tomadas por el dueño

1. **Una instalación con varias empresas**, no una instalación por empresa: unificar todo Cauce.
2. **Tráfico entre empresas prohibido** salvo un enlace explícito entre sus hubs que sólo crea el super-administrador.
3. **Un mismo dominio para todas las empresas.** Cada persona pertenece a una empresa y sólo ve lo de su empresa; no hay hosts virtuales ni marca por dominio. Sustituye la propuesta de `companies.domain` de la sección 2: la empresa se resuelve por la pertenencia de la persona, y un super-administrador puede cambiar de empresa en la sesión.
4. **La migración trae estructura e historial** (espacios, grupos, agentes, perfiles, mensajes y auditoría). Contraseñas, tokens, grants OAuth y certificados se vuelven a emitir en el destino.
5. **Super-administrador de plataforma:** sólo Steven, con identidad humana durable y rol separado del hub de Humanizar.

Archivos centrales a tocar: `packages/store/migrations/` (nueva 051+), `packages/store/src/configuration/shared.ts`, `packages/store/src/configuration.ts`, `services/gateway/src/console/people-admin-authority.ts`, `services/gateway/src/publish-operation.ts`, `packages/store/src/repository/messages/publishing.ts`.

## Estado V4.0

Implementado en el worktree `claude/v4-0-empresas`, pendiente de revisión final, integración y despliegue. Producción sigue en la migración 050: nada multiempresa está desplegado y V4.0 no añade pantallas (el selector de empresa, la administración de empresas y las personas, hosts y cuentas por empresa son V4.2).

`051_companies.sql` crea Humanizar y asigna todos los espacios existentes a `humanizar`, sin modificar sus datos previos; el `down` devuelve los datos y el esquema de 050 (funciones, triggers, índices, restricciones y columnas; sólo queda el rastro interno e inocuo de la columna borrada). Cada empresa puede tener un hub; la estrella local y los enlaces explícitos entre dos hubs se comprueban en PostgreSQL y en los predicados de rutas. Las lecturas y escrituras de configuración y la administración de personas quedan acotadas a la empresa del actor. Se conserva el contrato de capacidades `scope:'hub'` hasta V4.1. Praxis sólo existe en las pruebas; llegará con la importación posterior. El dominio continúa siendo único.

Qué cambia además en V4.0:

- **Despliegue.** 051 toma todos sus bloqueos al inicio, primero el exclusivo sobre `tenants`, con `lock_timeout` de 5 s. Si una transacción larga lo impide, la migración falla entera sin aplicar nada y sin dejar el ruteo bloqueado; basta con reintentar el despliegue. Sin competencia tarda unos 120 ms. El runtime V4 exige 051 (sus consultas de ruteo leen `company_id` y `company_links`): no se levanta sobre una base en 050.
- **Flota.** Un hub sólo opera (previsualizar, encolar, consultar, cancelar, reanudar, adoptar) espacios, grupos y agentes de su empresa. Las computadoras (`fleet_hosts`) siguen siendo un catálogo único de la instalación: sólo el hub de Humanizar las lista o modifica, y sólo agentes de Humanizar pueden colocarse en una, sea por configuración (`host_id`) o por una operación de flota `create`/`update`.
- **Cuentas de pool.** Una cuenta `shared_with_pool` sólo la usan espacios de la misma empresa que la paga, en la flota, la autenticación del proveedor, la admisión y el arranque.
- **Retiro de un enlace.** Borrar, cambiar o truncar `company_links` deshabilita (`enabled=false`) toda arista entre empresas que ya no esté cubierta; el historial se conserva. Como toda lectura y todo control por arista exige `enabled`, la otra empresa desaparece a la vez del ruteo, la terminal, el detalle de mensajes, la bandeja, el DLQ y los inventarios. Volver a habilitar una arista exige otra vez un enlace vigente. Invariante en la base: toda arista habilitada cumple la estrella por empresa.
- **Espacios sin empresa.** Un alta de espacio que omite `company_id` cae en Humanizar sólo mientras Humanizar sea la única empresa; con una segunda empresa falla. El código de configuración ya pasa la empresa explícita.

`platform_admins.human_id` referencia el UUID `console_users.id`, la misma identidad que usa la sesión y `human_tenant_memberships`. No hay un UUID de Steven inequívoco en los datos versionados: la migración deja vacíos los administradores y los enlaces. Ningún código de la aplicación escribe estas tablas ni lee `platform_admins`; `company_links` sólo se consulta para autorizar rutas. **En producción esa protección es sólo de aplicación:** el runtime y el migrador usan el mismo secreto `database_url` y el mismo rol `cauce`, que es superusuario y dueño de todas las tablas, así que el gateway podría escribirlas. Los permisos de sólo lectura de 051 sólo se aplican si existe un rol dedicado `cauce_gateway`, que hoy no existe. El dueño debe confirmar personalmente su UUID y correo y ejecutar este comando con su conexión PostgreSQL de operador; no se infiere autoridad de nombres ni alias y no se cambia ninguna contraseña:

```bash
psql --dbname=CONEXION_DEL_OPERADOR --set=ON_ERROR_STOP=1 \
  --set=steven_human_id=UUID_CONFIRMADO --set=steven_email=CORREO_CONFIRMADO <<'SQL'
BEGIN;
LOCK TABLE platform_admins IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE confirmed_platform_principal ON COMMIT DROP AS
  SELECT person.id FROM console_users person JOIN tenants tenant ON tenant.id=person.tenant_id
  WHERE person.id=:'steven_human_id'::uuid AND person.email_normalized=lower(btrim(:'steven_email'))
    AND person.active AND tenant.company_id='humanizar' FOR SHARE OF person,tenant;
DO $$
BEGIN
  IF (SELECT count(*) FROM confirmed_platform_principal)<>1 OR EXISTS (
    SELECT 1 FROM platform_admins WHERE human_id NOT IN (SELECT id FROM confirmed_platform_principal)
  ) THEN RAISE EXCEPTION 'confirm the sole platform administrator identity'; END IF;
END;
$$;
INSERT INTO platform_admins(human_id) SELECT id FROM confirmed_platform_principal ON CONFLICT DO NOTHING;
COMMIT;
SQL
```

Un enlace requiere un `created_by` presente en `platform_admins` y un par de empresas en orden canónico; no crea por sí solo una ACL ni permisos de tráfico. El `down` restaura las reglas de 004, la función DLQ de 030 y el hub único sólo si no perdería empresas, administradores ni enlaces. Una vez sembrado Steven en `platform_admins`, el `down` se niega a propósito: un rollback exige borrar antes esa fila (se puede volver a crear).

Límites: no hay RLS ni auditoría completa de cada endpoint. Los identificadores de recursos, los catálogos y el contador de revisiones siguen siendo globales: los catálogos sólo los modifica el hub de Humanizar, las revisiones visibles se filtran por empresa, pero una escritura de una empresa invalida la previsualización pendiente de otra, y un id global revela si existe en otra empresa (alta de espacio, `rooms.id`, correo de persona). `companies.enabled/retired_at` son metadatos en esta fase, no un interruptor de acceso.

Antes de alojar una segunda empresa real (requisitos, además de V4.1–V4.3, el selector de consola y ensayar la importación en un clon con respaldo):

1. Un rol de runtime de mínimo privilegio con secreto propio, sin escritura sobre `companies`, `platform_admins` ni `company_links`; o una guarda en la base que el runtime no pueda satisfacer.
2. Quitar el valor por omisión de `tenants.company_id` en una migración posterior, cuando el runtime V4 ya esté en producción.
3. Claves por empresa para los ids globales y para las computadoras (V4.1).

## Diseño V4.1 (aislamiento y propietarios)

Síntesis de tres trabajos de solo lectura sobre `df8e7a99`, que es la versión en producción:
- el inventario de consultas no acotadas por empresa;
- el diseño de aislamiento;
- el diseño de autoridad y del rol de mínimo privilegio.

**Hechos de producción** (verificados en solo lectura el 2026-10-09):
- La 051 ya está aplicada. Lo escrito en «Estado V4.0» describe el momento anterior a ese despliegue.
- Solo existe el rol `cauce`, que es superusuario y dueño de las tablas. Lo usan las 23 conexiones: runtime, controlador de flota del host y `psql`.
- `companies` = {`humanizar`}. `platform_admins` = {Steven, `78c81e05…`}.
- `tenants.company_id` conserva su default `cauce_legacy_company_id()`.
- Hay tres personas activas, las tres `operator`: `steven@elenxos.com` (Steven/kant), `zeus@elenxos.com` (Steven/zeus) y `miguel@elenxos.com` (Miguel/janus).

**Entrada nueva del dueño:**
- Humanizar es de **Steven y Miguel**.
- Praxis es de **Leon**. Hoy es otra instancia: `ssh hospital`, tenant `Hospital`, un usuario de consola, 5 agentes, esquema 043. Llega con la importación (V4.3/V4.4).

### 1. Conflictos entre los dos diseños y qué opción gana

| # | Tema | Aislamiento | Autoridad | Gana | Por qué |
|---|---|---|---|---|---|
| 1 | Tabla de propietarios | `company_admins(role owner\|admin)` | `company_owners` | `company_admins` con `role`, `source` y `granted_by` | Distingue al dueño (Steven, Miguel) del administrador delegado (zeus) sin una segunda tabla. |
| 2 | Transición desde «operador del hub = admin» | La migración rellena los admins efectivos de hoy (kant y zeus, `admin`) | «Modo arranque»: rama `legacy_hub` mientras la empresa no tenga dueños | **Relleno** | Habría una sola fuente de autoridad desde el primer despliegue: el propio argumento de autoridad («dos fuentes hacen la revocación incompleta») descarta el modo arranque. No queda rama heredada que borrar y el comportamiento no cambia. De autoridad se conserva la guarda «una empresa con dueños nunca vuelve a cero» y «una empresa nueva nace con dueño». |
| 3 | Empresa en los datos | `company_id` derivado e inmutable con FK compuestas en unas 12 tablas | Mínimo: triggers G4/G5 y `fleet_host_companies` | **FK compuestas**, más las guardas de autoridad que una FK no expresa: último dueño o SA, escritura de tablas de plataforma, alta de espacio en empresa habilitada | Una FK hace imposible el cruce, también con el superusuario actual. Un trigger solo lo detecta. |
| 4 | Computadoras | `fleet_hosts.company_id`: dueño único | `fleet_host_companies` n:m, asignada por el SA | **Dueño único** | Una máquina guarda `credential_ref` locales y contenedores de una empresa; permite la FK `agents(host_id,company_id)`. Prestar una máquina queda fuera (D5). |
| 5 | Numeración | 052 aislamiento, 053 default | 052 roles, 053 dueños, 054 default | **052 roles, 053 aislamiento, 054 propietarios y principales, 055 default** | Los roles van primero y no cambian el comportamiento. Un fichero por tema permite paquetes en paralelo. |
| 6 | Quitar el default de `tenants.company_id` | Misma ventana | Release aparte, tras una semana | **Release aparte (R2)**, antes del ensayo de importación | Praxis llega en V4.3/V4.4, así que no hay prisa, y R1 queda más pequeño. |
| 7 | Resolvedor de autoridad | `configuration/authority.ts` | `company-authority.ts` más la función DEFINER `cauce_company_authority` | **Un único `packages/store/src/company-authority.ts`** con la función DEFINER | Lo usan configuración, personas, flota y autenticación de proveedor. El `FOR SHARE` sobre tablas de plataforma sin `UPDATE` exige DEFINER. |
| 8 | Contador de revisión | `GREATEST(máx. de la empresa, máx. de plataforma)` | Por empresa | **Aislamiento** | Una escritura de catálogo global sí debe invalidar las vistas previas de todas las empresas. |
| 9 | Bloqueo | `(783003004, hashtext(empresa))` más un compartido global | `(783003052, …)` más un compartido | **Aislamiento** | Son equivalentes. Este reutiliza la clase existente y convive con el exclusivo `bigint` de V4.0. |
| 10 | `fleet_operations` | `company_id` derivado con FK a `tenants` | `acting_company` | **`company_id` derivado, con FK solo a `companies`** | Todo objetivo lleva `tenant_id` (`FleetTargetSchema`): la empresa del objetivo es la que actúa. Una FK a `tenants` impediría borrar un espacio con historial. |
| 11 | `audit_events` | Sin columna hasta V4.5 | `company_id` y `actor_human_id` nulables | **Autoridad** | Columna nulable sin default: solo metadatos, sin reescribir 42 766 filas. Hace falta para que los dueños vean las acciones del SA en su empresa. |
| 12 | Arneses y políticas de rol | Runtime con solo `SELECT`; escritura por CLI | El SA escribe por la API | **Aislamiento** | `harness_definitions.command` se ejecuta en máquinas de todas las empresas, y un runtime comprometido no debe poder cambiarlo. Son 7 filas y cambian poco (D3). `agent_chain_policies` sigue por la API con alcance `platform`. |
| 13 | El SA cambia de empresa | Solo UI en V4.2 | Claim firmado `cmp` y ruta, revalidados en cada petición | **Autoridad**: backend en V4.1, selector en V4.2 | El resolvedor ya necesita `acting_company`. |
| 14 | Mover persona o espacio entre empresas | Nunca con `UPDATE`: se exporta y se importa | `cauce_platform_move_person` | **Aislamiento** | Hoy no hace falta, y las FK lo impiden. Para corregir un error queda una escotilla de emergencia solo para `cauce_platform`. |
| 15 | Proteger columnas derivadas | Grants por columna sin `company_id` | — | **Trigger de inmutabilidad**; grant por columna solo en `tenants` | El runtime no será dueño de las tablas, así que no podrá desactivar triggers. Grants por columna en 12 tablas serían deuda con cada columna nueva. |
| 16 | RLS | No; V4.5 | No; «V4.1b» | **No en V4.1; V4.5** | Sin rol propio no tiene efecto, y el pool impide un `SET LOCAL` fiable. Se introduce ya el helper `withCompanyContext` para código nuevo. |
| 17 | Bytes de blobs por empresa | V4.1 | — | **V4.3**, con el exportador | No hay oráculo de deduplicación. Solo sirve para exportar y borrar. |
| 18 | Catálogo de `services/decisiones` por empresa | V4.1b | — | **V4.1b (WP-K)**, antes de activar agentes de Praxis | No bloquea a Humanizar. |

**Oráculos de existencia aceptados**, con error genérico: id de espacio, email, id de cuenta, `host_id`, `runtime_key` y `bot_id`. Son espacios de nombres de la instalación, y el importador remapea las colisiones.

### 2. Modelo de autoridad

**Fuentes de verdad:**
- **SA** (super-administrador de plataforma): `platform_admins`, que hoy es solo Steven.
- **DE** (dueño de empresa) y **AE** (administrador de empresa): `company_admins.role` = `owner` / `admin`.
- **OP** (operador) y **LE** (lector): como hoy. Se calculan con `console_users`, `human_tenant_memberships`, `memberships` y `role_policies`.
- **AG** (agente): mTLS o token.

**Reglas:**
- La autoridad de empresa o de plataforma sale **solo de la sesión humana verificada**. Un agente mTLS con el mismo `tenant:alias` que una persona (`Miguel/janus`, `Steven/kant`) nunca la hereda. Sin humano verificado, lo máximo es `tenant`.
- `is_hub` queda como **topología**: centro de la estrella, ruteo y visibilidad de agentes del hub. Deja de dar autoridad administrativa.
- Un DE o AE necesita, además de su fila en `company_admins`:
  - persona activa y `operator`;
  - membresía humana del espacio de origen habilitada y con `control`;
  - empresa `enabled` y no retirada.

  No se exige que su alias esté en una sala del hub. Por eso Miguel administra desde el espacio Miguel, que no es hub, sin cambiar su identidad de chat.

**Resolvedor.** `lockCompanyAuthority(client, {tenant, alias, humanId?, requestedCompany?})` se evalúa dentro de cada transacción mediante `cauce_company_authority(human, company)`, que es DEFINER y hace `FOR SHARE`. Devuelve `{humanId, homeTenant, alias, homeCompany, actingCompany, role, scope, platformOverride}`, donde:
- `role` ∈ `platform_admin | company_owner | company_admin | tenant_operator | reader | none`;
- `scope` ∈ `platform | company | tenant | outgoing_acl | none`. Sustituye a `'hub'`, y la consola acepta el contrato nuevo en el mismo release.

**Cambio de empresa del SA:**
- Va en un claim `cmp` de la cookie de sesión, y la ruta es `POST /v3/auth/session/company {company_id|null}`. Se reemite la cookie con el mismo `exp`.
- En cada petición se revalida contra la base. Si a la persona le quitan el SA, `cmp` se ignora.
- En otra empresa, el SA actúa con derechos de dueño solo en el plano administrativo (`platform_override=true`).
- Queda auditado con el `company_id` de la empresa afectada, así que sus dueños lo ven.
- Mensajería, terminal y DLQ siguen con la identidad de origen.

**Bloqueos y revisiones:**
- Un escritor de empresa toma `pg_advisory_xact_lock_shared(783003004)` y `pg_advisory_xact_lock(783003004, hashtext(empresa))`.
- Un escritor de catálogo global toma el exclusivo `783003004`.
- Contador: `GREATEST(máx. id de la empresa, máx. id de scope='platform')`.
- Un lote no mezcla alcances.
- El rollback de una revisión ajena devuelve `not_found`.
- La consola vieja recibe un único `conflict`, vuelve a pedir el snapshot y sigue.

### 3. Matriz de roles

En la tabla, «emp.» es la empresa activa: la de origen, o la elegida por el SA al cambiar de empresa. «esp.» es el espacio propio. «ACL» significa por arista habilitada y estrella, como hoy.

| Acción | SA | DE (dueño) | AE (admin) | OP | LE | AG |
|---|---|---|---|---|---|---|
| Empresas: crear, retirar, rehabilitar; enlaces entre empresas | sí (CLI) | no | no | no | no | no |
| Dueños y administradores de empresa | sí (CLI) | no; en V4.2 gestiona AE en consola | no | no | no | no |
| Alta o baja de SA | solo superusuario de base (CLI), auditado | no | no | no | no | no |
| Cambiar de empresa en la sesión | sí (auditado, con banner en V4.2) | no | no | no | no | no |
| Arneses, políticas de rol, plantillas de rol | escribir (CLI) | leer | leer | leer | leer | — |
| Política de cadena | escribir (API, `platform`) | leer | leer | leer | leer | — |
| Computadoras: alta, baja, asignación a empresa | sí | listar las suyas; editar nombre, notas y habilitado | igual que DE | no | no | no |
| Colocar un agente en una computadora | sí | solo las de su empresa (FK) | igual que DE | no | no | no |
| Personas: listar | emp. | emp. | emp. | no | no | no |
| Personas: alta, edición, retiro, purga | sí | salvo DE y SA | salvo DE, AE y SA | no | no | no |
| Propio nombre y contraseña; nadie cambia su propio rol ni estado | sí | sí | sí | sí | sí | — |
| Espacios: crear, editar, retirar, designar hub | emp. | emp. | emp. | no | no | no |
| Salas, membresías, destinos de egreso | emp. | emp. | emp. | esp. | no | no |
| Egreso sin contacto previo | sí | sí | sí | no | no | no |
| Aristas ACL (la base impone la estrella y los enlaces) | emp. | emp. | emp. | salientes de esp. | no | no |
| Registro de agentes: crear, editar, retirar, borrar | emp. | emp. | emp. | no | no | no |
| Perfil canónico y borrador | emp. | emp. | emp. | esp. | no | no |
| Cuentas de proveedor: alta, edición, borrado, compartir, pausa | emp. | emp. | no (D2) | no | no | no |
| Techo de ruteo y vínculos agente↔cuenta | emp. | emp. | emp. | no | no | no |
| Operaciones de flota | emp. | emp. | emp. | control sobre salas de esp.; lectura de esp. | lectura de esp. | no |
| Revisiones: ver / deshacer | emp. / emp. | emp. / emp. | emp. / emp. | esp. / las de esp. | esp. / no | no |
| Auditoría | emp. | emp., incluidas las acciones del SA | emp. | esp. | esp. | no |
| Observabilidad: colas, trabajos, DLQ, flota | emp. | emp. | emp. | ACL | ACL | no |
| Mensajes, terminal, administración nativa, puertas de cadena, reenvío de DLQ | ACL desde su origen; nunca en otra empresa | ACL | ACL | ACL | leer por ACL | ACL |

**Quién queda en cada rol tras R1 y la siembra (§6.1):**
- Steven es SA y DE de Humanizar.
- Miguel es DE de Humanizar.
- zeus@ es AE (relleno; decisión D1).
- El resto de agentes y personas no cambian.
- El tráfico entre empresas exige un enlace creado por el SA y aristas hub↔hub configuradas por los dueños de cada lado.

### 4. Esquema y migraciones

Las cuatro migraciones siguen el patrón de 051:
- toman al inicio `pg_advisory_xact_lock(783_003_003)` y el propio de cada una;
- fijan `lock_timeout` de 5 s;
- bloquean todas las tablas al inicio, en orden canónico;
- dan grants condicionales (`DO … IF EXISTS role`);
- tienen su `down`.

El migrador aplica todas las pendientes en **una sola transacción** (`db.ts:runMigrations`). Si un bloqueo no llega, no se aplica nada y basta con reintentar.

#### 4.1 `052_runtime_roles.sql` (sin cambio de comportamiento)

- **Roles de grupo `NOLOGIN`:** `cauce_runtime`, `cauce_observer` y `cauce_platform`.
  - La creación es tolerante a la carrera `duplicate_object`, porque los roles son del clúster y los tests lo comparten.
  - RAISE si `cauce_runtime` o `cauce_observer` tienen `super`, `bypassrls`, `createrole`, `createdb` o `replication`.
  - `GRANT cauce_platform TO CURRENT_USER`.
- **Acceso base:** `CONNECT` a la base y `USAGE` del esquema.
- **DML del runtime sobre una lista explícita** de las tablas creadas por migraciones. Nunca `ALL TABLES`, para excluir las tablas ad hoc `respaldo_*`, `zeus_*` y `deliveries_bak_*`. Excepciones:
  - **Solo `SELECT`:** `companies`, `company_links`, `platform_admins`, `schema_migration*`, `harness_definitions`, `role_policies` y `agent_role_templates`.
  - **`tenants`:** `SELECT`, `INSERT` y `DELETE`, más `UPDATE` de todas las columnas salvo `id` y `company_id`.
  - **Solo anexar** (`SELECT`, `INSERT`): `fleet_operation_events` y `fleet_runtime_identities`.
  - **`config_revisions`:** `SELECT` e `INSERT`, más `UPDATE` solo para que funcione `FOR UPDATE`. El trigger de solo-anexar llega en 053.
  - **`audit_events`:** `SELECT`, `INSERT` y `DELETE` (para la retención).
  - **`agent_chain_policies`:** `SELECT` y `UPDATE`.
  - **Funciones y secuencias:** `USAGE` y `SELECT` de las secuencias de migración; `EXECUTE` de `cauce_lock_company_link` y `cauce_lock_hub_star_tenant`.
- **Observador:** `SELECT` de lo que leen `outbox-metrics`, el watchdog y `mcp-fleet-monitor`.
- **Regla para el futuro:** toda tabla, secuencia o función nueva declara su clase de grant en su propia migración. Un test falla si queda alguna sin clasificar.
- **`down`:** revoca y borra los roles. Se niega si hay conectado algún login miembro.

#### 4.2 `053_company_isolation.sql` (expand, compatible con el runtime V4.0)

1. **Funciones.**
   - `cauce_fill_company(col_tenant)` y `cauce_fill_company_from_human()`: rellenan si viene NULL.
   - `cauce_company_immutable()`: devuelve 23514. Hay una escotilla solo para miembros de `cauce_platform` con `SET LOCAL cauce.company_move='on'`.
   - `cauce_assert_company_reachable(a,b)` y `cauce_pair_company_guard()`: mismo espacio o misma empresa; si no, exigen un enlace bloqueado con `cauce_lock_company_link`.
2. **`tenants`.**
   - `UNIQUE(id,company_id)`.
   - Trigger de inmutabilidad de `company_id`.
   - Trigger de alta: la empresa debe estar habilitada y no retirada.
3. **Columnas derivadas `company_id`.**
   - Tablas: `rooms`, `console_users`, `agents`, `provider_accounts` (desde el pagador), `alias_routing_ceiling`, `agent_account_bindings`, `quota_window_state` (desde el colector) y `console_agent_favorites`. `human_tenant_memberships` se rellena desde la persona.
   - Pasos: relleno, `NOT NULL`, FK `(col_tenant, company_id) → tenants(id, company_id)` y triggers de relleno e inmutabilidad.
   - **El relleno desactiva por nombre solo** `cauce_oauth_membership_revision`, `human_membership_preserved`, `agents_role_brief_journal`, `agent_runtime_key_reservation` y `fleet_operations_history`, y los reactiva por nombre. Así no se avanza la revisión OAuth, no se escribe el diario y no cambia el `tgenabled` que vigila la huella de 024.
4. **Unicidades y FK compuestas.**
   - `console_users UNIQUE(id,company_id)` y `provider_accounts UNIQUE(id,company_id)`.
   - Hacia `provider_accounts(id,company_id)`: `agents(primary_account_id,…)`, `alias_routing_ceiling(account_id,…)`, `agent_account_bindings(account_id,…)` y `quota_window_state(account_id,…)`.
   - `human_tenant_memberships`: `(human_id,…) → console_users` y `(tenant_id,…) → tenants`. Una persona, una empresa.
   - `console_agent_favorites(human_id,…) → console_users`.
5. **`rooms`.**
   - PK `(tenant_id,id)` y `UNIQUE(company_id,id)`.
   - `messages(room_id,tenant_id) → rooms(id,tenant_id)`, primero `NOT VALID` y luego `VALIDATE` (21 821 filas).
   - Se borran `messages_room_id_fkey` y `memberships_room_id_fkey`; la compuesta ya existe.
   - No toca la estructura de `agent_role_templates` ni lo vigilado por `migration-integrity.ts`.
6. **`fleet_hosts.company_id`, dueño único.**
   - Se rellena con la empresa única de sus agentes. RAISE si hay mezcla. Un host sin agentes recibe empresa solo si hay una única empresa.
   - `NOT NULL`, `UNIQUE(host_id,company_id)` e inmutable.
   - FK `agents(host_id,company_id) → fleet_hosts`.
   - Sin default. Un trigger de relleno solo actúa si existe una única empresa, con la misma semántica que el default heredado de 051. Con dos o más empresas exige `company_id` explícito.
7. **`fleet_operations.company_id`.** `NOT NULL`, con FK a `companies`, relleno desde `target->>'tenant_id'`, inmutable e índice `(company_id, created_at)`.
8. **`config_revisions`.**
   - Columnas nuevas: `scope ('company'|'platform')`, `company_id` (FK a `companies`), `actor_human_id` y `platform_override`.
   - Relleno de las 165 filas, el `CHECK` de alcance e índices `(company_id,id DESC)` y parcial de plataforma.
   - Trigger `BEFORE INSERT`: rellena desde `actor_tenant`, lo que lo hace compatible con V4.0. Si el actor es de otra empresa, exige `platform_override` y un `actor_human_id` presente en `platform_admins`.
   - Trigger de solo-anexar.
9. **`audit_events`.** `company_id` y `actor_human_id`, nulables y sin relleno.
10. **Guardas de pares** en `secret_handoffs`, `blob_delivery_grants`, `agent_output_materializations` y `agent_failure_notices`.
11. **Trigger de cuota:** la empresa de la cuenta debe ser la del colector, en `quota_window_samples` (107 k filas, sin columna) y `quota_collections`.
12. **Comprobación final:** un bloque `DO` verifica que no hay violaciones. Hoy son 0, porque hay una sola empresa.

#### 4.3 `054_company_admins.sql`

- **Tabla `company_admins`:**
  ```sql
  CREATE TABLE company_admins (
    company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    human_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','admin')),
    source text NOT NULL CHECK (source IN ('v4.0-hub-operator','platform','import')),
    granted_by uuid REFERENCES console_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id,human_id),
    FOREIGN KEY (human_id,company_id) REFERENCES console_users(id,company_id) ON DELETE RESTRICT,
    CHECK (source='v4.0-hub-operator' OR granted_by IS NOT NULL));
  ```
- **Guardas:**
  - **G1:** escribir `companies`, `company_links`, `platform_admins` o `company_admins` exige ser miembro de `cauce_platform`. Si no, 42501. Es defensa en profundidad, además del REVOKE.
  - **G3:** `CONSTRAINT TRIGGER` diferido. Una empresa que tuvo al menos un dueño activo no puede terminar una transacción sin ninguno. Una empresa nueva debe tener dueño al hacer `COMMIT`.
  - **G4:** en `console_users`, desactivar, cambiar de rol o retirar al último dueño activo de una empresa, o al último SA activo, devuelve 23514. Bloquea con el helper DEFINER `cauce_lock_owner_guard`.
- **`platform_authority_events`:** historial del plano de plataforma, solo de anexar.
- **DEFINER `cauce_company_authority(human, company)`:** devuelve `home_company`, `platform_admin`, `company_role` y `company_enabled` con `FOR SHARE`.
  - Lleva `search_path` fijo, nombres calificados y ningún SQL dinámico.
  - Tiene `REVOKE ALL FROM PUBLIC` y `EXECUTE` solo para `cauce_runtime`.
- **Funciones de plataforma** (INVOKER, `EXECUTE` solo para `cauce_platform`):
  - `cauce_platform_create_company`, `cauce_platform_set_company_state`, `cauce_platform_link` y `cauce_platform_unlink`.
  - `cauce_platform_grant_admin(company, human, email, role, admin)`:
    - verifica que `admin` está en `platform_admins`;
    - bloquea la empresa;
    - exige el id **y** el email exactos, persona activa, `operator` y de esa empresa;
    - hace upsert del rol;
    - escribe en `platform_authority_events` y en `audit_events`.
  - `cauce_platform_revoke_admin`, que respeta G3.
- **Relleno de `company_admins`:**
  - Usa el predicado efectivo de hoy (`people-admin-authority.ts`) con `role='admin'` y `source='v4.0-hub-operator'`.
  - En producción da kant (`78c81e05`) y zeus (`6cef3d50`), así que nadie pierde acceso.
  - No hay dueños hasta la siembra.
- **Tablas para los literales:**
  - `company_system_principals(company_id, kind, tenant, room, actor, principal_alias, recipient_alias, notify_handle)`, con FK a `tenants(id,company_id)`, `rooms` y `agents`.
  - `company_agent_roles(company_id, role, tenant_id, alias)`, con único parcial por `(company_id, role)` para `infra_escalation` y `coordination`.
  - `agent_role_template_owners(slug, company_id)`: tabla lateral, más el trigger `agents_role_template_company_guard`.
- **Siembra condicional de Humanizar:**
  - `gate_probe` = Steven / grp.steven / gate-probe / kant.
  - `director` = Steven/argos.
  - `infra_escalation` = Steven/zeus.
  - `coordination` = Steven/kant.
- **Grants:** el runtime tiene `SELECT` sobre todo lo anterior y `EXECUTE` de la función DEFINER. No escribe en ninguna de estas tablas.

#### 4.4 `055_drop_legacy_company_default.sql` (R2)

`ALTER TABLE tenants ALTER COLUMN company_id DROP DEFAULT; DROP FUNCTION cauce_legacy_company_id();`

Antes hay que corregir los fixtures que insertan espacios sin `company_id`:
- `tests/e2e/console-functional-browser.fixtures.ts`;
- `tests/store-hardening/*`;
- `tests/gateway-hardening/context-write-quiescence.fixtures.ts`.

`ops/instances/hospital/bootstrap.sql` también lo omite. Que falle es correcto, porque nunca se ejecuta contra esta instalación.

#### 4.5 Migraciones `down` (solo en desarrollo o en un clon; en producción se corrige hacia delante)

- **`down/055`:** recrea la función y el default.
- **`down/054`:** se niega si hay algún `owner`, alguna fila con `source<>'v4.0-hub-operator'` o más de una empresa.
- **`down/053`:** se niega si:
  - hay más de una empresa;
  - hay ids de sala repetidos entre espacios;
  - hay migraciones posteriores aplicadas.

  Deshace en orden inverso y restaura la PK `rooms(id)` y las dos FK.
- **`down/052`:** está descrito en §4.1.

#### 4.6 Orden de despliegue

1. **R1 = 052 + 053 + 054** más el código de WP-A a WP-I.
   - **Requisitos previos:**
     - el gate local, en un venv con shellcheck, ruff, jsonschema y pyyaml;
     - la suite con el rol de runtime (WP-B);
     - el ensayo en clon (§4.7) en verde;
     - `backup.sh` con copia offsite (kratos y gdrive).
   - `deploy.sh` con `CAUCE_DEPLOY_FLEET_OVERLAY=1`, coordinado con la sesión par de consola.
   - **Verificación:**
     - `/health/ready`, que incluye los objetos de 052–054;
     - `company_admins` = {kant, zeus} como `admin`;
     - `smoke.sh`.
2. **Siembra de dueños** (§6.1), justo después de R1.
3. **Cambio de rol de base de datos** (§5), en otra ventana distinta de R1, para no mezclar causas de fallo.
4. **Adaptadores con `company_context_v1`**, desplegados de forma gradual después del gateway.
   - Si el adaptador no negocia la capacidad, el gateway no envía `company_context`.
   - Los adaptadores viejos conservan sus literales, que son correctos para Humanizar.
5. **R2 = 055 + WP-J**, tras al menos una semana estable y antes del ensayo de importación de V4.3.

**Rollback del runtime.** Se restauran los pins de imagen **sin** el migrador: el `migrate.mjs` viejo se niega ante una base más nueva. El runtime V4.0 funciona sobre el esquema 054, con dos excepciones aceptadas:
- no puede dar de alta una computadora una vez exista una segunda empresa, porque entonces el relleno de `fleet_hosts.company_id` exige un valor explícito;
- las escrituras de contexto que estuvieran pendientes fallan cerradas con `conflict`, por el digest de `agents`.

#### 4.7 Ensayo obligatorio en un clon de producción (kratos)

1. Tomar un `pg_dump -Fc` reciente de producción (una lectura) o el último respaldo offsite. Restaurarlo en un PostgreSQL 16.14 desechable, con la misma imagen que producción y sin exponer puertos.
2. Ejecutar el migrador de la imagen R1:
   - medir la duración y los bloqueos (objetivo: menos de 2 s con `ACCESS EXCLUSIVE` sobre `messages`);
   - repetirlo con carga sintética de publicación para probar la ruta de `lock_timeout`.
3. Correr el script de aserciones de WP-A:
   - las tablas previas quedan idénticas salvo las columnas nuevas;
   - `human_tenant_memberships.revision`, `agent_role_brief_history`, `fleet_runtime_identities` y `updated_at` no cambian;
   - la huella de 024 pasa;
   - `company_admins` = {kant, zeus};
   - 0 violaciones.
4. Crear los logins en el clon con `provision-db-roles.py --target clon`. Levantar gateway, dispatcher y bridge con ellos y ejecutar `smoke.sh`: 0 errores 42501 en los logs.
5. Sembrar los dueños en el clon y comprobar la sesión de Miguel (`company_owner`).
6. En una copia previa a la siembra, `down/054` → `down/052` debe funcionar. Después de la siembra debe negarse.
7. Destruir el clon y el volcado, porque contienen datos de producción.

### 5. Rol de runtime de mínimo privilegio

| Login | Grupo | Consumidor | Límite de conexiones |
|---|---|---|---|
| `cauce_gateway` | `cauce_runtime` | gateway (con overlay de flota) | 30 |
| `cauce_dispatcher` | `cauce_runtime` | dispatcher | 15 |
| `cauce_bridge` | `cauce_runtime` | telegram-bridge | 8 |
| `cauce_fleet` | `cauce_runtime` | `cauce-fleet-v35-controller` (host) | 10 |
| `cauce_observer_login` | `cauce_observer` | outbox-metrics, fleet-watchdog | 5 |
| `cauce_monitor` | `cauce_observer` | `mcp-fleet-monitor` | 3 |
| `cauce_backup` | `pg_read_all_data` | respaldo por TCP | 2 |
| `cauce` (superusuario) | `cauce_platform` | migrador, `cauce-plataforma`, emergencias | — |

**Qué se le niega al runtime:**
- ser dueño de tablas, DDL, `DISABLE TRIGGER` y `TRUNCATE`;
- escribir en las tablas de plataforma;
- hacer `UPDATE` de `tenants.company_id`;
- acceder a las tablas ad hoc;
- los atributos `super`, `bypassrls`, `createrole` y `replication`.

**Riesgo aceptado:** un runtime comprometido sigue leyendo y escribiendo datos de todas las empresas. La respuesta es RLS en V4.5.

**Provisión** (sin ventana de mantenimiento, después de R1 y del ensayo):

1. **Inventariar los consumidores de la base:**
   - en compose: migrator, gateway, dispatcher, outbox-metrics y telegram-bridge;
   - en el host: el controlador de flota (`/etc/cauce-v3/fleet-v35/controller/database-url`) y `fleet-watchdog.env`;
   - sin verificar: `host-backup`, `quota-collector`, `cauce-huerfanas`, `cauce-panel` y `mcp-fleet-monitor`. Hay que clasificarlos antes del paso 7.
2. **Ejecutar como root `ops/scripts/provision-db-roles.py --env /etc/cauce-v3/prod.env --apply`.** Para cada login:
   - genera 32 bytes aleatorios y calcula **localmente** el verificador SCRAM-SHA-256. A la base solo viaja el verificador, por stdin a `docker exec … psql -U cauce`: `CREATE ROLE … LOGIN IN ROLE <grupo> CONNECTION LIMIT n` y `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$4096:…'`;
   - escribe la URL a partir de la existente. Solo cambian usuario y contraseña; se conservan host, `sslmode` y CA. La copia es atómica, con modo 0400 y el mismo dueño. Nunca se imprime;
   - copia `prod.env` a `prod.env.pre-roles-<stamp>` y añade `CAUCE_DATABASE_URL_{GATEWAY,DISPATCHER,BRIDGE,OBSERVER}_SECRET_PATH`;
   - verifica cada URL con un contenedor efímero de la imagen runtime: `current_user` correcto, `rolsuper=false`, `has_table_privilege(current_user,'platform_admins','INSERT')=false` y que la lectura de `tenants` funciona.
3. **Compose.** En `deploy/compose.yaml`, cada servicio monta **su** secreto con `target: database_url`, así que el código no cambia. El migrador conserva `database_url` (`cauce`). Si faltan las variables, `deploy.sh` usa el secreto anterior y avisa de «runtime con superusuario».
4. **Conmutar servicio a servicio** con `docker compose … up -d --no-deps --wait <svc>`, en este orden: outbox-metrics → telegram-bridge → dispatcher → gateway. El gateway va con el mismo conjunto de ficheros compose que usa `deploy.sh` con el overlay de flota. Tras cada servicio:
   - `/health/ready`;
   - `docker logs --since 10m <svc> | grep -c 42501` = 0;
   - `pg_stat_activity` agrupado por `usename` y `application_name`.
5. **Host:**
   - el controlador pasa a `cauce_fleet`: `systemctl restart cauce-fleet-v35-controller`;
   - el watchdog, al login de observador;
   - `mcp-fleet-monitor`, a `cauce_monitor`;
   - el respaldo, a `cauce_backup`.
6. **Comprobación final.** Solo el migrador, el `psql` del operador y la CLI de plataforma usan `cauce`. Se añade una alerta si aparece `usename='cauce'` con un `application_name` de runtime, y desde ese momento `smoke.sh` falla en ese caso.
7. **Rotar la contraseña de `cauce`**, porque estuvo montada en todos los contenedores. Se actualizan a la vez `database_url` y `postgres_password` (el healthcheck lee el fichero) y se revisan los consumidores del host.
8. **Endurecimiento opcional:** `REVOKE TEMPORARY ON DATABASE cauce FROM PUBLIC` y limitar `cauce` en `pg_hba`.

**Rollback:**
- Por servicio: `cp prod.env.pre-roles-<stamp> prod.env` y `up -d --no-deps <svc>`.
- En el host: volver a la URL anterior.
- No cambia ningún dato; los roles quedan inertes.
- Si una guarda da un falso positivo, se corrige hacia delante con una migración.

### 6. Pasos manuales

#### 6.1 Miguel y Steven como dueños de Humanizar (justo después de R1)

Hoy no es posible: no existe `company_admins`, y meter a Miguel en el hub cambiaría su identidad de chat, porque la sesión toma un solo espacio. Steven confirma personalmente los UUID y los correos, y ejecuta con su conexión de operador **en una sola transacción**:

```bash
ssh root@167.114.118.213
docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -X -v ON_ERROR_STOP=1 \
  --set=admin=78c81e05-0c18-427b-b02b-346d7e8c8508 <<'SQL'
BEGIN;
SELECT cauce_platform_grant_admin('humanizar','78c81e05-0c18-427b-b02b-346d7e8c8508','steven@elenxos.com','owner',:'admin');
SELECT cauce_platform_grant_admin('humanizar','836839cc-4768-4214-9170-d535f12a66cd','miguel@elenxos.com','owner',:'admin');
SELECT company_id, human_id, role, source FROM company_admins ORDER BY role, human_id;
COMMIT;
SQL
```

(Cuando exista WP-I: `cauce-plataforma admin otorgar --empresa humanizar --rol owner --id … --email …`.)

**Verificación:**
- Miguel cierra sesión y vuelve a entrar. `GET /v3/auth/session` muestra `role=company_owner` y `scope=company`.
- Miguel puede:
  - listar personas y ver y aplicar configuración de toda Humanizar;
  - registrar agentes y colocarlos en computadoras de Humanizar;
  - gestionar las cuentas de proveedor (D2).
- Miguel **no** puede escribir arneses, dar de alta computadoras, crear empresas o enlaces ni otorgar dueños.
- Su agente `Miguel/janus` (mTLS) no gana nada.
- Su arista `Miguel→Steven` con `allow_control` no cambia. Es control operativo por ACL, independiente de ser dueño.

**Después:**
- Decidir D1: si zeus@ sigue como `admin`.
- Reversión: `cauce_platform_revoke_admin('humanizar','836839cc-…',:'admin')`. G3 impide quitar al último dueño.

#### 6.2 Leon como dueño de Praxis (en la importación, V4.3 dry-run y V4.4 apply)

1. **Fuera de banda.** Leon da a Steven su email. Steven confirma en solo lectura en `ssh hospital` que es el único usuario de consola del espacio `Hospital`, con rol `operator` y permiso `control`.
2. **Validaciones del `--dry-run`:**
   - el email no existe en `console_users`, porque la unicidad es global («una persona, una empresa»). Si existe, se detiene y decide el dueño;
   - no colisionan `Hospital`, `grp.hospital`, alias y `runtime_key`, ids de cuenta, `external_account_id` ni `host_id`;
   - el importador **no** ejecuta `ops/instances/hospital/*.sql` ni escribe `role_policies`, arneses o plantillas: los reutiliza si son idénticos y si no, bloquea. Las plantillas `hospital-*` entran con dueño `praxis` en `agent_role_template_owners`, o se convierten en perfiles.
3. **Antes del apply.** El SA registra las computadoras de Praxis con `company_id='praxis'`.
4. **`--apply`**, una sola transacción como `cauce`:
   - `cauce_platform_create_company('praxis','Praxis',:'admin')`;
   - la importación, con agentes en `draft` y `enabled=false`, Leon en `console_users` con hash aleatorio no entregado y su membresía `operator` con `control` en `Hospital`;
   - `cauce_platform_grant_admin('praxis', :'leon_id', :'leon_email', 'owner', :'admin')`. Sin este paso, G3 aborta el `COMMIT`.
5. **Principales y roles de Praxis**, en la misma transacción:
   - `director`, `infra_escalation`, `coordination` y `human_receipt` = `Hospital/operador`;
   - `supervision_notice` con `notify_handle` hacia un destino de egreso **de Praxis** (el de Leon), no `steven_dm` (D4).
6. **Contraseña.** Se restablece la de Leon con `cauce-plataforma persona contraseña --empresa praxis --email …` y se entrega fuera de banda. Leon entra, ve solo Praxis y su rol es `company_owner`.
7. **Agentes.** Leon activa los agentes uno a uno tras los pasos de máquina de §4: certificado nuevo, `credential_ref` y `provider-smoke`.
8. **Supervisión desde Humanizar** (solo si se quiere). El SA crea `company_links(humanizar, praxis)` y cada dueño configura la arista hub↔hub de su lado. Steven actúa en Praxis solo mediante el cambio de empresa, que queda auditado y Leon lo ve.

### 7. Paquetes de trabajo

**Reglas:**
- Un worktree por paquete. Los ficheros listados son **exclusivos** de su paquete.
- Los ficheros compartidos se **secuencian**:
  - `packages/store/src/index.ts`: C → H → J;
  - `configuration/company-scope.ts`: D → J;
  - `tests/unit/no-company-literals.test.ts`: H → J;
  - este documento: J.
- Cada paquete pasa el gate completo y la suite con el rol de runtime antes de integrarse. A, B, C, D y E llevan revisión adversarial de Opus.
- A y B se integran antes de que empiece la ola 3. Por eso pueden ajustar tests existentes que su esquema o su pool rompan sin solaparse con D–I: a partir de ahí, esos tests son de su paquete dueño.
- **Olas de trabajo:**
  1. A ‖ B.
  2. C. Empieza cuando A congela las firmas de 054, hacia el día 2 o 3 de A.
  3. D ‖ E ‖ F ‖ G ‖ H ‖ I.
  4. Ensayo y R1.
  5. J (R2).
  6. K antes de V4.4.

**WP-A · Esquema de aislamiento y propietarios**
- **Modelo y dependencias:** codex-sol (effort xhigh), con revisión de Opus. No depende de nada. Ejecuta el test de clasificación de B.
- **Ficheros:**
  - `packages/store/migrations/053_company_isolation.sql` y `054_company_admins.sql`, más sus `down/`;
  - `packages/store/src/repository/agent-context-quarantine.ts` (digest sobre `to_jsonb(agent)-'company_id'`);
  - `services/gateway/src/health/schema-companies.ts` (nuevo) y `services/gateway/src/health/probe.ts`;
  - `packages/store/test/companies-postgres.fixtures.ts` y `companies-migration-postgres.test.ts`;
  - nuevos: `packages/store/test/companies-isolation-db-postgres.test.ts`, `companies-isolation-migration-postgres.test.ts` y `companies-admins-db-postgres.test.ts`;
  - `ops/scripts/rehearse-v41-clone.sh` (nuevo).
- **Fixtures:**
  - humanizar: Steven como hub, Miguel no-hub, Isa;
  - praxis: PraxisHub, PraxisTeam y `leon@example.test` como dueño;
  - un host y una cuenta por empresa;
  - el **mismo** nombre de contenedor y de host de cuota en ambas.
- **Tests:**
  - cada FK y cada guarda rechazan el cruce con 23503, 23514 o 42501: cuenta, techo, vínculo o `primary_account` ajenos; agente en host ajeno; membresía, favorito o admin de otra empresa; `UPDATE … company_id`; pares sin enlace (aceptados con enlace hub↔hub); muestra de cuota con cuenta ajena;
  - el mismo id de sala en dos empresas es válido; en la misma empresa, no;
  - el último dueño y el último SA están protegidos;
  - migración desde una base 051 con forma de producción: snapshot igual, `revision` OAuth intacta, huella de 024, ida y vuelta por los `down` y sus negativas.
- **Aceptación:**
  - suite verde y ensayo en clon verde;
  - en producción, el relleno de `company_admins` da exactamente kant y zeus;
  - el runtime V4.0 arranca sobre 054 (test de compatibilidad).

**WP-B · Rol de runtime y provisión**
- **Modelo y dependencias:** codex-sol (effort high) para la migración y el script; Opus revisa los grants. No depende de nada y se integra antes que A.
- **Ficheros:**
  - `packages/store/migrations/052_runtime_roles.sql` y su `down/`;
  - `packages/store/test/runtime-grants-postgres.test.ts` (nuevo);
  - `packages/store/test/postgres-suite.ts` y `tests/helpers/postgres.ts`: pool doble, uno de administración para los fixtures y otro de runtime para el código, con `CAUCE_TEST_RUNTIME_ROLE`;
  - `package.json` (script `test:runtime-role`);
  - `ops/scripts/provision-db-roles.py` y `ops/tests/provision-db-roles.test.*` (nuevos);
  - `deploy/compose.yaml`, `deploy/compose.fleet.yaml`, `deploy/deploy.sh` y `deploy/smoke.sh`;
  - `docs/runbook-rol-runtime.md` (nuevo).
- **Tests:**
  - toda tabla, secuencia o función de migración está clasificada;
  - como `cauce_gateway`: no escribe en tablas de plataforma, no cambia `tenants.company_id`, no hace DDL ni `DISABLE TRIGGER`, y los caminos con `FOR SHARE` o `LOCK TABLE` (`fleet-adoption-snapshot.ts`, `terminal/session-authority.ts`) funcionan;
  - las suites de integración del gateway y del dispatcher pasan con el pool de runtime;
  - el script, en seco: nunca imprime secretos y escribe ficheros 0400 de forma atómica.
- **Aceptación:**
  - 052 no cambia el comportamiento con el runtime como `cauce`;
  - la conmutación en el clon da 0 errores 42501;
  - el runbook describe la conmutación y el rollback por servicio.

**WP-C · Núcleo de autoridad y sesión**
- **Modelo y dependencias:** codex-sol (effort xhigh), con revisión de Opus. Depende de A (firmas de 054).
- **Ficheros:**
  - `packages/store/src/company-authority.ts` (nuevo): resolvedor, `companyScopeSql`, `assertPlatformAdmin`, `lockCompanyConfiguration`, `lockPlatformConfiguration`, `companyRevision` y `withCompanyContext`;
  - `packages/store/src/human-identity.ts` y `packages/store/src/index.ts`;
  - gateway: `auth.ts` (`Principal.human_id` y `acting_company`; `CAUCE_DEV_OPERATOR` sustituye a `Steven/kant` en `:171`), `console-user-authority.ts`, `console-human-authority.ts`, `password-auth.ts` (claim `cmp`, `switchCompany`, bloque `authority`), `oidc-bff.ts` (solo empresa de origen), `console-security.ts`, `app.ts` y `routes/console/companies.ts` (nuevo: `GET /v3/console/companies` y `/v3/console/platform/events`);
  - consola: `console/src/api/types/auth.ts`, `features/auth/auth-session.ts` y `features/auth/account-identity.ts`;
  - tests nuevos: `packages/store/test/companies-authority-postgres.test.ts` y `services/gateway/src/password-auth-company.test.ts`.
- **Tests:**
  - matriz de actores: Steven, Miguel, zeus, Isa, Leon, operador de PraxisTeam y agente `Miguel/janus`;
  - `cmp` se ignora sin SA y se ignora tras revocarlo;
  - la cookie no extiende `exp`;
  - CSRF en la ruta nueva.
- **Aceptación:**
  - un único punto decide el rol;
  - ningún agente mTLS obtiene `company` ni `platform`;
  - la sesión expone `authority`.

**WP-D · Configuración por empresa**
- **Modelo y dependencias:** codex-sol (effort high) para el store. La consola, Sonnet o minimax. Depende de C.
- **Ficheros:**
  - store: `packages/store/src/configuration.ts`, `configuration/shared.ts`, `configuration/contracts.ts`, `configuration/company-scope.ts`, `configuration/mutations.ts`, `configuration/mutations/tenants.ts` y `repository/config.ts`;
  - gateway: `services/gateway/src/routes/console/operations.ts`;
  - consola: `console/src/api/types/config.ts` y, en `console/src/features/config/`, `config-form-access.ts`, `config-form-model.ts`, `ComputadorasSection.tsx` y `mutation-editor.ts`;
  - `console/src/features/accounts/registry.ts`;
  - tests de esos ficheros de consola;
  - tests de store: `packages/store/test/companies-configuration-postgres.test.ts` y `companies-revisions-postgres.test.ts` (nuevo).
- **Tests:**
  - capacidades por rol;
  - catálogos solo `platform`, y arneses y políticas de rol sin acciones (D3);
  - dos transacciones de empresas distintas no se bloquean (aserción sobre `pg_locks`);
  - una escritura de catálogo invalida a ambas;
  - el rollback de una revisión ajena da `not_found`;
  - se corrige `configuration.ts:101` (sala sin tenant);
  - `controlState` cuenta dueños activos.
- **Aceptación:**
  - el contrato `'hub'` desaparece y la consola acepta `company` y `platform`;
  - `LEGACY_COMPANY` se marca obsoleto, pero sigue exportado hasta J.

**WP-E · Flota, computadoras, cuentas y autenticación de proveedor**
- **Modelo y dependencias:** codex-sol (effort high). Depende de C.
- **Ficheros:**
  - store, en `packages/store/src/repository/`: `fleet-operation-authority.ts`, `fleet-operations.ts`, `fleet-hosts.ts`, `fleet-operation-lifecycle.ts`, `fleet-operation-human.ts` y `agent-profile-draft.ts`;
  - store, en `packages/store/src/`: `fleet-adoption-snapshot.ts` y `accounts.ts` (`CANDIDATES_SQL` exige la misma empresa en cuenta y vínculo);
  - gateway, en `services/gateway/src/fleet/`: `adoption-drain.ts`, `bootstrap-repository.ts`, `auth-router.ts` y `host-provider-auth.ts`;
  - gateway, en `services/gateway/src/console/`: `fleet-hosts.routes.ts`, `fleet-operations.routes.ts`, `provider-auth-binding.ts` y `agent-profile-draft.ts`;
  - los tests colocados junto a esos ficheros;
  - `packages/store/test/companies-fleet-postgres.test.ts`.
- **Tests:**
  - el DE coloca un agente solo en hosts de su empresa;
  - alta y baja de host solo SA;
  - `listRecent` y los reclamos por empresa;
  - la búsqueda por sesión de autenticación lleva predicado de empresa;
  - `fleet-operation-lifecycle.ts:129` lleva predicado de tenant;
  - si se revoca a un dueño, la operación encolada pierde la autoridad;
  - el bootstrap ya no usa `is_hub`.
- **Aceptación:**
  - no queda ningún uso de `LEGACY_COMPANY` en estos ficheros;
  - Praxis puede crear y actualizar agentes en sus propios hosts.

**WP-F · Administración de personas**
- **Modelo y dependencias:** codex-sol (effort medium) o minimax, con revisión de Opus. Depende de C.
- **Ficheros:**
  - en `services/gateway/src/console/`: `people-admin-authority.ts` y `people-admin-store.ts`;
  - en `services/gateway/src/`: `console-user-maintenance.ts` y `console-user-cli.ts` (tenant y alias obligatorios, sin default `Steven/kant`);
  - sus tests colocados;
  - `packages/store/test/companies-people-admin-postgres.test.ts`.
- **Tests:**
  - el DE administra personas sin estar en el hub;
  - el AE no toca a DE ni a otros AE;
  - nadie cambia su propio rol;
  - 42501 se traduce a `forbidden` y 23514 a `conflict`;
  - la CLI no mueve personas entre empresas;
  - purgar a un admin da `conflict`.
- **Aceptación:**
  - `effectivePeopleAdministrators` ya no lee `is_hub`;
  - Miguel administra personas tras la siembra.

**WP-G · Lecturas defensivas y fugas**
- **Modelo y dependencias:** codex-sol (effort high). Depende de A.
- **Ficheros:**
  - en `packages/store/src/repository/`: `quotas.ts` (`collector_tenant = ANY(...)`, `tenantReadableSql` y `p.company_id`), `observability.ts`, `outbox/operator.ts`, `agents.ts` y `agents/fanin.ts` (falla cerrado si no hay empresa);
  - en `packages/store/src/`: `agent-preferences.ts`, `fleet-activity.ts` y `client-mailbox.ts` (sin default);
  - `services/gateway/src/terminal/authority.ts`: cohorte por `(empresa, host_id, contenedor)` y `routingAuthority` con `hubStarRouteSql`;
  - `packages/mcp-fleet-monitor/src/server.ts`: no enumera tenants;
  - tests nuevos: `packages/store/test/companies-read-isolation-postgres.test.ts`, `services/gateway/src/terminal/authority-companies.test.ts` y `tests/unit/sql-company-lint.test.ts` (join a `rooms` por id sin tenant).
- **Tests:** canario con dos empresas, el mismo host de cuota y el mismo contenedor. Cada lectura devuelve 0 filas de la otra: cuotas, favoritos, `readAgents`, `listAdapters`, `queueSnapshot`, `listOriginRelays`, actividad, fan-in, terminal y el monitor.
- **Aceptación:** el canario y el lint en verde.

**WP-H · Literales a datos y `company_context`**
- **Modelo y dependencias:**
  - el protocolo y el envío: codex-sol (effort high);
  - los literales del adaptador y los scripts: minimax, con revisión de codex.

  Depende de A. Integra su línea de `index.ts` después de C.
- **Ficheros:**
  - store: `packages/store/src/company-context.ts` (nuevo, con caché de 60 s), `repository/messages/publishing.ts`, `repository/deliveries/claims.ts` y `seed-dev-cli.ts` (dos empresas, admins y principales); su línea en `index.ts`;
  - gateway: `services/gateway/src/publish-operation.ts`;
  - protocolo: `packages/protocol/src/schemas/realtime.ts` (`company_context` opcional y capacidad `company_context_v1`);
  - adaptador, en `packages/adapter-sdk/src/`: `harnesses/shared/prompt.ts`, `sdk/engine.ts`, `sdk/engine/praxis-supervision-notice.ts`, `sdk/engine/system-gate-probe.ts`, `bin/shared.ts` y el fichero donde el adaptador anuncia capacidades;
  - ops: `ops/scripts/gate-collector.mjs`, `provision-gate-identity.py` y `gate-roundtrip-probe.mjs` (`CAUCE_GATE_TENANT/ROOM/ACTOR`, sin default);
  - `tests/unit/no-company-literals.test.ts` (nuevo, con una lista temporal de excepciones de ficheros de otros paquetes).
- **Tests:**
  - la sonda de gate de Humanizar se comporta igual que hoy;
  - el prompt de Humanizar (argos, zeus, kant) y el de Praxis (operador) se reproducen exactamente desde datos;
  - sin la capacidad, el sobre no lleva `company_context` y sigue siendo `.strict()`.
- **Aceptación:** el lint de literales pasa con solo las excepciones declaradas.

**WP-I · Operación de plataforma**
- **Modelo y dependencias:** codex-sol (effort medium) para la CLI. Los scripts y el runbook, gemini o minimax. Depende de A.
- **Ficheros:**
  - `ops/cli/cauce-plataforma` (nuevo): `admin otorgar|revocar`, `empresa crear|estado|roles|principales`, `enlace crear|borrar`, `host registrar|asignar`, `catalogo aplicar <json>` y `persona contraseña`;
  - `ops/tests/cauce-plataforma.test.*`;
  - `ops/scripts/export-fleet-snapshot.py` y `ops/scripts/fleet_runtime_materialization.py` (`--company` y el gate de paridad);
  - Telegram: `ops/telegram-runtime/config.json` (ruta de token `<tenant>/<alias>.token`), `services/telegram-bridge/src/config.ts` y `services/telegram-bridge/test/config.test.ts`;
  - guardias sin el default `steven_dm`: `ops/guardias/catalogo-mouseion-health.sh` y `ops/guardias/cauce-attach`.
- **Tests:**
  - la CLI solo llama a funciones `cauce_platform_*` y audita;
  - la paridad por empresa no falla con agentes de otra empresa;
  - dos empresas con el mismo alias no comparten fichero de token.
- **Aceptación:** la siembra de §6.1 se puede repetir con la CLI.

**WP-J · Cierre (R2)**
- **Modelo y dependencias:** Opus. Depende de todos los anteriores, y de una semana estable tras R1.
- **Ficheros:**
  - `packages/store/migrations/055_drop_legacy_company_default.sql` y su `down/`;
  - `configuration/company-scope.ts` y `index.ts`: se borra `LEGACY_COMPANY`;
  - `tests/unit/no-company-literals.test.ts`: la lista de excepciones queda vacía;
  - los fixtures de §4.4;
  - este documento: sección «Estado V4.1».
- **Tests:** la suite completa, la suite con el rol de runtime y el lint sin excepciones.
- **Aceptación:**
  - no hay default;
  - ningún literal de empresa en `packages/*/src`, `services/*/src` ni `console/src`.

**WP-K · V4.1b, antes de activar agentes de Praxis**
- **Modelo y dependencias:** minimax, con revisión de codex. Depende de H.
- **Ficheros:** `services/decisiones/src` (cargador por empresa) y `services/decisiones/catalogo/empresas/<empresa>/…` (se mueven `ruteo_alias.json` y `aprobacion_humana.json`).
- **Aceptación:** las plantillas de una empresa no se resuelven para otra.

### 8. Riesgos

1. **Falta un grant y un camino falla en producción con 42501.** Mitigación: la suite con el rol de runtime, el ensayo en el clon, conmutar servicio a servicio, alerta de 42501 y rollback por variable de entorno.
2. **`FOR SHARE` o `LOCK TABLE` sobre tablas sin `UPDATE`.** Mitigación: helpers DEFINER y el test de WP-B.
3. **Funciones DEFINER cuyo dueño es un superusuario.** Mitigación: mínimas, con `search_path` fijo y sin SQL dinámico.
4. **Quedarse sin acceso** por perder al último dueño o al último SA. Mitigación: G3 y G4, más el acceso de emergencia de root en el VPS.
5. **Bloqueos de R1** (`ACCESS EXCLUSIVE` sobre `messages` y otras tablas). Mitigación: medirlos en el ensayo, `lock_timeout` de 5 s y reintento.
6. **Un predicado olvidado al cambiar la PK de `rooms`.** Mitigación: el lint de SQL y el canario de dos empresas con el mismo id de sala.
7. **La consola vieja frente al contrato nuevo.** Recibe un `conflict` de revisión y no reconoce el alcance `company`. Mitigación: la consola se despliega en el mismo release que el contrato.
8. **Cambios de comportamiento:**
   - Miguel administra las cuentas que paga Steven (D2);
   - los arneses dejan de editarse en la consola (D3);
   - zeus@ sigue como admin por el relleno, salvo que el dueño decida revocarlo (D1).
9. **Poder real del SA en otra empresa.** Mitigación: queda auditado en la empresa afectada y se revalida en cada petición.
10. **Sin RLS, un runtime comprometido ve todas las empresas.** Queda aceptado hasta V4.5.
11. **Consumidores fuera de compose que siguen como `cauce`.** Mitigación: el inventario (§5, paso 1) y la alerta.
12. **Los roles son globales del clúster.** Mitigación: creación tolerante en los tests.
13. **Conflictos al integrar los ficheros secuenciados** (`index.ts`, `company-scope.ts`). Mitigación: el orden de §7.

### 9. Estimación

| Paquete | Días-ingeniero |
|---|---|
| A, esquema | 6 |
| B, rol de runtime | 4 |
| C, autoridad y sesión | 4 |
| D, configuración | 4 |
| E, flota y cuentas | 4 |
| F, personas | 2 |
| G, fugas | 3 |
| H, literales | 5 |
| I, operación | 3 |
| J, cierre | 1,5 |
| Ensayo, revisión adversarial y despliegues | 3,5 |
| **Total** | **≈ 40 (rango 32–45)** |

**Calendario,** con dos frentes en la ola 1 y seis en la ola 3:
- unas 4 semanas hasta R1;
- la siembra de dueños, el mismo día de R1;
- el cambio de rol, 2 o 3 días después;
- R2, una semana más tarde.

WP-K (2 días) va en paralelo, antes de V4.4. V4.2 (consola) y V4.3 (importador) pueden empezar al cerrar R1.

### 10. Decisiones del dueño pendientes (con valor por defecto)

- **D1.** ¿zeus@ sigue como `admin` de Humanizar? *Por defecto sí*: así no cambia nada. Se revoca con la CLI.
- **D2.** ¿Un `admin` (no dueño) gestiona cuentas de proveedor? *Por defecto no.* Los dueños sí, así que Miguel podrá editar cuentas pagadas por el espacio Steven.
- **D3.** ¿Arneses y políticas de rol solo por la CLI de plataforma? *Por defecto sí.*
- **D4.** ¿A quién llegan los avisos de supervisión de Praxis? *Por defecto a Leon,* con un destino de Praxis. A Steven solo con enlace y aristas.
- **D5.** ¿Se comparten computadoras entre empresas? *Por defecto no:* una máquina pertenece a una sola empresa.
