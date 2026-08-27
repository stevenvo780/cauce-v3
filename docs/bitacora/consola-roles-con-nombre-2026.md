# Roles de agente CON NOMBRE — plan de la tabla que falta

**Estado: PENDIENTE, no implementado.** Este documento es el plan exacto, no un resumen de algo
hecho. Lo que sí está entregado es la pestaña «Roles de agente» de `/config`, que hoy trabaja
sobre lo único que el servidor tiene: la columna `agents.role_brief`.

## 1. El pedido y lo que hay

El pedido, literal: «poder crear roles como *orquestador*, *constructor*, *operador* y poder
cambiarlos entre agentes fácilmente».

Lo que el servidor tiene hoy, medido buscando el EFECTO y no el nombre — un `role_template` /
`role_templates` en `packages/protocol/src/schemas.ts`, en `packages/store/src/configuration.ts` y
en el snapshot de `GET /v3/console/config`: **cero coincidencias**:

- `agents.role_brief`, columna `text` nullable con el CHECK `agents_role_brief_len`
  (`char_length` entre 1 y 1200), creada por
  `packages/store/migrations/020_agent_role_brief.sql`.
- Ese texto viaja en el sobre de cada entrega y el adaptador lo antepone al contrato como la línea
  `Tu rol: …` (`packages/adapter-sdk/src/harnesses/shared.ts:136`).
- Se escribe con la mutación versionada
  `{ resource: 'agent', action: 'update', tenant_id, alias, value: { role_brief } }`, que deja su
  inversa en `config_revisions` (`configuration.ts`, método `agent()`).

O sea: **hay un texto por alias y no hay ningún sitio donde guardar el nombre del rol.** Un rol,
hoy, se identifica por su propio texto y por quiénes lo llevan. Eso es exactamente lo que la
pestaña entregada muestra, y por eso dice con todas las letras que el título de cada tarjeta es un
resumen de la primera línea y **no** un nombre guardado: un título que parece un nombre y no lo es
manda al operador a buscarlo en una base donde no está.

Lo que la pestaña entregada YA resuelve sin inventar nada:

- catálogo de roles en uso, agrupados por texto recortado (el store recorta antes de guardar, así
  que dos briefs que sólo difieren en un salto de línea final son el mismo rol para el servidor);
- quién lleva cada uno, y qué bots están sin rol declarado;
- **aplicar el mismo rol a otro bot** por la mutación versionada de siempre — la mitad cara del
  pedido, con marcha atrás desde «Historial y JSON»;
- medidor en las **dos** unidades (puntos de código y unidades UTF-16) y bloqueo del botón cuando
  cualquiera de las dos se pasa de 1200. No es un adorno: la base cuenta puntos de código y el
  esquema del adaptador desplegado cuenta UTF-16, así que un rol de 1150 emojis mide 1150 para
  Postgres y 2300 para el sobre — se guardaría «bien» y el alias quedaría **sordo sin un solo
  error a la vista**.

Lo que NO se hizo, a propósito:

- guardar el nombre en `localStorage`: sería una fuente de verdad más sobre la flota —van catorce—
  y sólo existiría en el ordenador de un operador;
- esconder un marcador `# orquestador` dentro del propio `role_brief`: gastaría cupo de los 1200 y
  cambiaría el texto que el adaptador antepone al contrato del bot.

El nombre con letras necesita una tabla. Lo que sigue es esa tabla.

## 2. Migración `024_agent_role_templates.sql`

`022` no existe en el árbol (la serie salta de `021` a `023`), así que **el número libre es 024**.
Se numera 024 y no 022: el runner de `packages/store/src/db.ts` aplica por orden de nombre de
fichero y registra cada uno en `schema_migrations`, de modo que rellenar un hueco pasado es
indistinguible de una migración nueva para un despliegue viejo pero confuso para el humano que lee
la serie.

