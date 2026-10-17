# V4: auditoría de membresías y migración `081_membresia_rol_derivado.sql`

Estado: **implementada en código y esquema** (`packages/store/migrations/081_membresia_rol_derivado.sql` y `packages/store/migrations/down/081_membresia_rol_derivado.sql`, con locks declarados en `packages/store/src/migration-locks.ts:77` y recorte de permisos de lector en `services/gateway/src/console-user-maintenance.ts:45-51`). En el análisis histórico de este documento, `NNN` corresponde a `081`.

Las referencias `file:line` recogen la auditoría que dio origen a `081_membresia_rol_derivado.sql`. Las rutas de paquete son relativas a la raíz del repo; `M/NNN` abrevia `packages/store/migrations/NNN_*.sql`.

## 1. Resumen de decisiones

| Concepto | Decisión | Motivo corto |
|---|---|---|
| `console_users.role` | **Conservar** (fuente única del rol) | Lo leen el login, el guardián de propietarios (G4) y todas las decisiones de autoridad. |
| `human_tenant_memberships.role` | **Eliminar** (derivar de `console_users.role`) | Todo escritor lo copia de `console_users.role`; todo lector lo intersecta con ese mismo valor o lo repite en SQL. No añade información y puede divergir. |
| `human_tenant_memberships.permissions` | **Conservar** | Único tope por persona (`seed-dev-cli.ts:136` lo estrecha a `read,control`); lo leen 6 decisiones de autoridad y la revisión OAuth. |
| `console_users.company_id` | **Conservar** | Lo leen ≥10 consultas y lo exigen 3 FKs compuestas (`company_admins`, favoritos, `human_tenant_memberships`). Quitarlo debilita el aislamiento. |
| `human_tenant_memberships.company_id` | **Conservar** | Su único lector SQL es 064, pero sus dos FKs compuestas son el control «la membresía vive en la empresa de la persona». |
| `console_users.tenant_id` / `alias` | **Conservar** (no tocar) | Sin sustituto. Lectores listados abajo. |
| `console_users.active` frente a `human_tenant_memberships.enabled` | **Conservar ambos ahora**; candidato futuro | Misma duplicación que el rol, pero `enabled`/`revoked_at`/`revision` alimentan la invalidación de grants OAuth. |
| `company_admins`, `company_admin_versions` | **Conservar** | Fuente de los roles de empresa (owner/admin). |
| `platform_admins` | **Conservar** | Única autoridad por encima de una empresa. |
| `memberships` (sala), `role_policies` | **Conservar** | Fuente del alcance de enrutado/lectura/control de cada agente. |
| Agente `owner` | **Conservar** (dato, no concepto) | Ningún código lee el alias literal `owner`. |

Cambio neto aplicado en `081_membresia_rol_derivado.sql`: una columna menos (`human_tenant_memberships.role`), una verdad menos, y dos guardas diferidas (`human_memberships_reader_ceiling` y `console_users_reader_ceiling`) que sustituyen a los CHECK que se retiran.

## 2. Modelo de datos actual

```
tenants(id, company_id, is_hub) ──< agents(tenant_id, alias)
console_users(id, email*, role, tenant_id, alias, company_id, active, password_*)
   FK (tenant_id, company_id) -> tenants(id, company_id)               M/053:309
   UNIQUE (id, company_id)                                              M/053:310
human_tenant_memberships(human_id, tenant_id, actor_alias, role, permissions,
                         enabled, revoked_at, revision, company_id)     M/044:39
   PK (human_id, tenant_id); FK (tenant_id, actor_alias) -> agents      M/044:50
   FK (tenant_id, company_id) -> tenants; FK (human_id, company_id) -> console_users(id, company_id)   M/053:335-339
company_admins(company_id, human_id, role owner|admin, source, version)  M/054:17, M/055:92
platform_admins(human_id)                                               M/051:41
memberships(tenant_id, room_id, alias, role -> role_policies, enabled)   (sala; M/001:21)
role_policies(role, allow_route, allow_read, allow_control, allow_notify)   (M/003:54)
```

Cadena de autoridad de una persona de consola (la repiten 6 sitios): `console_users` activo con rol → membresía hogar `human_tenant_memberships` (mismo `tenant_id` que la cuenta) habilitada → sala `memberships` del agente `alias` con `role_policies` que permita lo pedido.

