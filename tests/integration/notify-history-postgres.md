# Historial notify: integración con PostgreSQL y Fastify

Este arnés vive sólo en tests/integration. Importa gateway, store y SDK desde los tests; no agrega dependencias runtime entre esos paquetes ni modifica el consumidor.

## Precondiciones

- Checkout que contenga, por ascendencia, d374e476 → 7a435600 → 9b96569d. El arnés comprueba esa cadena antes de crear la base. Este paquete se preparó sobre d374e476 porque los dos commits posteriores no están disponibles en el remoto accesible; requiere validar su ejecución sobre la cadena completa.
- `CAUCE_TEST_DATABASE_URL` es opcional. Si se define, apunta a un servidor PostgreSQL de pruebas con una base `cauce_test` o `cauce_test_*`; no se lee `DATABASE_URL` ni archivos de credenciales. Si se omite, Testcontainers inicia `postgres:16-alpine` cuando Docker está disponible.
- En un servidor externo, el usuario de pruebas debe poder crear su base temporal y aplicar las migraciones existentes. El arnés no concede privilegios, cambia IAM ni crea roles.
- Dependencias del monorepo instaladas.

## Ejecución acotada

```sh
pnpm exec vitest run tests/integration/notify-history-postgres.test.ts --reporter=verbose
```

Hay ocho casos. Con una URL externa usa ese servidor para crear una base aislada; si se omite, intenta iniciar el contenedor propio. Si la URL definida es inválida o no puede abrirse, o si falta y Docker no está disponible, el `beforeAll` falla antes de ejecutar los casos: eso NO acredita E2E. No hay fallback a pg-mem, SQLite, respuestas HTTP prefabricadas ni dobles del repositorio.

El arnés abre PostgreSQL mediante `@cauce/store.createPool` (`pg.Pool`) y comprueba `version()` y `current_database()`. Con una URL externa crea `cauce_test_e_p<pid>_t<timestamp-base36>_<10 hex>`, clona la plantilla compartida y aplica allí las migraciones reales; antes intenta retirar bases `cauce_test_e*` de más de seis horas en ese servidor, sin que un fallo de limpieza aborte la creación. Sin URL externa, usa `cauce_test` dentro del contenedor propio y aplica las migraciones desde cero. No resetea la base indicada en la URL ni trunca tablas de terceros; si fallan la creación o las migraciones, el error se conserva.

## Recorrido y controles

El Fastify real escucha en 127.0.0.1 y puerto efímero. registerAgentEmissionRoutes recibe un CauceRepository real sobre ese pool. Su consulta listAgentEgress y la derivación de estados se ejecutan en el código productivo. El SDK usa emissionGateway sobre HTTP hacia ese Fastify, su HttpEgressReceiptSource, el engine y el selector hasta protocolPrompt. Un hook observa solicitudes, sin sustituirlas.

La autenticación usa DevOnlyAuthProvider.forTests y los memberships sembrados por las migraciones en la base recién creada. El harness del modelo es ControlledRunner: sólo registra el prompt y devuelve una salida inocua; no ejecuta LLM, herramientas, notificaciones ni sesiones reales. Estos dos sustitutos de prueba NO reemplazan Fastify, SQL, la derivación ni el lector HTTP.

Los fixtures insertan filas sintéticas representativas de fuente, notificación, outbox y efectos. El caso 00000000-0000-4000-8000-000000000301 tiene un aviso, origin SQL NULL y recibo completo hacia conversación42/provider101. No son filas extraídas de producción ni prueba del evento histórico original. El parcial tiene un fragmento enviado de tres y otra notificación con destino distinto.

Se comprueban: completo sin origen humano; partial/1-de-3 sin atribuir sent; separación de notificaciones/destinos; aislamiento alias, tenant y conversación; otro intento del inbox; historial como datos y no autorización. El caso completo recupera el historial local tras archivo y reinicio. La salida NOTIFY_E2E_RUNTIME identifica driver, ruta, store y sustitutos de prueba sólo cuando hubo conexión real y registro de la ruta.

## Reversa

El teardown cierra Fastify y los pools. En el servidor externo intenta eliminar la base de esta corrida con `DROP DATABASE ... WITH (FORCE)`, que termina las conexiones abiertas a esa base; si falla, absorbe el error y la base puede quedar hasta un barrido posterior por antigüedad. El contenedor propio se detiene al cerrar la suite. Eliminar el arnés significa retirar sólo este Markdown, notify-history-postgres.test.ts y los tres helpers de notify-history/. No modifica ramas, checkout ajenos, SDK, gateway, store ni migraciones.
