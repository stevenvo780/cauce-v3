# Login de la consola

La consola se sirve detrás de un login de usuario propio. Este documento dice qué protege ese login,
de qué piezas está hecho, cómo se enciende y **qué hay que medir** antes de dar por bueno cualquier
cambio en el proveedor de autenticación.

## 1. Qué protege la consola

```
navegador
  │  HTTPS público — https://<dominio-consola>
  ▼
proxy de borde (Caddy)            ← SIN basic_auth: la única puerta es el login de la consola
  │  reverse_proxy https://<ip-privada>:8444   (por la red privada)
  │  header_up -X-Cauce-Operator             ← el proxy NO inventa identidad
  ▼
nginx del contenedor `console`    ← sirve el SPA estático (sin datos adentro)
  │  proxy_pass https://gateway:8443 con el certificado de cliente `console_gateway_client_cert`
  │  proxy_set_header X-Cauce-Operator ""    ← y acá tampoco
  ▼
gateway                           ← CAUCE_AUTH_PROVIDER=password, fallback mtls
                                    sin cookie de sesión → 401 en la superficie de consola
```

Un solo dominio a propósito: cualquier otro nombre que haya servido la consola redirige (`308`) al
canónico.

Qué da el login, frente a un basic auth de navegador:

1. **Identidad.** El operador sale del JWT → `console_users`, así que `audit_events` registra el
   correo de quien hizo cada cosa. Con una contraseña compartida, todo el que pasaba la puerta era
   el mismo principal para el gateway y para la auditoría, y dos personas eran indistinguibles.
2. **Cierre de sesión** (`POST /v3/auth/logout`) y **vencimiento** (8 h por defecto).
3. **Revocación granular**: `active=false` o un cambio de contraseña cortan las sesiones abiertas de
   esa persona sola, porque el gateway relee la fila en cada request.

El mTLS del dibujo es **entre servicios** (nginx→gateway), no entre el navegador y nada. El login
humano se **sumó**, no reemplazó: los agentes siguen entrando por su certificado de cliente. Y el
certificado del proxy es una credencial de **transporte**: no sustituye a una sesión (§3).

## 2. Las piezas

| pieza | dónde |
|---|---|
| Tabla de cuentas humanas | migración `packages/store/migrations/023_console_users.sql` → tabla `console_users` |
| Derivación de contraseñas | `services/gateway/src/password.ts` — scrypt (RFC 7914, OpenSSL vía Node), formato PHC |
| Lectura de cuentas | `services/gateway/src/console-users.ts` |
| Proveedor + rutas | `services/gateway/src/password-auth.ts` — `POST /v3/auth/login`, `POST /v3/auth/logout`, `GET /v3/auth/session` |
| Alta / cambio de contraseña / baja | `services/gateway/src/console-user-cli.ts` (`pnpm console:user`) |
| Puerta del navegador | `console/src/features/auth/` (formulario cuando `login_mode: 'password'`) |

Las cuatro decisiones que sostienen la seguridad, y por qué:

- **La contraseña nunca se guarda.** Sólo el derivado scrypt (`n=32768, r=8, p=1`, sal por fila), y
  la base rechaza por `CHECK` cualquier `password_hash` que no empiece por `$scrypt$`.
  *No se usa argon2/bcrypt porque los dos son paquetes nativos y la imagen es `node:22-alpine`
  (musl): un binario resuelto contra glibc pasa el `pnpm install` y revienta en producción.*
- **El secreto de firma vive en un archivo, fuera del repositorio**, en modo `0400` y con el mismo
  dueño que sus vecinos. En `deploy/compose.yaml` es un secreto opt-in que apunta a `/dev/null`
  mientras no se defina `CAUCE_CONSOLE_JWT_KEY_PATH`.
- **El token va en una cookie `__Host-cauce_session; HttpOnly; Secure; SameSite=Strict`**, jamás en
  `localStorage` ni en el cuerpo de la respuesta: un XSS en la consola no tiene qué robarse.
- **La sesión vence** (`CAUCE_CONSOLE_SESSION_TTL_SECONDS`, 28800 por defecto) y
  `GET /v3/auth/session` lo comprueba de verdad. Además **relee la fila del usuario en cada
  request**: `active=false` o un cambio de contraseña cortan las sesiones abiertas sin tabla de
  revocación.