Los **lectores** solo consultan la membresía **hogar**: ninguno lee una fila de `human_tenant_memberships` cuyo `tenant_id` difiera de `console_users.tenant_id` (todos hacen el JOIN por `tenant_id=account.tenant_id`: `human-identity.ts:44-48`, `client-mailbox.ts:23`, `configuration.ts:449`, `native-admin/service.ts:39-40`, `fleet-operation-human.ts:13-19`).

Las **filas almacenadas** no se limitan a la hogar: `syncMembership` (`people-admin-store.ts:23-30`) revoca la fila anterior (`enabled=false`, `revoked_at`) y hace upsert en el tenant nuevo, de modo que mover a una persona de tenant deja una fila revocada en el tenant viejo, con el rol que tenía. Esa fila no se puede borrar ni reasignar (`human_membership_preserved`, `M/044:92-95`) y `human_message_initiators` la referencia. Toda comprobación de NNN (precondición del `up`, guarda de lector, repoblado del `down`) trata esas filas como historia: solo la membresía hogar (`h.tenant_id=u.tenant_id`) es autoridad vigente.

## 3. Inventario por concepto

### 3.1 `console_users.role`

Definición: `M/023_console_users.sql` columna `role`, CHECK `operator|reader`.

Escritores
- `services/gateway/src/console/people-admin-store.ts:107` (alta) y `:125` (UPDATE de `role`).
- `services/gateway/src/console-user-maintenance.ts:47` (UPDATE con `--update`), `:70-73` (alta).
- `packages/store/src/seed-dev-cli.ts:127` (siempre `operator`).
- `M/055_company_registration.sql:24-25` (`cauce_register_company`, hoy `cauce_register_company_without_director` por `M/063:39`).
- `M/044_human_mcp_identity.sql` (siembra inicial de membresías copiando este rol).

Lectores
- Login y sesión: `console-users.ts:68-70,85,95` (COLUMNS), `:52` (valida el valor), `password-auth.ts:sessionState` (techo `consoleRoleAuthority`).
- Instantánea de autoridad: `packages/store/src/human-identity.ts:78` y `:91`, `:164` y `:188`, `:206` y `:211`.
- Techos de permiso: `services/gateway/src/oauth-grant-authority.ts:27`, `console-human-authority.ts:63`, `human-mcp-authority.ts:130`, `terminal/session-authority.ts:114`, `console-user-authority.ts:19-27`.
- Calificación de propietario/plataforma: `packages/store/src/company-authority.ts:73`, `packages/store/src/configuration.ts:452`, `native-admin/service.ts:40`, `fleet-operation-human.ts:13-14`.
- SQL: guardián G4 `M/054:121-139` (trigger `console_users_owner_guard`, `M/054:368`), continuidad de propietarios `M/054:109-110`, `M/055:41,110,152`, `M/064:32`.
- UI/API de personas: `people-admin-store.ts:16` (COLUMNS), `people-admin-authority.ts:63-70`.

Decisión: **conservar**. Es el rol de la persona y tiene los lectores de seguridad más críticos.

### 3.2 `human_tenant_memberships.role`

Definición: `M/044:43` (`role text NOT NULL CHECK (role IN ('operator','reader'))`) y `M/044:53` (`role <> 'reader' OR permissions <@ {read}`).

Escritores (todos copian `console_users.role`)
- `people-admin-store.ts:26-30` (`syncMembership`: pasa `value.role`, el de la fila de `console_users`).
- `console-user-maintenance.ts:82-85` (alta: `row.role`).
- `seed-dev-cli.ts:135` (`'operator'` fijo, igual que la cuenta en `:128`).
- `M/055:26-27` (`'operator'` fijo, igual que `console_users` en `:25`).
- `M/044` (siembra: `SELECT … role … FROM console_users`).
- `M/053:258-272` (backfill de `company_id`, sin tocar el rol).
- Ruta que **no** lo sincroniza: `console-user-maintenance.ts:57-65` y `:89-95` (`--update --role`) cambian `console_users.role` sin tocar la membresía. Hoy eso crea divergencia real entre las dos columnas (ver 3.10).

