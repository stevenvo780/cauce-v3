# Identidad humana durable: migración 044

## Alcance y estado

Esquema aditivo sobre `codex/mcp-dependencies` (`373b7f992f373e955dddf6fda6a7c735eb2b3740`,
árbol `aea9b1e1a8e2332147039dcede3ee0956f1762b5`): 39 migraciones anteriores,
última numerada 043. No modifica sus fuentes, ni Gateway, resolver, SDK o producción.
`ExternalSubjectResolver` sigue inyectado: todavía no consume estas tablas.
Los DTO siguientes describen filas nuevas, no una API que ya esté implementada.

La suite usa PostgreSQL real mediante los helpers canónicos; no emula SQL.
En el entorno de preparación no hay Docker ni PostgreSQL disponible: sus nueve casos
quedan pendientes, con salto explícito. Compilar o recolectar la suite no acredita los
constraints ni un pase de PostgreSQL. Se requiere ejecución sobre el commit publicado
antes de integrar o desplegar.

## DTO de esquema

- `human_external_identities`: `id` UUID, `human_id` UUID → `console_users.id`,
  `provider` (`oauth` o `telegram`), `namespace` texto exacto (1–1024 bytes),
  `subject` texto opaco (1–512 bytes), `enabled` booleano, `revision` bigint positivo,
  `revoked_at` timestamp nullable y `created_at` timestamp. No incluye correo,
  contraseña, token ni claims completos. `namespace` y `subject` tienen colación C.
  OAuth usa issuer verificado exacto, sin normalizar barra/caso; Telegram usa namespace
  del bot autorizado y user_id positivo decimal canónico (hasta 20 dígitos), nunca
  username o chat. El proveedor y la procedencia se verifican fuera del DDL.
- `human_tenant_memberships`: `human_id`, `tenant_id` y `actor_alias`, `role`
  (`operator` o `reader`), `permissions` array de `route/read/control/notify`,
  `enabled`, `revision`, `revoked_at`, `created_at`. PK `(human_id,tenant_id)`:
  un alias técnico vigente por humano/tenant; distintos humanos pueden compartirlo.
  FK `(tenant_id,actor_alias)` a `agents`. Reader sólo admite `read` o conjunto vacío;
  no admite elementos NULL. Alias/rol/permisos pueden cambiar; UUID/tenant/created_at no.
- `human_message_initiators`: `message_id`, `message_tenant_id`,
  `initiating_human_id`, `initiating_tenant_id`, `root_message_id`, `conversation_id`
  exacta (1–512 bytes), `created_at`. `root_anchor_id` es columna generada igual a
  `root_message_id`, sólo soporte de la FK; no se envía en INSERT ni DTO externo.
  Cada fila es inmutable. Ausencia significa identidad desconocida, no inferible.

Bigint se lee habitualmente como string con `pg`; no convertir revisiones a Number
sin controlar precisión. Los timestamps se leen según el parser de `pg` del servicio.

## Integridad y adopción

La unicidad `(provider,namespace,subject)` incluye vínculos revocados. Ni la clave
externa, ni su UUID local, ni su id se reasignan; DELETE de filas humanas se rechaza.
Revocar conserva las filas y exige `enabled=false` con `revoked_at` no nulo; restaurar
exige el inverso. Los triggers cubren DML ordinario, no convierten al propietario de la
BD en un actor restringido: privilegios DDL/TRUNCATE y mantenimiento son del dueño.

La FK de iniciador liga mensaje y tenant reales. Su FK compuesta apunta a una fila
cuyo `message_id = root_message_id`, con el mismo humano, tenant iniciador y conversación.
Esto excluye usar un descendiente como raíz y mezclar conversaciones. La raíz se
inserta apuntando a sí misma y debe pertenecer al tenant iniciador. Un descendiente
puede pertenecer a otro tenant sin crear membresía humana allí. Esa procedencia no
concede permisos ni valida por sí sola la topología completa de fan-in/fan-out:
el servicio deriva raíz/conversación desde lineage durable, nunca del modelo/body.