Roles: **`operator`** (publicar, cancelar, reintentar, terminales) y **`reader`** (sólo leer); el
`CHECK` de la migración no admite otros. Todo lo demás lo sigue acotando `memberships`/`role_policies`,
porque `/v3/console/access` intersecta los permisos del usuario con los que la base le concede a su
`tenant/alias`. Un rol mal puesto en `console_users` no puede escalar por encima de la base.

## 3. 🔴 La puerta va por RUTA, no por canal

Encender `CAUCE_AUTH_PROVIDER=password` **no alcanza**, y el mecanismo no se ve leyendo sólo el
código del login:

1. El listener del gateway exige certificado de cliente (`rejectUnauthorized: true`), así que desde
   internet no se le llega: el handshake muere.
2. Pero el nginx de la consola **sí** tiene un certificado, y lo presenta en TODO lo que proxea. Ese
   certificado está provisionado en `mtls_identities.json` con `channel: console` y rol `operator`.
3. `PasswordAuthProvider.handles()` es «¿trae cookie?». Sin cookie, el request cae al `fallback`
   mTLS → resuelve el certificado del proxy → entra como operador.

Sin la guarda, el login es una cortina de la SPA (`AuthGate` esconde la interfaz) y la API queda
abierta a cualquiera que llegue al proxy.

**La guarda no puede ser por canal.** Rechazar todo principal del canal `console` en cualquier
endpoint deja la flota **sin plano de control**: el principal del proxy (`console-client` por
defecto, `CAUCE_TERMINAL_CONSOLE_CN`) es también el que usan los guardias y las herramientas de
operación para **publicar**, así que `POST /v3/messages` empieza a contestar
`401 se requiere la cookie de sesión de la consola` y las entregas mueren. Un canal dice de dónde
**puede** venir un navegador; no dice **qué** está pidiendo el que llama.

La regla correcta, y la que está en el código (`isConsoleSurface`, `services/gateway/src/password-auth.ts`):
**un endpoint de consola exige sesión; un endpoint del bus exige mTLS válido.** La superficie de
consola es `/v3/console/*` más `/v3/status` — el mismo prefijo que ya mira
`createConsoleSecurityHook`, así que una ruta de consola nueva queda cubierta por las dos puertas sin
tocar ninguna lista. Un mismo principal entra por las dos puertas según qué pida: publica en
`/v3/messages` con su certificado y necesita una persona con sesión para `/v3/console/activity`.

Lo que **no** toca esta puerta: los adaptadores (`channel: adapter`) y el recolector de cuotas
siguen entrando por su propio certificado, y `/v3/terminal/relay/*` se autoriza con su token sin
pasar por este proveedor.

## 4. `password` y `mtls` conviven en el mismo proceso

`PasswordAuthProvider` atiende solamente lo que trae la cookie de consola y delega TODO lo demás a
`CAUCE_CONSOLE_PASSWORD_FALLBACK` (por defecto `mtls`; también acepta `token-file` o `none`, ver
`services/gateway/src/main.ts`). Con el proveedor `password` encendido, el listener sigue pidiendo
certificado de cliente y una conexión sin certificado muere en el handshake: no hace falta un
listener aparte para la consola.

## 5. Encendido

1. Aplicar la migración `023_console_users.sql`. Es aditiva e inerte: nadie la lee hasta que el
   gateway corra con `CAUCE_AUTH_PROVIDER=password`.
2. Generar el secreto de firma (≥32 bytes) en el host, modo `0400`, en la ruta canónica
   `/etc/cauce-v3/secrets/console_jwt_key` (es la que el propio `deploy/compose.yaml:566` documenta
   como ubicación de producción, y la que el paso 4 pone en `CAUCE_CONSOLE_JWT_KEY_PATH`).