Lectores
- TS (siempre en conjunción con el rol de la cuenta):
  - `human-identity.ts:44,52-54` (snapshot), consumido en `oauth-grant-authority.ts:28-32`, `console-human-authority.ts:64-67`, `human-mcp-authority.ts:131-134`, `terminal/session-authority.ts:114-119`.
  - `company-authority.ts:74`, `configuration.ts:454`, `native-admin/service.ts:41`, `fleet-operation-human.ts:18-21`.
- SQL: `M/045:140-141` (el trigger `cauce_oauth_membership_revision` incluye `role` en lo que sube `revision`), `M/054:324`, `M/055:49,111,153`, `M/064:28,32`.

Evidencia de que no aporta información: en cada sitio TS el valor efectivo es la intersección `account.role ∩ membership.role` (`oauth-grant-authority.ts:29`, `console-human-authority.ts:65-66`, `human-mcp-authority.ts:132-133`), y en cada sitio SQL el predicado es `u.role='operator' AND h.role='operator'` o `identity.role=human.role` (`M/064:32`). Con escritores que siempre copian, el único caso en que difieren es un fallo de sincronización (3.10).

Decisión: **eliminar**. Se deriva de `console_users.role`. Los controles que la columna sostenía se conservan:
- Tope «un lector solo puede tener `read`» (CHECK `M/044:53`): pasa a una guarda diferida en NNN (`human_memberships_reader_ceiling`, `console_users_reader_ceiling`).
- Revocación OAuth ante cambio de rol (`M/045:140`): pasa a un trigger sobre `console_users` que sube `revision` de la membresía (`console_users_role_revision`). Sin él, un cambio de rol por `console_users` no invalidaría los grants OAuth, que dependen de `membership_revision` (`client-mailbox.ts:26`).

### 3.3 `human_tenant_memberships.permissions`

Definición: `M/044:44` (`permissions text[]`, default `{read}`), CHECKs `M/044:52-53`.

Escritores: `people-admin-store.ts:30` y `console-user-maintenance.ts:85` (`consoleRoleAuthority(role).permissions`, es decir derivado del rol), `seed-dev-cli.ts:136` (**`read,control`**, más estrecho que el rol), `M/055:27` (`route,read,control,notify`), `M/044` (siembra).

Lectores: `human-identity.ts:44,53`; `oauth-grant-authority.ts:30`; `console-human-authority.ts:67`; `human-mcp-authority.ts:133-134`; `terminal/session-authority.ts:120`; `fleet-operation-human.ts:21`; `company-authority.ts:75,120`; `client-mailbox.ts:32`; `native-admin/service.ts:41`; `configuration.ts:455`; `M/054:324`, `M/055:49,111,153`, `M/064:34`.

Decisión: **conservar**. Aunque los escritores de producción siempre escriben el conjunto completo del rol, es el único canal de tope por persona y ya se usa estrechado (seed de desarrollo). Eliminarlo o derivarlo es una decisión de producto («no hay topes por persona»), no una simplificación segura; se deja fuera de NNN.

### 3.4 `console_users.company_id`

Definición: `M/053:242` (añadida), backfill `M/053:265`, `NOT NULL` + FK compuesta `(tenant_id, company_id)` y `UNIQUE (id, company_id)` en `M/053:308-310`. Relleno automático `console_users_company_fill` (`M/053:375`); inmutable por `console_users_company_immutable` (`M/053:403`).

Escritores: solo los triggers de arriba y `M/055:24-25` (explícito). Ningún TS lo escribe.

Lectores
- TS: `human-identity.ts:206,212` (`lockConsolePerson`), `company-authority.ts:131-133`, `company-authority.ts:102` (compara con la empresa del tenant), `people-admin-store.ts:19,96`, `console-user-maintenance.ts:34`, `configuration.ts:448-450`.
- SQL: `M/054:152,154` (`cauce_company_authority`), `M/054:126-128` (G4), `M/055:56,130`, `M/064:31`.
- FKs que dependen de `UNIQUE (id, company_id)`: `company_admins` (`M/054:25`), `console_agent_favorites` (`M/053:333`), `human_tenant_memberships` (`M/053:338`).

Alternativa evaluada: derivarla de `tenants.company_id` vía `tenant_id`. Obliga a reemplazar las tres FKs compuestas por triggers (control más débil: una FK es inmediata y sin ventana), a reescribir ≥10 consultas con un JOIN extra y a rehacer `cauce_fill_company_from_human` (`M/053:44-52`) y la comprobación de inmutabilidad, todo en la capa que garantiza el aislamiento multiempresa (GOAL §1). Sin lector que justifique el riesgo.

