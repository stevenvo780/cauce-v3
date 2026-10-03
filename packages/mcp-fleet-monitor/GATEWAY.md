# MCP de solo lectura por el gateway

Entrada independiente: `src/gateway-server.ts` → `dist/gateway-server.js`.
Reutiliza el SDK MCP fijado por el repositorio y el gateway existente; no sustituye
el monitor `stdio` que consulta PostgreSQL ni reutiliza sus modelos SQL.

## Contrato

- `cauce_status`: `GET /v3/status`; versión y presencia del tenant configurado
- `cauce_agents`: `GET /v3/console/agents`; agentes visibles del tenant configurado
- Ninguna herramienta admite argumentos, identidad, URL, cabeceras ni método HTTP
- El gateway autentica su principal y aplica permisos y ACL; el puente después
  filtra por igualdad exacta con `CAUCE_MCP_TENANT_ID`
- Ese filtro reduce visibilidad; no concede permisos ni demuestra la identidad
  del principal. Una respuesta vacía no acredita salud ni existencia del tenant
- Se omiten contadores globales del gateway porque pueden abarcar tenants con ACL
  de lectura. `online` cuenta únicamente la presencia visible del tenant seleccionado
- Se devuelven identificadores, estado y marcas temporales; nunca mensajes, órdenes,
  capacidades libres, nombres de contenedores, rutas, usuarios, cuentas ni credenciales
- Cada lista entrega como máximo 100 filas con `total` y `truncated`; `online: null`
  conserva el estado desconocido de un agente sin presencia

No publica, reclama, confirma ni reintenta entregas. No ejecuta shell, accede a
terminales, envía Telegram ni ofrece un proxy HTTP genérico.

## Autenticación y ámbito

Es un puente de **un único principal**. Quien tenga acceso al MCP recibe el mismo
subconjunto autorizado del gateway. No se comparte entre usuarios con permisos distintos.
El dueño debe elegir un principal del gateway con permiso `read` y el menor alcance posible.

Hay dos credenciales independientes: cliente→MCP y MCP→gateway. El token OAuth de entrada
jamás se reenvía al gateway; tampoco se aceptan identidad delegada o cookies del cliente.
El gateway admite bearer y/o TLS mutuo según su configuración real. Un bearer por sí
solo no permite acceder a una instalación que exige certificado cliente.

Variables requeridas, entregadas por el operador mediante su gestor de secretos:

| Variable | Valor o finalidad |
|---|---|
| `CAUCE_GATEWAY_ORIGIN` | Origen HTTPS exacto del gateway, sin ruta, query ni credenciales |
| `CAUCE_MCP_PUBLIC_ORIGIN` | Origen HTTPS exacto de la futura entrada MCP |
| `CAUCE_MCP_TENANT_ID` | Tenant cuyo subconjunto visible se permite devolver |
| `CAUCE_MCP_AUTH_MODE` | `oauth` por defecto; `static` solo para clientes que admitan bearer configurado |
| `CAUCE_MCP_OAUTH_ISSUER` | Emisor HTTPS exacto del proveedor OAuth autorizado |
| `CAUCE_MCP_OAUTH_JWKS_URI` | Endpoint HTTPS fijo de sus claves públicas, sin query ni credenciales |
| `CAUCE_MCP_OAUTH_SUBJECT` | Identificador `sub` exacto del único usuario autorizado |
| `CAUCE_MCP_ACCESS_TOKEN` | Solo en modo `static`: token independiente, de al menos 32 caracteres |
| `CAUCE_GATEWAY_BEARER_TOKEN` | Bearer existente del gateway, si ese proveedor lo admite |
| `CAUCE_GATEWAY_CERT_FILE` / `CAUCE_GATEWAY_KEY_FILE` | Rutas absolutas al certificado y clave existentes para mTLS; siempre juntas |
| `CAUCE_GATEWAY_CA_FILE` | CA privada opcional; sin ella se usa la confianza TLS del sistema |
| `CAUCE_MCP_PORT` | Puerto local; predeterminado 3101, permitido 1024–65535 |

Debe existir al menos bearer o mTLS hacia el gateway. La verificación TLS nunca se
desactiva. Los archivos se cargan al arrancar y no se escriben ni se generan credenciales.
Para rotar material suministrado se reinicia el proceso mediante el procedimiento del operador.

## Ejecución y publicación pendiente