`revision > 0` no fuerza CAS, incremento ni auditoría automática. Administración debe
actualizar con `WHERE revision=$expected`, incrementar revisión y auditar actor,
motivo y antes/después en la misma transacción; cero filas es conflicto. La suite
comprueba guardado/stale secuencial y que una actualización sin CAS sigue siendo
posible. No la presenta como ensayo de carreras concurrentes.

Permisos efectivos futuros: cuenta activa y rol local ∩ membresía activa/rol/permisos
∩ scopes del token ∩ ACL, roles y capacidad actuales del alias. Un `console_users`
reader/inactive acota incluso una membresía operator. El selector tenant no concede
permisos. Las FK admiten referencia histórica a membresías revocadas; no autorizan
nuevas publicaciones. Resolver y autorización deben releer sin cachear autoridad,
bloquear cuenta → binding → membresía → ACL en orden estable y guardar mensaje,
iniciador, entregas, autor auditado y recibo en la misma transacción.

Quedan fuera: implementación del resolver, owned readmodel, privacidad de recibos
A/B, revocación transaccional publish/revoke, OAuth/JWKS real, negociación SDK y
proyección human-mcp. La prueba de rollback de mensaje+iniciador demuestra sólo
atomicidad SQL dentro de su transacción de prueba, no la adopción del publisher.

## Backfill, aplicación y down

El runner canónico administra la transacción y el ledger SHA; los SQL no llevan
BEGIN/COMMIT propios. El up bloquea escrituras de `console_users` y `agents` durante
preflight/backfill. Si falta un alias, falla con IDs/tenant/alias en DETAIL y exige
reparación explícita. No crea agentes ni omite cuentas. El diagnóstico se maneja como
dato operativo privado, no como respuesta pública.

Backfill de todas las cuentas existentes: tenant/alias/rol legacy y permisos del rol
actual; inactive queda disabled con marca de revocación de la migración (no pretende
reconstruir la fecha original). Las columnas legacy no cambian. No se crean vínculos
externos inferidos ni iniciadores para mensajes históricos. No hay sincronización
posterior automática entre tablas: el servicio deberá administrar ese ciclo de vida.

Down sigue `packages/store/migrations/down/044_human_mcp_identity.sql`. Se ejecuta
sólo bajo transacción del llamador y bloquea las tablas humanas. Rechaza migraciones
posteriores y cualquier registro humano, incluidos memberships del backfill; por eso
NO es un rollback destructivo disponible tras poblar identidad. Se conserva esquema
y se retira código ante rollback runtime; cualquier retirada de datos requiere un
plan explícito del dueño. No borrar filas ni vaciar tablas para forzar este down.
Sólo elimina tablas/función/índice nuevos y las dos entradas de ledger de 044;
sin CASCADE, sin alterar datos baseline. Los tests vacíos hacen down/up y rollback
transaccional dentro de su propia BD efímera.

## Validación requerida

Ejecutar desde la raíz del checkout con dependencias del lock:

```sh
pnpm exec vitest run tests/integration/human-mcp-identity-postgres.test.ts
```

Con Docker disponible, `CAUCE_REQUIRE_TESTCONTAINERS=1` exige contenedor real y evita
aceptar fallback/salto como pase. Alternativa existente: `CAUCE_TEST_DATABASE_URL`
con nombre prefijado `cauce_test`; el helper crea su BD efímera. Nunca usar URL productiva.
La suite no instala PostgreSQL ni modifica helpers compartidos.

Cobertura preparada: runner repetido/ledger exacto; down/up/rollback; inactive y roles;
preflight negativo y rollback del runner+ledgers; identidad externa exacta y preservada;
UUID A/B con mismo alias y dos tenants; permisos y FK; CAS explícito; raíz canónica,
conversación, descendientes cross-tenant e inmutabilidad; rollback mensaje+iniciador.
Los gates generales y la revisión independiente siguen siendo necesarios.