```sql
-- Plantillas de rol con NOMBRE, y qué alias lleva cuál.
--
-- La columna agents.role_brief (migración 020) sigue siendo la fuente de verdad de lo que el
-- adaptador antepone al contrato: esta tabla NO la reemplaza, le pone nombre y la deja
-- reutilizable. Un alias sin plantilla asignada conserva su role_brief tal cual; una plantilla
-- borrada no toca el texto de nadie.

CREATE TABLE IF NOT EXISTS role_templates (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  role_brief    text NOT NULL,
  description   text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- El id es el nombre en minúsculas y sin espacios («orquestador», «constructor», «operador»), con
-- el MISMO regex que ya usan harness_id y provider_accounts.id en el protocolo: un identificador
-- nuevo con otra forma es un sitio más donde equivocarse.
ALTER TABLE role_templates
  DROP CONSTRAINT IF EXISTS role_templates_id_shape;
ALTER TABLE role_templates
  ADD CONSTRAINT role_templates_id_shape CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$') NOT VALID;

-- El MISMO tope y la MISMA unidad que agents_role_brief_len. Si esta tabla admitiera un texto que
-- la columna de destino rechaza, «aplicar la plantilla» fallaría recién al escribir el agente, con
-- la plantilla ya guardada y el operador convencido de que existe un rol utilizable.
ALTER TABLE role_templates
  DROP CONSTRAINT IF EXISTS role_templates_brief_len;
ALTER TABLE role_templates
  ADD CONSTRAINT role_templates_brief_len
  CHECK (char_length(role_brief) BETWEEN 1 AND 1200) NOT VALID;

ALTER TABLE role_templates
  DROP CONSTRAINT IF EXISTS role_templates_display_name_len;
ALTER TABLE role_templates
  ADD CONSTRAINT role_templates_display_name_len
  CHECK (char_length(display_name) BETWEEN 1 AND 120) NOT VALID;

-- Qué alias lleva qué plantilla. Es una anotación, no la fuente del texto: se guarda para poder
-- responder «quién lleva el rol orquestador» sin comparar 1200 caracteres, y para avisar cuando el
-- role_brief del alias se editó a mano y ya no coincide con la plantilla que dice llevar.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS role_template_id text;

-- ON DELETE SET NULL y no CASCADE: borrar la plantilla «orquestador» NO puede borrar a zeus.
-- El alias se queda con su role_brief intacto y sin plantilla declarada, que es la verdad.
ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_role_template_fk;
ALTER TABLE agents
  ADD CONSTRAINT agents_role_template_fk
  FOREIGN KEY (role_template_id) REFERENCES role_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agents_role_template_idx
  ON agents(role_template_id) WHERE role_template_id IS NOT NULL;
```

Y su inversa en `packages/store/migrations/down/024_agent_role_templates.sql`, siguiendo la convención
del directorio `down/`: `ALTER TABLE agents DROP COLUMN IF EXISTS role_template_id;` y
`DROP TABLE IF EXISTS role_templates;`.

**Todos los CHECK nacen `NOT VALID`**, por el mismo criterio que 008, 019 y 020: toda fila
existente ya los satisface (la tabla nace vacía, `role_template_id` nace NULL) y así se evita el
escaneo completo bajo `ACCESS EXCLUSIVE` dentro de la única transacción que aplica todas las
migraciones.

**No hay backfill.** Agrupar los `role_brief` que ya existen e inventarles un nombre sería ponerle
a la flota catorce etiquetas que nadie escribió. Las plantillas se crean a mano, desde la pestaña.

## 3. Protocolo — `packages/protocol/src/schemas.ts`

Un recurso de configuración nuevo, con la forma de los once que ya hay:

```ts
export const RoleTemplateIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const RoleTemplateConfigMutationSchema = z.object({
  resource: z.literal('role_template'), action: ConfigActionSchema, id: RoleTemplateIdSchema,
  value: z.object({
    display_name: z.string().trim().min(1).max(120).optional(),
    // countCodePoints y NO .max(): el .max() de zod cuenta unidades UTF-16 y la columna cuenta
    // puntos de código. Es la misma trampa que ya está documentada para role_brief.
    role_brief: z.string()
      .refine((text) => countCodePoints(text) <= ROLE_BRIEF_MAX_CODE_POINTS,
        { message: 'role_brief is too long' })
      .optional(),
    description: z.string().trim().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  }).strict().optional(),
}).strict();
```

y se suma al `z.discriminatedUnion('resource', [...])` de `ConfigMutationSchema` (línea 626).

En `AgentConfigMutationSchema` (línea 562) se agrega al `value`:

```ts
    role_template_id: RoleTemplateIdSchema.nullable().optional(),
```

**Regla dura, y es la decisión de diseño que hay que respetar:** `role_brief` sigue siendo la única
fuente de lo que el adaptador manda. Asignar una plantilla a un alias **copia** su `role_brief` a
`agents.role_brief` y además anota `role_template_id`. No se resuelve por JOIN en el momento de
armar el sobre. Motivo medido: si el texto se resolviera al vuelo, editar la plantilla
«orquestador» cambiaría en silencio la identidad de nueve alias a la vez, sin una revisión por
alias en `config_revisions` y sin forma de deshacerlo por alias — exactamente la clase de cambio
sin marcha atrás que el resto de esta pantalla evita.

## 4. Store — `packages/store/src/configuration.ts`

1. **Snapshot** (método que arma `GET /v3/console/config`, ~línea 226): una consulta más,
   ```sql
   SELECT id,display_name,role_brief,description,enabled,created_at,updated_at
   FROM role_templates ORDER BY id
   ```
   publicada como `role_templates` en el objeto de retorno (junto a `agents`, línea 232). Es
   **global**, no se filtra por `scope`: una plantilla no es de un tenant, igual que
   `harness_definitions` y `role_policies`.
   Y `agents` suma `role_template_id` a su `SELECT`.

2. **`execute()`** (~línea 385): un `if (mutation.resource === 'role_template') return
   this.roleTemplate(client, mutation);` antes del `return this.policy(...)` final.

