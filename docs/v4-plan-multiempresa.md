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
5. **Super-administrador de plataforma:** pendiente de confirmar; la recomendación es un rol separado del hub de Humanizar, asignado sólo al dueño.

Archivos centrales a tocar: `packages/store/migrations/` (nueva 051+), `packages/store/src/configuration/shared.ts`, `packages/store/src/configuration.ts`, `services/gateway/src/console/people-admin-authority.ts`, `services/gateway/src/publish-operation.ts`, `packages/store/src/repository/messages/publishing.ts`.