Decisión: **conservar**.

### 3.5 `human_tenant_memberships.company_id`

Definición: `M/053:249`, backfill `:272`, `NOT NULL` + FKs `M/053:335-339`, relleno `human_tenant_memberships_company_fill` (`M/053:389`, función `cauce_fill_company_from_human`), inmutable (`M/053:417`).

Lectores SQL: solo `M/064:32` (`identity.company_id=p_company`). En TS ninguno; solo las comprobaciones de esquema (`health/schema-companies.ts:27-28,46`) y `ops/scripts/rehearse-migrations-clone.sh`.

Valor: las dos FKs (`(tenant_id, company_id)` y `(human_id, company_id)`) obligan a que la membresía pertenezca a la empresa de la persona y del tenant, sin trigger. Es una columna casi sin lectores pero con función puramente de restricción.

Decisión: **conservar**. Retirarla exigiría una guarda por trigger equivalente; ganancia nula frente al coste de revisar las comprobaciones de esquema y el ensayo de clon. Reevaluar si algún día se elimina la FK de persona.

### 3.6 `console_users.tenant_id` y `console_users.alias`

Definición: `M/023` (NOT NULL; `tenant_id` con FK a `tenants`).

Escritores: `people-admin-store.ts:107,125`; `console-user-maintenance.ts:48-49,70-73`; `seed-dev-cli.ts:127`; `M/055:24-25`.

Lectores: `human-identity.ts:78,86,164,185,206,209`; `console-users.ts:68-70,85,95`; `fleet-operation-human.ts:13-14`; `packages/store/src/host-enrollment.ts:23`; `packages/store/src/space-backup-authority.ts:28`; `client-mailbox.ts:23,31`; `company-authority.ts:101-103`; `configuration.ts:449-454`; `platform-cli.ts:19`; `security/route-isolation-sockets.ts:73`; `native-admin/service.ts:39-40`; `M/054:316-320`, `M/055:48,111,153`, `M/064:27,31`.

Observación (no actuar ahora): `alias` se repite como `human_tenant_memberships.actor_alias` y casi todo SQL añade `h.actor_alias=u.alias` (`M/055:48,111,153`, `M/064:27`). Es la misma duplicación que el rol, pero aquí `actor_alias` es la columna de la FK a `agents` (`M/044:50`). Sin sustituto definido.

Decisión: **conservar, no tocar**.

### 3.7 `company_admins` y `company_admin_versions`

Definición: `M/054:17-28`; `version` y tabla de versiones en `M/055:92-100`.

Escritores: funciones `cauce_platform_grant_admin` / `cauce_platform_revoke_admin` (`M/054:258,282`), `cauce_set_company_admin` (`M/055:119`), alta de empresa (`M/055:28-29`); en TS solo vía `packages/store/src/company-administration.ts:42` y siembras `seed-dev-cli.ts:84,171`.

Lectores: `cauce_company_authority` (`M/054:157`, usada por `company-authority.ts:49` y `people-admin-authority.ts:53`), `company-authority.ts:137`, `configuration.ts:473-475`, `configuration-platform.ts:38`, `routes/console/company-admins.ts:28`, guardas `M/054:92,109,126-128`, `M/055:57,104`.

Decisión: **conservar**. Es la única fuente de «owner/admin de empresa»; el rol del humano en la consola no lo sustituye.

### 3.8 `platform_admins`

Definición: `M/051:41-48`. Escritores: función de plataforma y `seed-dev-cli.ts:165`. Lectores: `cauce_company_authority` (`M/054:156`), `company-authority.ts:138`, `configuration.ts:476`, `configuration-platform.ts:37`, guardas `M/054:91,134-138`, `M/055:55,134`, `M/062:5`.

Decisión: **conservar**.

### 3.9 Membresías de sala (`memberships`) y `role_policies`

Escritores de `memberships`: `configuration/mutations/tenants.ts:124,150,156`; `repository/fleet-operation-desired.ts:59-61`; `fleet-operation-admission.ts:57`; `fleet-operation-lifecycle.ts:81,91,130`; `fleet-operation-purge.ts:43-45`; `seed-dev-cli.ts:107,133`; `M/055:23`, `M/063:33`, `M/064:84`.

