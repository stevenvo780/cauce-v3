# Autenticación de proveedores en hosts V4

## Flujo desde la consola

`AgentProviderAuthBroker` liga el consentimiento humano, la empresa seleccionada, la cuenta, el perfil, el host y la operación durable. El gateway valida esos datos y el fence antes de enviar comandos al host enrolado mediante `POST /v3/fleet/hosts/:host_id/agent-auth`. El estado de autenticación solo se acepta si la identidad del proveedor coincide y pasa una llamada funcional de verificación.

El host ejecuta únicamente los comandos fijados por una política privada indicada en `CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`. La política debe corresponder a la identidad del ordenador y fija perfiles, plantillas y ejecutables permitidos; el host vuelve a comprobar los fences durante el login, la verificación y la limpieza. Una sesión pendiente o un proceso detenido no acreditan autenticación.

## Verificación de identidad

- **Grok:** usa un perfil dedicado mediante `GROK_HOME` y el comando `login --device-auth`. El verificador consulta `https://auth.x.ai/oauth2/userinfo` con el token activo y exige que la identidad remota coincida; luego requiere la respuesta al nonce de prueba.
- **Muse:** usa `login`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` y `MUSE_NO_AUTO_UPDATE=1`. El verificador comprueba el `id_token` RS256 contra las claves JWKS de Meta, valida emisor, audiencia y vigencia, y exige la respuesta al nonce de prueba.

Los ejecutables y módulos auxiliares se fijan por hash. El soporte del verificador no acredita por sí solo una cuenta real autenticada. Las pruebas locales y sus límites están en la [matriz de verificación](v4-matriz-local.md).

## Autoridad firmada del ordenador

`POST /v3/fleet/hosts/:host_id/authority` reenvía la solicitud firmada al enclave central por un socket Unix. El enclave valida identidad, empresa, nonce, operación, claim y epoch antes de usar el emisor; la clave privada permanece en el enclave.

El gateway configura `CAUCE_FLEET_AUTHORITY_SOCKET`, `CAUCE_FLEET_AUTHORITY_OWNER_UID` y `CAUCE_FLEET_AUTHORITY_PEER_UID`. Si los UID difieren, también requiere `CAUCE_FLEET_AUTHORITY_GROUP_GID`. El enclave usa los archivos privados `CAUCE_FLEET_AUTHORITY_COMMAND_FILE` y `CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE`. Una configuración parcial impide el arranque.

La acción `ready` comprueba el emisor fijado, su política y el par de claves sin emitir credenciales. Las capacidades de creación dependen de esa disponibilidad; las de lectura de cuotas son independientes.
