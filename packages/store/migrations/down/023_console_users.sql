-- Reversa de 023_console_users.sql
--
-- El runner (applyMigrations en packages/store/src/db.ts) NO lee este directorio: aplica en
-- orden alfabético los .sql de migrations/ e indexa por nombre de archivo. Esto se corre a mano.
--
-- ANTES DE CORRERLO: bajar la tabla BORRA todas las cuentas humanas de la consola y no hay forma
-- de recuperarlas desde la base (los hashes no se pueden regenerar: hay que volver a fijar cada
-- contraseña). Casi siempre lo que se quiere es una de estas dos, que no tocan el esquema:
--
--   -- cerrarle la puerta a una persona, ya, sin esperar a que le venza el token:
--   UPDATE console_users SET active=false, updated_at=now() WHERE email_normalized='<correo>';
--
--   -- cerrar TODAS las sesiones abiertas sin borrar a nadie (los JWT anteriores dejan de valer):
--   UPDATE console_users SET password_changed_at=now(), updated_at=now();
--
-- Bajar la tabla sólo tiene sentido si hay que retroceder la IMAGEN del gateway a una anterior
-- a 022 Y además se decidió abandonar el login por contraseña. Exportar primero:
--
--   \copy (SELECT id,email,display_name,role,tenant_id,alias,active FROM console_users) TO 'console-users-backup.csv' CSV HEADER

BEGIN;

DROP INDEX IF EXISTS console_users_active_idx;
DROP INDEX IF EXISTS console_users_email_normalized_key;
DROP TABLE IF EXISTS console_users;

DELETE FROM schema_migrations WHERE version='023_console_users.sql';

COMMIT;