Lectores de `memberships ⨝ role_policies` (autoridad real de cada alias): `company-authority.ts:55-69`, `client-mailbox.ts:35-38`, `configuration.ts:456-470`, `people-admin-authority.ts:63-70`, `repository/config.ts:32,65,105,139`, `repository/messages/human-authority.ts:32`, `human-inbox.ts:148`, `outbox/operator.ts:34,48`, `agents/notifications.ts:181`, `fanin/response.ts:117`, `fanin/materialization.ts:341`, `agent-profile.ts:429`, `services/decisiones/src/identity.ts:29`, `gateway/src/context-version-runtime.ts:28`.

Escritores de `role_policies`: `configuration/mutations.ts:199,212,217`; trigger `role_policies_platform_write` (`M/052:99`); semilla `M/063:4`. Lectores: `configuration.ts:144`, `configuration-platform.ts:49`, `fleet/host-channel.execution.ts:32`, `fleet-operation-authority.ts:129` y los JOIN anteriores.

Nota: `M/064:28` exige `member.role = identity.role`, es decir que el nombre del rol de sala coincide con el rol humano (`operator`/`reader`). Es un acoplamiento accidental; NNN lo mantiene (pasa a `human.role`, equivalente por `M/064:32`).

Decisión: **conservar ambos**. Son la fuente del alcance por agente; sin ellos no hay enrutado.

### 3.10 Agente `owner`

`M/055:22-23` crea el agente `owner` y su membresía de sala `operator` en el hub al registrar; la cuenta usa `alias='owner'` (`M/055:25`). `seed-dev-cli.ts:81-83` siembra igual.

Ningún código lee el literal `'owner'` como alias (los únicos lectores de `'owner'` son `company_admins.role`: `company-authority.ts:116,137`, `company-administration.ts:36`, `people-admin-authority.ts:55`). El «owner» de autoridad es `company_admins.role='owner'`, no el agente.

Decisión: **conservar** como dato inicial de registro; no es un concepto de esquema. Se recomienda un comentario en `M/055`-equivalente de registro (no edición de migraciones existentes) o en este documento para evitar confundirlos.

### 3.11 Hallazgo: divergencia por `console-user-maintenance --update`

En la auditoría inicial, `console-user-maintenance.ts` actualizaba `role`, `tenant_id`, `alias` y `active` de `console_users` sin sincronizar `human_tenant_memberships`, a diferencia de `people-admin-store.ts:24-32` (`syncMembership`). Con `081_membresia_rol_derivado.sql` el rol deja de divergir y `services/gateway/src/console-user-maintenance.ts:45-51` (`clampReaderHomeMembership`) recorta los permisos de la membresía hogar a `['read']` en la misma transacción cuando `--update` degrada una cuenta a `reader`.

## 4. Qué se elimina y qué se mantiene tras 081

- Se elimina: `human_tenant_memberships.role` y los CHECK que lo mencionan (se sustituyen por guardas).
- Se añade: función `cauce_console_user_role_revision()` y trigger `console_users_role_revision`; función `cauce_human_reader_ceiling()` y triggers de restricción `human_memberships_reader_ceiling` y `console_users_reader_ceiling`.
- Se reescriben (solo el cuerpo): `cauce_oauth_advance_identity_revision`, `cauce_register_company_without_director`, `cauce_require_company_owner`, `cauce_assert_qualified_company_owner`, `cauce_set_company_admin`, `cauce_ensure_context_director_anchor`.
- No se tocan: `tenant_id`, `alias`, `company_id` (ambas tablas), `permissions`, `active`/`enabled`.

## 5. Migración `081_membresia_rol_derivado.sql`

Archivos en el árbol: `packages/store/migrations/081_membresia_rol_derivado.sql` y `packages/store/migrations/down/081_membresia_rol_derivado.sql`. `migrationSourcesForApply` calcula el SHA de cada fuente (`packages/store/src/migration-integrity.ts`), que `db.ts` registra en el ledger; el `down` incrusta el SHA real del `up`.


### 5.1 up