Construir con `pnpm build:mcp`; ejecutar con
`pnpm --filter @cauce/mcp-fleet-monitor start:gateway` tras configurar el entorno autorizado.
Requiere el workspace instalado con `pnpm install --frozen-lockfile` y su preparación
de `@cauce/protocol`; el archivo generado no es un ejecutable autónomo sin dependencias.
La entrada escucha **solo en 127.0.0.1**, con ruta exacta `/mcp`. Requiere un proxy HTTPS
autorizado en el mismo host que conserve `Host` del origen público y el `Authorization`
de entrada previsto. Si llega `Origin`, debe coincidir exactamente con el origen público.
Las cabeceras `X-Forwarded-*` no son una fuente de identidad o confianza.

El host elegido necesita una ruta ya autorizada al gateway privado. Este cambio no
abre puertos, crea túneles, modifica infraestructura, despliega ni conecta una aplicación.
La preparación aislada de imagen, Compose opt-in y proxy Caddy está en
[`deploy/mcp/README.md`](../../deploy/mcp/README.md); no forma parte del Compose central.

El transporte es MCP Streamable HTTP sin sesiones ni SSE persistente: POST JSON;
GET y DELETE autenticados responden 405. Se crea un servidor MCP por petición.
Límites: 16 KiB por petición, sin lotes JSON-RPC, ocho peticiones activas, 256 KiB por
respuesta del gateway y cinco segundos para completar cada lectura HTTPS. La autenticación
también ocupa una de las ocho plazas; las claves JWKS tienen un límite de 64 KiB y tres
segundos por lectura, caché de cinco minutos y enfriamiento de treinta segundos.
Las redirecciones y respuestas comprimidas se rechazan; los errores no incluyen
cuerpos, URLs, rutas de archivos ni mensajes internos del gateway.

## OAuth y conexión pendiente

El modo predeterminado es un **servidor de recursos OAuth**, no un emisor de credenciales.
Publica metadatos RFC 9728 en `/.well-known/oauth-protected-resource/mcp`, los anuncia
en el desafío HTTP 401 y declara `oauth2`/`cauce.read` en las herramientas MCP.
Valida la firma con `jose`, el emisor exacto, expiración obligatoria, `sub` configurado,
alcance `cauce.read` y una única audiencia exactamente igual a `CAUCE_MCP_PUBLIC_ORIGIN/mcp`.
El proveedor debe emitir JWT de acceso con `typ: at+jwt` y firma RS256 o ES256;
tokens opacos, ID tokens, otras firmas o audiencias múltiples se rechazan.
No hay introspección ni revocación inmediata de JWT: el operador debe usar tokens
de vida corta; la retirada de claves puede tardar hasta la caducidad de la caché.

El proveedor externo autorizado debe ofrecer descubrimiento OAuth/OIDC,
authorization code con PKCE S256, el recurso/audiencia indicado y un mecanismo de
registro de cliente compatible. Este PR no implementa ni aprovisiona ese proveedor,
sus usuarios, consentimientos, aplicaciones, secretos o permisos. El modo `static`
es una alternativa explícita para clientes con bearer propio, sin descubrimiento OAuth;
no se presenta como mecanismo de alta de ChatGPT.

**No se acredita conexión con dot/ChatGPT.** Publicación HTTPS, selección/configuración
del proveedor, credenciales, permisos, registro e interoperabilidad real necesitan aprobación
y pruebas posteriores. Referencias: [autenticación de plugins](https://developers.openai.com/plugins/build/auth)
y [conexión con ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Verificación

`pnpm --filter @cauce/mcp-fleet-monitor test src/gateway` comprueba configuración,
proyecciones, HTTPS real con certificados efímeros de prueba, mTLS, errores y límites,
y un cliente SDK real contra el servidor Streamable HTTP local. OAuth se prueba con
firmas efímeras y respuestas JWKS controladas, incluidos emisor/audiencia/usuario/alcance
incorrectos, expiración y descubrimiento. No usa producción ni prueba un login real.
El gate del repositorio sigue siendo `pnpm typecheck && pnpm lint && pnpm test:unit`.
Estas pruebas no demuestran aislamiento de tenants del gateway vivo ni aceptación por
una aplicación remota. Antes de publicar, verificar el principal real, su revocación,
ACL, TLS, alcance del tenant y el handshake/listado/lecturas inocuas desde el cliente final.
