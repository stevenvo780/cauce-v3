# Integración de autenticación y runtime

La autenticación de Mis cuotas reutiliza la terminal restringida existente, transportada por identidad de host Ed25519. Consentimiento, origen humano, empresa, entorno, claim y epoch se revalidan; el login se detiene antes de verificar identidad remota y el proveedor. El resultado público no guarda el flujo privado de terminal ni identidad remota sin hash.

Evidencia local sobre el árbol WIP, sin aceptación de proveedor real:

- `root-regression-ola4.log`: cinco suites, 60/60 PASS; incluye administración, sesiones y executor.
- `signed-transport-ola4.log`: 7/7 PASS; transporte roto distinguido de rechazo HTTP/JSON.
- `root-auth-signed-ola4.log`: autenticación 4/4 PASS, fallo de verificación termina durable failed sin requeue. Canal 7/8 por una petición de prueba con campo extra; conserva el fallo.
- La corrección de la petición estricta se revalidó junto con capacidades: cuotas/canal 12/12 PASS en el reporte de Task2. Recibo repetido admite nonce nuevo con mismo efecto/fence sin nueva versión ni muestra; rechaza otro scope, receipt alterado y fail sobre done.
- Typecheck/lint global de la ola conservan los errores de backup WIP, ya comunicados a su escritor; no se acreditan gates globales del SHA final.

Se corrigen imports runtime de contexto para consumir el paquete store publicado, se incorpora dist/descriptors al SDK de la imagen y se conectan rutas/worker de backup al gateway y executor existentes. La imagen recibe Git/SSH para el broker central y dos helpers cerrados de verificación de ZIP. Estos cambios de empaquetado requieren build y smoke real aún pendientes.

La API de sesión publica home_tenant explícito: subject sigue siendo correo, nunca una fuente de autoridad o pertenencia. El campo Session.stopped sin consumidores se elimina; las pruebas stopped del proceso continúan siendo obligatorias.

No se migró ningún agente ni se desplegó esta etapa. El repositorio privado de contextos sólo tiene el ensayo GitHub sintético registrado antes; faltan contextos reales y consumo en agentes.

## Revisión de cierre de autenticación

La selección de empresa del cookie firmado se conserva en el actor, la reserva, la sesión privada y el socket. La autoridad durable recibe esa selección y exige que coincida con la empresa del objetivo. El administrador de plataforma no puede usar la sesión seleccionada de otra empresa para abrir o verificar un login ajeno.

El host vuelve a comprobar abort y TTL después de la última lectura asíncrona y antes de persistir la verificación; drena la renovación pendiente y mantiene una sola renovación en vuelo. El apagado y un fence perdido impiden guardar el resultado tardío.

`auth-selected-company-regression-2.log`: seis archivos, **55/55 PASS**, incluye PostgreSQL con runtime role y pruebas diferidas de apagado/renovación. La fixture antigua ahora concede explícitamente el rol company_admin con el pool administrativo; no se relajaron permisos del runtime. `integrated-types-recovery-3.log`: typecheck global exit0. Lint global y matriz completa seguían en ejecución al guardar esta etapa.

El broker VPS ya posee deploy key limitada al repositorio privado de contextos y una lectura autenticada real de main. No acredita todavía contextos reales ni consumo por los agentes, ni autenticación de un proveedor nuevo.

## Autenticación de agentes en ordenadores enrolados

El gateway comparte una instancia de `AgentProviderAuthBroker` entre el servicio de consola y el endpoint firmado `POST /v3/fleet/hosts/:host_id/agent-auth`. Sólo se instala el servicio de consola con autenticación humana por contraseña; los modos mTLS, token y OIDC conservan su arranque. La selección usa primero el catálogo explícito de hosts, después la identidad durable enrolada y finalmente el socket legacy cuando corresponde. Una identidad enrolada deshabilitada no cae al servicio legacy.

El consumidor del ordenador necesita `CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`: una política privada y pinneada con los perfiles, plantillas y comandos admitidos por el executor. El archivo usa el contrato existente de autenticación; no contiene sesiones ni tokens de proveedor. Las reservas y cada efecto conservan empresa seleccionada, actor, cuenta, host, hash y epoch. Un reinicio no acredita un login terminado: el cierre debe confirmar que el PTY y sus procesos se detuvieron, y la verificación posterior debe confirmar la cuenta correspondiente.

Las pruebas con PTY nativa y un CLI sintético acreditan el transporte, la cancelación y los fences. La autenticación de las cuentas reales y el consumo por los agentes migrados requieren su propia verificación publicada.

## Autoridad central de credenciales para ordenadores enrolados

El endpoint `POST /v3/fleet/hosts/:host_id/authority` transporta íntegro el sobre firmado del ordenador a un enclave central por socket Unix. El enclave valida identidad, empresa, nonce, operación, claim y epoch antes de usar el emisor existente. La emisión utiliza la misma transacción de validación del host. La clave privada de la CA permanece en el enclave; el gateway sólo accede al socket.

El gateway se configura mediante `CAUCE_FLEET_AUTHORITY_SOCKET`, `CAUCE_FLEET_AUTHORITY_OWNER_UID`, `CAUCE_FLEET_AUTHORITY_PEER_UID` y, cuando los UID difieren, `CAUCE_FLEET_AUTHORITY_GROUP_GID`. El socket requiere directorio 0750 y socket 0660 con el grupo aprobado cuando se comparte; con un único UID exige 0700 y 0600. La comprobación incluye propietario y credenciales del proceso conectado. Una configuración parcial impide el arranque.

La entrada `services/gateway/dist/fleet/authority/signed-main.js` usa además `CAUCE_FLEET_AUTHORITY_COMMAND_FILE` y `CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE`, ambos archivos privados. El executor remoto selecciona autoridad con `{identity_directory,host_id,ca_certificate}` y usa HTTPS firmado. La acción cerrada `ready` verifica el emisor pinneado, su política y el par CA/clave sin emitir credenciales. Las capacidades de creación dependen de esta disponibilidad real; la lectura de cuotas conserva sus capacidades independientes. La instalación física y la emisión desde un ordenador de destino siguen pendientes de los gates del código final.