```sql
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_NNN);
LOCK TABLE console_users,human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;

-- Precondición: solo la membresía hogar es autoridad vigente; las filas revocadas de tenants anteriores
-- (syncMembership) son historia inmutable y su rol se descarta sin comprobarlo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM human_tenant_memberships h JOIN console_users u
               ON u.id=h.human_id AND h.tenant_id=u.tenant_id
             WHERE h.role<>u.role) THEN
    RAISE EXCEPTION 'cannot derive membership role: console_users.role and the home membership role differ'
      USING ERRCODE='23514';
  END IF;
END
$$;

-- Parche exacto de cuerpos: aborta si el texto no está (nunca reemplaza en silencio).
CREATE FUNCTION pg_temp.cauce_NNN_patch(p_proc regprocedure,p_from text,p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source text := pg_get_functiondef(p_proc); patched text;
BEGIN
  patched := replace(source,p_from,p_to);
  IF patched = source THEN RAISE EXCEPTION 'pattern % not found in %',p_from,p_proc; END IF;
  EXECUTE patched;
END
$$;

-- 055 (renombrada por 063): el alta ya no escribe el rol de la membresía.
SELECT pg_temp.cauce_NNN_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,company_id)',
  'human_tenant_memberships(human_id,tenant_id,actor_alias,permissions,company_id)');
SELECT pg_temp.cauce_NNN_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'VALUES(person,hub,''owner'',''operator'',ARRAY[',
  'VALUES(person,hub,''owner'',ARRAY[');

-- 055: el rol operador ya lo exige u.role / person.role en la misma consulta.
SELECT pg_temp.cauce_NNN_patch('cauce_require_company_owner(text,uuid)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_NNN_patch('cauce_assert_qualified_company_owner(text)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_NNN_patch('cauce_set_company_admin(text,uuid,uuid,text,bigint)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');

-- 064: identity.role=human.role era la condición; member.role pasa a compararse con human.role.
SELECT pg_temp.cauce_NNN_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND member.role=identity.role','AND member.role=human.role');
SELECT pg_temp.cauce_NNN_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  ' AND identity.role=human.role','');

-- 045: la revisión ya no mira el rol de la membresía.
CREATE OR REPLACE FUNCTION cauce_oauth_advance_identity_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Human identity revision cannot decrease';
  END IF;
  IF TG_TABLE_NAME='human_external_identities' THEN
    changed := (NEW.enabled, NEW.revoked_at) IS DISTINCT FROM (OLD.enabled, OLD.revoked_at);
  ELSE
    changed := (NEW.enabled, NEW.revoked_at, NEW.actor_alias, NEW.permissions)
      IS DISTINCT FROM (OLD.enabled, OLD.revoked_at, OLD.actor_alias, OLD.permissions);
  END IF;
  IF changed THEN NEW.revision := GREATEST(NEW.revision, OLD.revision+1); END IF;
  RETURN NEW;
END $$;

-- Un cambio de rol en console_users invalida los grants OAuth como antes lo hacía el UPDATE de la membresía.
CREATE FUNCTION cauce_console_user_role_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE human_tenant_memberships SET revision=revision+1 WHERE human_id=NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER console_users_role_revision AFTER UPDATE OF role ON console_users
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role) EXECUTE FUNCTION cauce_console_user_role_revision();

-- Sustituye al CHECK «reader => solo read» (M/044:53), diferido para permitir reader+permisos en la misma transacción.
-- Solo mira la membresía hogar: las filas revocadas de tenants anteriores conservan permisos antiguos y no cuentan.
CREATE FUNCTION cauce_human_reader_ceiling() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM human_tenant_memberships h JOIN console_users u
               ON u.id=h.human_id AND h.tenant_id=u.tenant_id
             WHERE h.human_id=(to_jsonb(NEW)->>TG_ARGV[0])::uuid
               AND u.role='reader' AND NOT h.permissions <@ ARRAY['read']::text[]) THEN
    RAISE EXCEPTION 'a reader may only hold the read permission'
      USING ERRCODE='23514', TABLE='human_tenant_memberships', CONSTRAINT='human_membership_reader_read_only';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER human_memberships_reader_ceiling
  AFTER INSERT OR UPDATE OF permissions ON human_tenant_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cauce_human_reader_ceiling('human_id');
CREATE CONSTRAINT TRIGGER console_users_reader_ceiling
  AFTER UPDATE OF role, tenant_id ON console_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.role='reader') EXECUTE FUNCTION cauce_human_reader_ceiling('id');

-- Último paso: ningún cuerpo de función ni trigger referencia ya la columna.
ALTER TABLE human_tenant_memberships DROP COLUMN role;
```