3. **`roleTemplate()`**, con la misma disciplina que `agent()`:
   - `SELECT … FOR UPDATE` de la fila entera **antes** de escribir, porque `oldValue` es lo único
     de lo que sale la mutación inversa;
   - `create` sobre id existente → `ConfigurationError('conflict', 'role template already exists')`;
   - `update` sobre id ausente → `ConfigurationError('not_found', …)`;
   - `delete` con alias que la declaran → **`conflict`**, no borrado silencioso:
     `SELECT 1 FROM agents WHERE role_template_id=$1 LIMIT 1`. El `ON DELETE SET NULL` de la FK es
     el cinturón; este chequeo es el tirante, y es el que puede explicar el motivo.
   - `role_brief` pasa por `normalizeRoleBrief()`, el mismo que usa `agent()`.

4. **`authorizeMutation()`** (línea 350): `role_template` **no** se agrega a ninguna de las ramas
   de tenant. Cae por el *default-deny* del final, o sea queda **hub-only**, por el mismo criterio
   escrito ahí para los recursos del registro: una plantilla de identidad es una decisión sobre
   toda la flota, no sobre un cliente. Que quede por caída y no por regla es deliberado — una regla
   la puede ablandar una edición futura; la caída no.

5. **`agent()`**: `role_template_id` entra en el `SELECT … FOR UPDATE`, en el `INSERT`, en el
   `UPDATE` y en el `oldValue` del que sale la inversa. Sin eso, un rollback devolvería el texto
   pero dejaría al alias diciendo que lleva una plantilla que ya no lleva.

## 5. Gateway — `services/gateway/src/app.ts`

**Ningún endpoint nuevo.** `POST /v3/console/config/changes` (línea 852) valida con
`ConfigMutationSchema` y delega en el store: al sumar el recurso al discriminated union queda
alcanzable, versionado y deshacible desde `POST /v3/console/config/revisions/:revisionId/rollback`
(línea 864) sin tocar una línea del servicio. El RBAC es el que ya hay (`config.write` +
`authorizeMutation`).

Un endpoint propio sería una segunda puerta de escritura fuera del audit trail; eso es justamente
lo que no se quiere.

## 6. Consola — la pestaña ya está, cambia de fuente

`apps/console/src/features/config/`:

- `areas.ts`: `role_templates: 'roles'` en `AREA_POR_COLECCION`, para que la colección cruda caiga
  en la pestaña «Roles de agente» y no en «Otros».
- `roles.ts`: `catalogoDeRoles()` pasa a recibir `(agents, roleTemplates)` y a devolver, para cada
  rol, su `id` y `display_name` cuando existan. **El fallback por texto NO se borra**: los alias
  que hoy tienen un `role_brief` a mano y ninguna plantilla se siguen viendo agrupados por texto.
  Borrar el fallback dejaría invisible a media flota el día del despliegue.
- `RolesPanel.tsx`: alta de plantilla (nombre + texto + descripción), edición, y el selector de
  destino que ya existe pasa a mandar
  `{ resource: 'agent', action: 'update', tenant_id, alias, value: { role_brief, role_template_id } }`.
- **Aviso de deriva**: si `agents.role_brief` de un alias no coincide con el `role_brief` de la
  plantilla que declara llevar, la tarjeta lo dice. Es el caso normal —alguien editó el texto de un
  alias a mano— y callarlo convertiría la etiqueta en una mentira.
- El medidor de dos unidades se reutiliza tal cual sobre el texto de la plantilla, y bloquea el
  alta igual que hoy bloquea la asignación.

`apps/console/src/api/types.ts`: `role_templates?: Array<Record<string, unknown>> | null` en
`ConfigurationSnapshot` (opcional, como las cuatro claves de la migración 010: clave ausente
significa «este gateway es anterior a la 024», que **no** es lo mismo que lista vacía), y
`'role_template'` en `AnyConfigResource`.

## 7. Validaciones y pruebas exigibles antes de dar esto por hecho

1. El tope se mide en **puntos de código** en las cuatro capas (SQL, protocolo, store, consola). Una
   prueba con 1150 emojis fuera del BMP: `char_length` = 1150, `String.length` = 2300. Si alguna
   capa cuenta UTF-16, el alias se queda sordo sin ningún error.
2. `delete` de una plantilla en uso devuelve `conflict` con el motivo, y **no** deja a ningún alias
   sin `role_brief`.
3. Rollback de la revisión que asignó una plantilla devuelve `role_brief` **y** `role_template_id`
   al valor anterior. Prueba de ida y vuelta contra la base real, no contra un mock.
4. Un gateway sin la migración 024 (snapshot sin la clave `role_templates`) sigue pintando la
   pestaña por texto, sin romperse y sin decir «no hay roles».
5. `authorizeMutation`: un tenant cliente con `config.write` en su propia sala recibe `forbidden` al
   mandar un `role_template`. Control negativo: el mismo caso desde el hub debe pasar.
6. Editar la plantilla **no** cambia el `role_brief` de ningún alias (§3): prueba explícita, porque
   es la decisión más fácil de revertir por comodidad y la que rompe la auditoría por alias.
