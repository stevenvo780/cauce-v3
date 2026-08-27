-- Rol declarado por alias, inyectado en cada entrega por el adaptador.
--
-- POR QUÉ EN LA BASE Y NO EN UN ARCHIVO (medido el 2026-07-29 sobre las 35 superficies que la
-- flota carga de verdad):
--
--   * `kratos`, `atlas` e `iza` comparten el contenedor `ws-humanizar` y el mismo $HOME. Lo que se
--     escriba en /home/dev/.codex/AGENTS.md es EL MISMO INODE para kratos y atlas: es físicamente
--     imposible darles roles distintos por archivo.
--   * `kant`, `socrates`, `kratos`, `atlas` y `salva` leen el mismo AGENTS.md (md5 41512de6) por
--     bind o symlink. Cinco alias, cinco roles, un archivo.
--   * `zeus` y `argos` leen el mismo CLAUDE.md (md5 14aa0c21), byte a byte.
--   * `iza` corre hermes, cuyo bridge sólo lee stdin: no monta ningún archivo de instrucciones. Su
--     único archivo de persona era la plantilla de fábrica del proveedor ("You are Hermes Agent,
--     created by Nous Research") y vive en la capa de escritura del contenedor.
--   * En los agv2-* (hegel, midas, seneca) sólo .openclaw y clawd están montados: lo que se escriba
--     en ~/.codex o ~/.claude se pierde al recrear.
--
-- La consecuencia medida de ese reparto: 9 de 15 alias tienen escrito que su rol es ORQUESTAR y
-- delegar, y ninguno recibe "esto es tuyo, resolvelo". Los 6 alias con un rol propio y concreto
-- escrito tienen ratio delegación/respuesta <= 0,16; argos —que no tiene identidad en ninguna
-- parte— tiene 9,38 (1069 delegaciones contra 114 respuestas, 717 de 1327 entregas muertas).
--
-- protocolPrompt() no tiene ninguno de esos problemas: es alias-consciente por construcción, la
-- usan los cinco harnesses por igual y no depende de qué monta cada contenedor. Esta columna es lo
-- único que le falta para poder decir "sos X y tu trabajo es Y".
--
-- NULL = sin rol declarado. El adaptador omite la línea `Tu rol:` en vez de inventar una: un rol
-- equivocado es peor que ninguno, que es exactamente la lección del SOUL.md de iza.
--
-- Aditiva y sin reescritura de tabla: una columna nullable sin default es una operación de
-- catálogo. El CHECK nace NOT VALID por el mismo criterio que 008 y 019 — toda fila existente ya
-- lo satisface (role_brief IS NULL) y así se evita el escaneo completo bajo ACCESS EXCLUSIVE
-- dentro de la única transacción que aplica todas las migraciones.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS role_brief text;

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_role_brief_len;

-- El techo de 1200 no es estético: el preámbulo viaja en CADA entrega de CADA alias, y el sobre
-- de la entrega lo valida un esquema estricto. 1200 caracteres son ~300 tokens, suficiente para
-- "quién sos / qué es tuyo / qué NO hacés" y lo bastante chico para no competir con el trabajo.
--
-- ESTE número es el que MANDA, y esta es la única de las cuatro capas que no puede importarlo:
-- SQL no importa TypeScript. Las otras tres lo comparten como `ROLE_BRIEF_MAX_CODE_POINTS` en
-- packages/protocol/src/schemas.ts (esquema del sobre, store y adapter-sdk). Si se cambia acá,
-- se cambia allá en el mismo lote — y al revés no: esta columna sólo se mueve con migración.
--
-- La unidad es `char_length`, o sea PUNTOS DE CÓDIGO, no unidades UTF-16. Un emoji fuera del BMP
-- vale 1 acá y 2 para `String.length` de JS. Toda capa que cuente en UTF-16 abre una franja donde
-- el brief se guarda pero el sobre de la entrega se rechaza entero y el alias queda SORDO.
ALTER TABLE agents
  ADD CONSTRAINT agents_role_brief_len CHECK (
    role_brief IS NULL OR char_length(role_brief) BETWEEN 1 AND 1200
  ) NOT VALID;