`DROP COLUMN` elimina por sí solo los CHECK `role IN (…)` y `role <> 'reader' OR …`. Los privilegios de las funciones reemplazadas se conservan (`CREATE OR REPLACE`).

### 5.2 down

```sql
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_NNN);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'NNN_membership_single_role.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'NNN_membership_single_role.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema NNN while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='NNN_membership_single_role.sql'
      AND (source_origin<>'applied-atomically' OR source_sha256<>'<SHA256_DEL_UP>')) THEN
    RAISE EXCEPTION 'cannot downgrade schema NNN from an inconsistent atomic ledger state';
  END IF;
END
$$;
LOCK TABLE console_users,human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER console_users_reader_ceiling ON console_users;
DROP TRIGGER human_memberships_reader_ceiling ON human_tenant_memberships;
DROP TRIGGER console_users_role_revision ON console_users;
DROP FUNCTION cauce_human_reader_ceiling();
DROP FUNCTION cauce_console_user_role_revision();

-- Función de revisión original (M/045:131-145), antes de repoblar la columna.
CREATE OR REPLACE FUNCTION cauce_oauth_advance_identity_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Human identity revision cannot decrease';
  END IF;
  IF TG_TABLE_NAME='human_external_identities' THEN
    changed := (NEW.enabled, NEW.revoked_at) IS DISTINCT FROM (OLD.enabled, OLD.revoked_at);
  ELSE
    changed := (NEW.enabled, NEW.revoked_at, NEW.actor_alias, NEW.role, NEW.permissions)
      IS DISTINCT FROM (OLD.enabled, OLD.revoked_at, OLD.actor_alias, OLD.role, OLD.permissions);
  END IF;
  IF changed THEN NEW.revision := GREATEST(NEW.revision, OLD.revision+1); END IF;
  RETURN NEW;
END $$;

-- Repoblar sin subir revision (como M/053:258-259): restaurar no debe invalidar grants.
ALTER TABLE human_tenant_memberships DISABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships ADD COLUMN role text;
-- Hogar: el rol de la cuenta. Filas revocadas de tenants anteriores: su rol original no se conserva; se
-- reconstruye el más estrecho compatible con el CHECK de lector (nadie las lee, están revocadas).
UPDATE human_tenant_memberships h SET role=CASE
    WHEN h.tenant_id=u.tenant_id THEN u.role
    WHEN h.permissions <@ ARRAY['read']::text[] THEN 'reader'
    ELSE 'operator' END
  FROM console_users u WHERE u.id=h.human_id;
ALTER TABLE human_tenant_memberships ENABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT human_tenant_memberships_role_check CHECK (role IN ('operator','reader')),
  ADD CONSTRAINT human_tenant_memberships_check
    CHECK (role <> 'reader' OR permissions <@ ARRAY['read']::text[]);

CREATE FUNCTION pg_temp.cauce_NNN_patch(p_proc regprocedure,p_from text,p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source text := pg_get_functiondef(p_proc); patched text;
BEGIN
  patched := replace(source,p_from,p_to);
  IF patched = source THEN RAISE EXCEPTION 'pattern % not found in %',p_from,p_proc; END IF;
  EXECUTE patched;
END
$$;

SELECT pg_temp.cauce_NNN_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'human_tenant_memberships(human_id,tenant_id,actor_alias,permissions,company_id)',
  'human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,company_id)');
SELECT pg_temp.cauce_NNN_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'VALUES(person,hub,''owner'',ARRAY[','VALUES(person,hub,''owner'',''operator'',ARRAY[');
SELECT pg_temp.cauce_NNN_patch('cauce_require_company_owner(text,uuid)'::regprocedure,
  'h.revoked_at IS NULL AND ''control''=ANY(h.permissions)',
  'h.revoked_at IS NULL AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_NNN_patch('cauce_assert_qualified_company_owner(text)'::regprocedure,
  'h.actor_alias=u.alias AND ''control''=ANY(h.permissions)',
  'h.actor_alias=u.alias AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_NNN_patch('cauce_set_company_admin(text,uuid,uuid,text,bigint)'::regprocedure,
  'h.actor_alias=u.alias AND ''control''=ANY(h.permissions)',
  'h.actor_alias=u.alias AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_NNN_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND member.role=human.role','AND member.role=identity.role');
SELECT pg_temp.cauce_NNN_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND identity.enabled AND identity.revoked_at IS NULL',
  'AND identity.enabled AND identity.revoked_at IS NULL AND identity.role=human.role');
```

