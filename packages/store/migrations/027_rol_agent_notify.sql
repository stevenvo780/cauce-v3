-- El rol `agent_notify` existe en PRODUCCIÓN y ninguna migración lo crea.
--
-- Medido el 2026-08-25 contra la base de producción:
--
--   role          | allow_route | allow_read | allow_control | allow_notify
--   agent         | t           | t          | f             | true
--   agent_notify  | t           | t          | f             | true      <-- éste
--   operator      | t           | t          | t             | true
--   adapter       | t           | t          | f             | false
--
--   memberships por rol:  agent 13 · agent_notify 3 · operator 3
--
-- O sea: TRES alias de la flota dependen de un rol que sólo existe porque alguien lo insertó a
-- mano. La migración 009 lo NOMBRA en dos comentarios (`role_policy create {role:'agent_notify',
-- allow_notify:true, ...}`) como el procedimiento que un operador debería seguir, pero no lo
-- ejecuta. Nadie más lo crea: `grep` sobre todas las migraciones sólo encuentra esos comentarios.
--
-- POR QUÉ IMPORTA, y no es una cuestión de orden:
--
--   1. Una base reconstruida desde las migraciones —un entorno nuevo, una recuperación, una
--      prueba de integración honesta— NO tiene ese rol. Las membresías de esos tres alias no
--      pueden existir (`memberships.role` tiene clave foránea contra `role_policies`), así que
--      o la restauración falla o esos tres alias entran degradados y sin poder avisar a un
--      humano. El fallo aparecería en el peor momento posible: durante una recuperación.
--   2. Las pruebas del repo llegaron a depender de él sin saberlo. Existía en la base compartida
--      porque otra suite lo había insertado, así que una prueba pasaba o fallaba según qué
--      corriera antes. Esa es una de las dos causas de que el mismo código diera 6, 18 o 19
--      fallos según el orden (la otra, la falta de restauración del catálogo, va aparte).
--
-- `allow_notify` ya existe como columna desde la 009; esto añade la FILA que falta con el contrato
-- exacto medido. Una fila preexistente NO se acepta sólo por llamarse igual: hay memberships vivas
-- con este rol, por lo que cualquiera de sus cuatro permisos divergente cambiaría autoridad sin que
-- la paridad lo viera. El lock de fila mantiene la comprobación estable hasta el commit de la
-- transacción de migraciones.

INSERT INTO role_policies(role, allow_route, allow_read, allow_control, allow_notify)
VALUES ('agent_notify', true, true, false, true)
ON CONFLICT (role) DO NOTHING;

DO $$
BEGIN
  PERFORM 1 FROM role_policies WHERE role='agent_notify' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '027 failed to create the agent_notify role policy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM role_policies
     WHERE role='agent_notify'
       AND ROW(allow_route,allow_read,allow_control,allow_notify)
           IS DISTINCT FROM ROW(true,true,false,true)
  ) THEN
    RAISE EXCEPTION '027 refuses divergent agent_notify role policy';
  END IF;
END $$;
