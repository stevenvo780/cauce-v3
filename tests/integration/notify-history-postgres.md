# Historial notify: integración con PostgreSQL y Fastify

Este arnés vive sólo en tests/integration. Importa gateway, store y SDK desde los tests; no agrega dependencias runtime entre esos paquetes ni modifica el consumidor.

## Precondiciones

- Checkout que contenga, por ascendencia, d374e476 → 7a435600 → 9b96569d. El arnés comprueba esa cadena antes de crear la base. Este paquete se preparó sobre d374e476 porque los dos commits posteriores no están disponibles en el remoto accesible; requiere validar su ejecución sobre la cadena completa.
- Un servidor PostgreSQL DE PRUEBAS ya disponible y una URL explícita en CAUCE_TEST_DATABASE_URL, con base cauce_test o cauce_test_*. No se lee DATABASE_URL ni archivos de credenciales.
- El usuario de pruebas debe poder crear su base temporal y aplicar las migraciones existentes. El arnés no concede privilegios, cambia IAM, crea roles ni inicia contenedores/servicios.
- Dependencias del monorepo instaladas.

## Ejecución acotada

```sh
pnpm exec vitest run tests/integration/notify-history-postgres.test.ts --reporter=verbose
```

Hay ocho casos. Si falta PostgreSQL de pruebas, el beforeAll falla expresamente: cero pruebas ejecutadas y casos saltados; eso NO acredita E2E. No hay fallback a pg-mem, SQLite, respuestas HTTP prefabricadas ni dobles del repositorio.

El arnés abre PostgreSQL mediante @cauce/store.createPool (pg.Pool), comprueba version() y current_database(), crea una base nueva cauce_test_notify_<uuid> y aplica las migraciones reales allí. No resetea la base proporcionada, no reutiliza plantillas, no barre otras bases y no trunca tablas de terceros. Si faltan permisos o schema, el error se conserva.

## Recorrido y controles

El Fastify real escucha en 127.0.0.1 y puerto efímero. registerAgentEmissionRoutes recibe un CauceRepository real sobre ese pool. Su consulta listAgentEgress y la derivación de estados se ejecutan en el código productivo. El SDK usa emissionGateway sobre HTTP hacia ese Fastify, su HttpEgressReceiptSource, el engine y el selector hasta protocolPrompt. Un hook observa solicitudes, sin sustituirlas.

La autenticación usa DevOnlyAuthProvider.forTests y los memberships sembrados por las migraciones en la base recién creada. El harness del modelo es ControlledRunner: sólo registra el prompt y devuelve una salida inocua; no ejecuta LLM, herramientas, notificaciones ni sesiones reales. Estos dos sustitutos de prueba NO reemplazan Fastify, SQL, la derivación ni el lector HTTP.

Los fixtures insertan filas sintéticas representativas de fuente, notificación, outbox y efectos. El caso c137560e-ca62-46b2-89bb-b59947953547 tiene un aviso, origin SQL NULL y recibo completo hacia conversación6979524541/provider2703. No son filas extraídas de producción ni prueba del evento histórico original. El parcial tiene un fragmento enviado de tres y otra notificación con destino distinto.

Se comprueban: completo sin origen humano; partial/1-de-3 sin atribuir sent; separación de notificaciones/destinos; aislamiento alias, tenant y conversación; otro intento del inbox; historial como datos y no autorización. El caso completo recupera el historial local tras archivo y reinicio. La salida NOTIFY_E2E_RUNTIME identifica driver, ruta, store y sustitutos de prueba sólo cuando hubo conexión real y registro de la ruta.

## Reversa

El teardown cierra el Fastify y los pools propios y elimina exclusivamente la base temporal creada por esta corrida, sin FORCE ni terminación de conexiones ajenas. Si no puede eliminarla, falla y conserva el nombre para limpieza posterior autorizada. Eliminar el arnés significa retirar sólo este Markdown, notify-history-postgres.test.ts y los tres helpers de notify-history/. No modifica ramas, checkout ajenos, SDK, gateway, store ni migraciones.