Puntos verificados del SQL en `packages/store/migrations/081_membresia_rol_derivado.sql`:
- Los patrones literales coinciden con el cuerpo almacenado (`pg_get_functiondef` devuelve el cuerpo tal como se escribió). El helper aborta si no hay coincidencia; un patrón que coincida en más de un sitio de la misma función se reemplaza en todos.
- `down` deja los cuerpos de `cauce_assert_qualified_company_owner` y `cauce_set_company_admin` idénticos a los de 055 por la simetría de patrones.
- La derivación no necesita backfill: el `up` solo corre si la membresía hogar coincide con `console_users.role`; si no, aborta con mensaje (`23514`) y exige alinear esa fila antes de aplicar. Las filas revocadas de tenants anteriores no se comprueban ni se reconcilian: el `up` descarta su rol y el `down` lo reconstruye.
- **Operación y recuperación:** al ejecutar migraciones (`runMigrations` o `deploy/deploy.sh`), `081_membresia_rol_derivado.sql` verifica que ninguna membresía hogar diverja de `console_users.role` y que ningún `reader` tenga permisos distintos de `read`. Si aborta con `23514`, la transacción se revierte íntegra: alinear la fila divergente con `maintainConsoleUser` (`services/gateway/src/console-user-maintenance.ts:45-92`) o desde Personas (`/v3/console/people`) y reintentar la migración.

## 6. Cambios de código aplicados con 081

Código de producción:
1. `packages/store/src/human-identity.ts`: eliminada la lectura de `role` desde `human_tenant_memberships`; `account.role` es la fuente única del rol.
2. `services/gateway/src/oauth-grant-authority.ts`, `console-human-authority.ts`, `human-mcp-authority.ts`: `account` actúa como techo único y los permisos efectivos son `account.permissions ∩ membership.permissions`.
3. `services/gateway/src/terminal/session-authority.ts`: evalúa el rol desde `snapshot.account.role`.
4. `packages/store/src/company-authority.ts`: deriva el rol desde la cuenta humana.
5. `packages/store/src/configuration/control-holders.ts` y `services/gateway/src/console/native-admin/service.ts`: leen el rol desde `console_users`.
6. `packages/store/src/repository/fleet-operation-human.ts:18`: lee `enabled,revoked_at,actor_alias,permissions` sin columna `role`.
7. `services/gateway/src/console/people-admin-store.ts:24-32` (`syncMembership`), `services/gateway/src/console-user-maintenance.ts:45-115` (`clampReaderHomeMembership`) y `packages/store/src/seed-dev-cli.ts:136-143`: sincronizan `human_tenant_memberships` sin columna `role` y recortan a `['read']` al degradar a `reader`.
8. `services/gateway/src/health/schema-companies.ts`: registra los triggers `console_users_role_revision`, `human_memberships_reader_ceiling`, `console_users_reader_ceiling` y las funciones `cauce_console_user_role_revision()`, `cauce_human_reader_ceiling()`.

## 7. Verificación

Verificado en PostgreSQL real (`services/gateway/src/console-user-maintenance-postgres.test.ts` y suites de migraciones e identidad humana):
- `up` con persona movida: pasa y la columna `role` desaparece de `human_tenant_memberships`.
- Mover y después bajar a lector (y mover y bajar de rol en la misma transacción): COMMIT correcto con `clampReaderHomeMembership`.
- Lector con permisos más allá de `read` en la membresía hogar: rechazado en COMMIT (`human_membership_reader_read_only`), tanto desde `human_tenant_memberships` como desde `console_users`.
- Cambio de rol en `console_users` sube `revision` de la membresía (`console_users_role_revision`).
- Rol divergente en la membresía hogar: el `up` aborta con `23514`.
- `down` tras persona movida y bajada a lector: repuebla `role` sin violar el CHECK y restaura las funciones previas.