3. Desplegar la imagen del gateway que trae el proveedor.
4. Fijar el entorno privado:

   ```sh
   CAUCE_AUTH_PROVIDER=password
   CAUCE_CONSOLE_JWT_KEY_PATH=/etc/cauce-v3/secrets/console_jwt_key
   # opcionales, con estos defaults:
   # CAUCE_CONSOLE_PASSWORD_FALLBACK=mtls      ← los agentes siguen entrando por certificado
   # CAUCE_CONSOLE_SESSION_TTL_SECONDS=28800
   ```

   ⚠️ **`_PATH` y `_FILE` no son la misma variable y las dos hacen falta.** En el env privado va
   `CAUCE_CONSOLE_JWT_KEY_PATH`, que es la ruta **en el host** y la usa `deploy/compose.yaml` para
   montar el secreto (`file: ${CAUCE_CONSOLE_JWT_KEY_PATH:-/dev/null}`). Lo que lee el código es
   `CAUCE_CONSOLE_JWT_KEY_FILE` (`main.ts`), la ruta **dentro** del contenedor, que fija el propio
   compose en `/run/secrets/console_jwt_key`. Si se confunden, el gateway arranca contra `/dev/null`
   y falla con «debe contener al menos 32 bytes de clave».

   Verificar el efecto en el contenedor vivo, no en el archivo.

5. Crear la cuenta:

   ```sh
   DATABASE_URL=... pnpm console:user --email <correo> --name "<nombre>" \
     --role operator --tenant <tenant> --alias <alias>
   ```

   Pregunta la contraseña dos veces sin eco. En un contenedor sin TTY se pasa por
   `CAUCE_CONSOLE_USER_PASSWORD`, **nunca por argumento** (los argumentos se ven en `ps`); el comando
   rechaza `--password` a propósito. Para no exponerla en ningún punto de la cadena, se lee por
   stdin y se exporta dentro del propio `sh` del contenedor, junto con el `DATABASE_URL` que sale del
   secreto montado:

   ```sh
   # [no ejecutable en verificación]
   docker exec -i <contenedor-gateway> sh -c '
     IFS= read -r P
     export CAUCE_CONSOLE_USER_PASSWORD="$P"
     export DATABASE_URL="$(cat /run/secrets/database_url)"
     cd /app && node services/gateway/dist/console-user-cli.js \
       --email <correo> --name <nombre> --role operator --tenant <tenant> --alias <alias>'
   ```

   Reejecutarlo cambia la contraseña e invalida las sesiones abiertas. Para dar de baja:
   `pnpm console:user --email … --deactivate`. Una cuenta de prueba con rol `operator` alcanza los
   datos de todos los tenants: no puede quedar viva.

6. **Sacar la identidad inventada del proxy.** Con el login encendido el operador sale del JWT, así
   que ninguna capa delante del gateway debe fijar `X-Cauce-Operator`: el nginx del contenedor la
   manda vacía (`deploy/console/nginx-console-tls.conf`) y el borde la borra con
   `header_up -X-Cauce-Operator`. Se fija ahí y no en el navegador para que el cliente no pueda
   atribuirse a otro.

   El orden importa: quitar la cabecera **antes** de encender `CAUCE_AUTH_PROVIDER=password` deja
   todas las sesiones PTY sin atribuir y cierra los destinos (`attribution_required`). Va en el mismo
   despliegue que el paso 4, no antes.

   🔴 **Y arrastra las concesiones del PTY.** Con la cabecera fija, el `operator_id` era esa cadena, y
   así están escritas las concesiones de `/etc/cauce-v3/terminal/grants.json`. Con el login,
   `operator_id` pasa a ser el **correo** de `console_users` (`principalFor` → `operator_id: user.email`),
   así que ninguna concesión casa y **todos los destinos contestan `authorized:false`** aunque la
   sesión sea válida. Hay que duplicar cada concesión con el correo de la cuenta —una entrada por
   destino que la cuenta deba alcanzar—; las viejas quedan inertes y permiten volver atrás si se
   repone la cabecera. Si la cuenta se crea con otro correo, hay que repetirlo con ese correo.

7. Cerrar el borde con la lista blanca del §7 y quitar el `basic_auth`, en ese orden.
8. Verificar con las sondas del §6. **Es lo único que sostiene** que se pueda quitar la contraseña de
   navegador: si el API no exige sesión de verdad, no queda ninguna segunda puerta.

## 6. Verificación: qué debe contestar sin sesión

Quitar el `basic_auth` sólo es defendible si el API exige sesión. No alcanza con que el listener del
gateway pida certificado de cliente: **el proxy de la consola tiene ese certificado**, así que el
navegador de un desconocido llega igual de lejos. La pregunta correcta no es «¿se llega?» sino
«**¿se llega y contesta con datos?**». Medir **desde internet**, contra `https://<dominio-consola>`,
sin cookie y sin ninguna otra credencial:

| sonda | resultado exigido |
|---|---|
| todas las rutas `GET` de datos (`/v3/status`, `/v3/accounts/selection`, cada `/v3/console/*`, incluida `/v3/console/terminal/*`) | **401** `se requiere la cookie de sesión de la consola` |
| `POST /v3/deliveries/query`, `/v3/query`, `/v3/messages`, `/v3/heartbeat`, `/v3/ack`, `/v3/quotas/samples` | **401** (o **404** del borde, §7) |
| `POST /v3/connections/hello` con cuerpo **válido** y una identidad que no casa con el certificado del proxy | **401**. Es la sonda que discrimina: si la auth hubiera pasado, el `hello` moriría más adelante en `403 authenticated identity does not match hello` |
| `POST /v3/console/messages`, `/v3/console/jobs`, `/v3/console/config/changes` con `Origin` same-origin | **401** (sin `Origin` dan `403` por CSRF, que tapa la señal: hay que mandarlo para medir la auth) |
| `/v3/terminal/relay/*` | **401** |
| la raíz `/` | **200**: sólo el shell de la SPA, sin un dato ni un alias adentro |
| `WWW-Authenticate` en cualquier respuesta | **ninguno**: ya no hay contraseña de navegador |

Con sesión, la misma cuenta ve las vistas de datos; después de `POST /v3/auth/logout` (`204`),
`/v3/console/activity` vuelve a **401** y `/v3/auth/session` a `{"authenticated":false}`.

Lo que hace que esto sea estructural y no una lista de rutas está en
`PasswordAuthProvider.viaFallback()`: todo lo que no trae cookie se resuelve con la identidad de
**máquina** del `fallback` mTLS, y si esa máquina es del canal `console` —que es el certificado que
presenta el proxy en TODO lo que proxea— el request muere en 401 en la superficie de consola. Por eso
cubre también las rutas que todavía no existen.

🔴 **Si `CAUCE_AUTH_PROVIDER` deja de ser `password`**, o el `fallback` deja de ser `mtls`, o el
certificado del proxy cambia de canal, esta medición deja de valer y la consola queda **abierta a
internet**, porque no hay segunda puerta. Volver a correr estas sondas antes de dar por bueno
cualquier cambio en el proveedor de autenticación.

## 7. Lista blanca en el borde

La guarda por ruta destraba el bus, pero **vuelve a exponer la superficie de bus a través del dominio
público**: sin lista blanca, `GET /v3/accounts/selection` contesta 200 con el inventario de cuentas y
`POST /v3/messages` publica en el bus con la identidad del proxy. O sea: cualquiera con la URL puede
inyectar entregas con identidad de operador.

El arreglo no toca ni el gateway ni el contenedor de la consola: el dominio público no tiene por qué
proxear la superficie de bus en absoluto. La SPA sólo usa `/v3/auth/*`, `/v3/status` y
`/v3/console/*` (enumerado en `console/src/api/client.ts` y `console/src/features/terminal/api.ts`;
`/v3/ws` es el bus de los agentes, y la propia SPA lo dice en
`console/src/features/live/LiveFleetPage.tsx`). En el borde, **lista blanca** —una lista negra se
queda vieja con la próxima ruta que alguien agregue al gateway—:

```
<dominio-consola> {
  @bus_privado {
    path /v3/*
    not path /v3/auth/* /v3/status /v3/console/*
  }
  route {                       # `route` conserva el orden escrito
    respond @bus_privado "not found" 404
    reverse_proxy https://<ip-privada>:8444 {
      header_up -X-Cauce-Operator
      transport http { tls_insecure_skip_verify }
    }
  }
}
```

`tls_insecure_skip_verify` conviene cambiarlo por la CA interna, ya que se toca el bloque igual.

Qué debe cambiar tras el `systemctl reload caddy`, medido desde internet:

| sonda | antes | después |
|---|---|---|
| `GET /v3/accounts/selection` | 200 con datos reales | **404** `not found` (cuerpo del borde, no JSON del gateway) |
| `POST /v3/messages`, `/v3/ack` | llegaban al gateway | **404** del borde |
| `GET /v3/heartbeat`, `/v3/query`, `/v3/deliveries`, `/v3/connections`, `/v3/quotas/samples`, `/v3/ws` | llegaban al gateway | **404** del borde |
| evasiones: `/v3/console/../accounts/…`, `%2e%2e`, `/V3/…`, `/v3/%61ccounts/…`, `//v3/…`, `/v3//accounts/…` | — | **404** en todas (Caddy normaliza y decodifica **antes** de casar, así que falla cerrado) |
| `/`, `/assets/*.js`, rutas del router | 200 | **200** |
| `GET /v3/auth/session` | 200 | **200** `{"authenticated":false,"login_mode":"password"}` |
| `GET /v3/status`, `/v3/console/*` sin sesión | 401 | **401** — la guarda de sesión no se reabre |
| `GET /v3/console/terminal/ws` | llega al relay | **llega igual**; `/v3/ws` en cambio corta en 404 — ése es el discriminador |

Los adaptadores no pasan por este dominio: van por la red privada al `:8443` del gateway, así que la
flota sigue entregando durante el cambio. **Para revertir**: reponer la copia del `Caddyfile` previa
al cambio y `systemctl reload caddy`.

## 8. La alternativa OIDC

`services/gateway/src/oidc-bff.ts` implementa un BFF OIDC completo (authorization code + PKCE,
sesión cifrada en `gateway_oidc_sessions`, mismas cookies y mismo CSRF) y se enciende con
`CAUCE_AUTH_PROVIDER=oidc` más las URLs del proveedor. Es más trabajo de configuración y depende de
un proveedor externo; el login por contraseña existe justamente para no necesitarlo. Las dos
variantes son excluyentes: el gateway corre una o la otra.

## 9. Pendiente: separar identidades

La lista blanca es una mitigación de borde: cierra el dominio público, pero el certificado del proxy
sigue siendo un principal `operator` con `permissions:[route,read,control]`, y el nginx del
contenedor lo sigue presentando en todo lo que proxea. El arreglo estructural es partirlo en dos, tal
como lo pide el comentario de `password-auth.ts` (usar el principal de la consola para publicar es
*prestado*):

| principal | quién lo usa | `channel` | `roles` | `permissions` |
|---|---|---|---|---|
| `console-proxy` | sólo el nginx del contenedor `console` | `console` | `[]` | `[]` |
| principal de operación | guardias y herramientas de operación | `adapter` | `["operator"]` | `["route","read","control"]` |
| `console-client` | nadie: se **retira** de `mtls_identities.json` cuando los dos anteriores estén medidos | — | — | — |

Con el principal del proxy sin permisos, una ruta de bus que se filtrara por el proxy muere en 403
aunque el borde fallara: la consola sigue andando porque ahí el principal sale de la **cookie de
sesión**, no del certificado. Es defensa en profundidad de la misma cosa.

Secuencia sin recrear nada:

1. Emitir los dos pares cert/key con la CA de cliente del gateway y registrar sus huellas en
   `/etc/cauce-v3/secrets/identities/mtls_identities.json`. El gateway **relee ese archivo por
   request** (`HashedMtlsIdentityFileProvider.resolve` → `readIdentityFile`, caché de 1 s): no hay que
   reiniciarlo ni recrearlo.
2. Apuntar los guardias y herramientas al principal de operación **antes** de tocar nada más, y
   probar `cauce probar <alias>` de punta a punta.
3. Poner los bytes de `console-proxy` **encima** del cert/key que monta el contenedor y
   `docker exec <contenedor-console> nginx -s reload`. ⚠️ **En sitio** (`cat nuevo > archivo`), nunca
   `mv`/`install`: el bind-mount es de un **archivo**, y cambiar el inodo deja al contenedor con el
   certificado viejo y con cara de que el cambio se aplicó. Así no hace falta recrear el contenedor;
   si el reload no lo tomara, ahí sí toca recrear con rutas nuevas.
4. Medir con sesión: login, una vista con datos, y el PTY. Si el login rompiera, se revierte
   reponiendo los bytes viejos y otro `nginx -s reload`.
5. Recién entonces borrar la entrada `console-client` de `mtls_identities.json`.

Riesgo abierto que hay que medir en el paso 4, no suponer: **no está probado** que `/v3/auth/*` y el
relay de terminal funcionen con un principal de transporte con `permissions:[]`.
