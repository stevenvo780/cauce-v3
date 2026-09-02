# Login de verdad para la consola

La consola tiene login de usuario **encendido en producción desde el <private-date>**. Este documento
dice qué protege hoy, qué se construyó, cómo se encendió, y —lo que más importa— **la medición que
justifica que ya no haya contraseña de navegador**.

## 1. Qué protege la consola HOY (medido el <private-date>)

```
navegador
  │  HTTPS (Let's Encrypt) — https://${CONSOLE_HOST}
  ▼
Caddy @ VPS (${PRIVATE_ADDRESS})      ← SIN basic_auth. La única puerta es el login de la consola.
  │  reverse_proxy https://${PRIVATE_ADDRESS}:8444   (tls_insecure_skip_verify, por la tailnet)
  │  header_up -X-Cauce-Operator             ← el proxy NO inventa identidad
  ▼
nginx @ cauce-v3-prod-console-1   ← sirve el SPA estático (686 bytes, sin datos adentro)
  │  proxy_pass https://gateway:8443 con certificado de cliente `console_gateway_client_cert`
  │  proxy_set_header X-Cauce-Operator ""    ← y acá tampoco
  ▼
gateway                          ← CAUCE_AUTH_PROVIDER=password, fallback mtls
                                   sin cookie de sesión → 401 en TODO /v3/*
```

`${CONSOLE_HOST}` ya no sirve la consola: redirige `308` a `${CONSOLE_HOST}`. Hay **un
solo** dominio a propósito.

Lo que el login arregló, en el orden en que dolía:

1. **Ahora hay identidad.** El operador sale del JWT → `console_users`, así que `audit_events`
   registra el **correo** de quien hizo cada cosa. Antes, todo el que pasaba el basic auth *era*
   `<private-identity>` para el gateway y para la auditoría, y dos personas eran indistinguibles.
2. **Hay cierre de sesión** (`POST /v3/auth/logout`) y la sesión **vence** a las 8 h.
3. **Hay revocación granular**: `active=false` o un cambio de contraseña cortan las sesiones
   abiertas de esa persona sola, porque el gateway relee la fila en cada request.

El mTLS del dibujo es **entre servicios** (nginx→gateway), no entre el navegador y nada. **El
login humano se sumó, no reemplazó**: los agentes siguen entrando por su certificado de cliente.
Y —esto es lo que costó descubrir— el certificado del proxy es una credencial de **transporte**:
desde el <private-date> ya **no** sustituye a una sesión. El detalle está en §2 y la medición en §4.

## 2. Lo que ya está construido (desplegado en producción)

| pieza | dónde |
|---|---|
| Tabla de cuentas humanas | migración `packages/store/migrations/023_console_users.sql` → tabla `console_users` |
| Derivación de contraseñas | `services/gateway/src/password.ts` — scrypt (RFC 7914, OpenSSL vía Node), formato PHC |
| Lectura de cuentas | `services/gateway/src/console-users.ts` |
| Proveedor de autenticación + rutas | `services/gateway/src/password-auth.ts` — `POST /v3/auth/login`, `POST /v3/auth/logout`, `GET /v3/auth/session` |
| Alta / cambio de contraseña / baja | `services/gateway/src/console-user-cli.ts` (`pnpm console:user`) |
| Puerta del navegador | `console/src/features/auth/` (formulario cuando `login_mode: 'password'`) |

Las cuatro decisiones que sostienen la seguridad, y por qué:

- **La contraseña nunca se guarda.** Sólo el derivado scrypt (`N=2^15, r=8, p=1`, sal por fila),
  y la base rechaza por `CHECK` cualquier `password_hash` que no empiece por `$scrypt$`.
  *No se usó argon2/bcrypt porque los dos son paquetes nativos y la imagen es `node:22-alpine`
  (musl): un binario resuelto contra glibc pasa el `pnpm install` y revienta en producción.*
- **El secreto de firma vive en un archivo, fuera del repositorio.** En producción ya está en
  `/etc/cauce-v3/secrets/console_jwt_key` (`0400`, dueño `minecraft-tunnel`, igual que sus
  vecinos). En `deploy/compose.yaml` es un secreto opt-in que apunta a `/dev/null` mientras no se
  defina `CAUCE_CONSOLE_JWT_KEY_PATH`.
- **El token va en una cookie `__Host-cauce_session; HttpOnly; Secure; SameSite=Strict`**, jamás
  en `localStorage` ni en el cuerpo de la respuesta: un XSS en la consola no tiene qué robarse.
- **La sesión vence** (8 h por defecto, `CAUCE_CONSOLE_SESSION_TTL_SECONDS`) y `GET /v3/auth/session`
  lo comprueba de verdad. Además **relee la fila del usuario en cada request**: `active=false` o
  un cambio de contraseña cortan las sesiones abiertas sin tabla de revocación.

Roles: **`operator`** (publicar, cancelar, reintentar, terminales) y **`reader`** (sólo leer). Es
la decisión de producto mínima; todo lo demás lo sigue acotando `memberships`/`role_policies`,
porque `/v3/console/access` intersecta los permisos del usuario con los que la base le concede a
su `tenant/alias`. Un rol mal puesto en `console_users` no puede escalar por encima de la base.

### 🔴 El certificado del proxy NO reemplaza a una sesión (medido el <private-date>)

Encender `CAUCE_AUTH_PROVIDER=password` **no alcanzaba**. Medido en producción con el login ya
encendido, `/v3/console/*` y `/v3/status` seguían devolviendo **200 sin cookie de sesión**: unos
850 KB de entregas, mensajes, auditoría, colas, cuotas y salas de los **cinco** tenants a cualquiera
que llegara al proxy.

El mecanismo, que no se ve leyendo sólo el código del login:

1. El listener del gateway exige certificado de cliente (`rejectUnauthorized: true`), así que desde
   internet no se le llega: probado, el handshake muere (`curl` devuelve `000`).
2. Pero el nginx de la consola **sí** tiene un certificado, y lo presenta en TODO lo que proxea.
   Ese certificado está provisionado en `mtls_identities.json` como `TENANT_ID:AGENT_ALIAS`,
   `channel: console`, rol `operator`.
3. `PasswordAuthProvider.handles()` es "¿trae cookie?". Sin cookie, el request cae al `fallback`
   mTLS → resuelve el certificado del proxy → entra como operador.

O sea: **el login era una cortina de la SPA** (`AuthGate` escondía la interfaz) y lo único que
tapaba la API era el `basic_auth` de Caddy. Por eso nadie lo había notado.

El arreglo está en `PasswordAuthProvider`: el certificado del proxy es una credencial de
**transporte** ("soy la consola"), no una autorización para leer la flota **en un navegador**.

Lo que NO se toca, y es la mitad que importa no romper: los adaptadores (`channel: adapter`) y el
recolector de cuotas siguen entrando por su propio certificado, y las rutas
`/v3/terminal/relay/*` se autorizan con su token sin pasar por este proveedor. Verificado tras el
despliegue: los 16 alias de los 5 tenants latiendo, y entregas aceptadas y arrancadas por agentes
de TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID e TENANT_ID.

#### 🔴 La puerta va por RUTA, no por canal (regresión del <private-date>, corregida)

La primera versión de esta puerta miraba **sólo el canal**: cualquier principal del canal `console`
quedaba rechazado en **cualquier** endpoint. Eso dejó la flota **sin plano de control**, y así se
midió:

- `console-client` es el **único** principal mTLS con permiso `control` (los 16 adaptadores tienen
  `route,read`; el recolector de cuotas, `control` pero no `route`). Es también el que usan el
  guardia médico y las herramientas de operación para **publicar**.
- Con la puerta por canal, `POST /v3/messages` le devolvía
  `401 se requiere la cookie de sesión de la consola`. El guardia médico de las <private-time> no pudo
  entregarle a `AGENT_ALIAS` (`despacho a AGENT_ALIAS: ok=False 401`) y cayó al Telegram directo; los
  `retomar_encargo` de `AGENT_ALIAS`, `AGENT_ALIAS` e `AGENT_ALIAS` murieron en 401.
- Un canal dice de dónde **puede** venir un navegador; no dice **qué** está pidiendo el que llama.

La regla correcta, y la que está en el código (`isConsoleSurface` en `password-auth.ts`): **un
endpoint de consola exige sesión; un endpoint del bus exige mTLS válido.** La superficie de consola
es `/v3/console/*` más `/v3/status` — el mismo prefijo que ya mira `createConsoleSecurityHook`, así
que una ruta de consola nueva queda cubierta por las dos puertas sin tocar ninguna lista. Un mismo
principal entra por las dos puertas según qué pida: `console-client` publica en `/v3/messages` con
su certificado y necesita una persona con sesión para `/v3/console/activity`.

Medido en producción después de corregirlo (`console-client`, **sin** cookie):
`/v3/console/{activity,audit,messages,queues,quotas,topology}` y `/v3/status` → **401**;
`/v3/accounts/selection` → 200 y `POST /v3/messages` → **202** con entrega real creada;
`agent-AGENT_ALIAS` (canal `adapter`) → 200 en `/v3/status`, intacto.

### Conviven `password` y `mtls` en el mismo proceso — probado

Era la pregunta abierta de la versión anterior de este documento ("si no conviven, la consola
necesita su propio listener"). **Conviven.** `PasswordAuthProvider` atiende solamente lo que trae
la cookie de consola y delega TODO lo demás a `CAUCE_CONSOLE_PASSWORD_FALLBACK` (por defecto
`mtls`). Comprobado el <private-date> arrancando `services/gateway/src/main.ts` con
`CAUCE_AUTH_PROVIDER=password` + fallback `mtls`: el listener sigue pidiendo certificado de
cliente (`Acceptable client certificate CA names: CN = Cauce V3 Private CA`) y una conexión sin
certificado muere en el handshake, exactamente como hoy.

## 3. El encendido — APLICADO ENTERO el <private-date>

**Los ocho pasos están hechos y medidos en producción.** La consola vive en un solo dominio,
`https://${CONSOLE_HOST}`, y **ya no tiene contraseña de navegador**: la única puerta es el
login de la consola. Lo que sostiene esa decisión está medido más abajo, en §4.

Quien lea esto buscando "¿qué protege la consola hoy?": la respuesta es el login de usuario, y
nada más. Si eso alguna vez deja de ser cierto, hay que reponer el `basic_auth` de §3.7 ANTES de
tocar nada, porque no queda ninguna segunda puerta.

1. ~~Migración `023_console_users.sql`~~ **aplicada** en producción; la fecha exacta queda en
   evidencia privada. Es aditiva e inerte: nadie la lee hasta que el gateway corra con
   `CAUCE_AUTH_PROVIDER=password`.
2. ~~Secreto de firma~~ **generado** en `/etc/cauce-v3/secrets/console_jwt_key`.
3. ~~**Desplegar la imagen**~~ **hecho**: el RepoDigest y la hora de arranque quedaron
   acreditados en evidencia privada y no se transcriben en este runbook.
4. ~~**`prod.env`**~~ **hecho** — el proveedor está encendido y el secreto apuntado. Verificado en
   el contenedor vivo, no en el archivo: `CAUCE_AUTH_PROVIDER=password`,
   `CAUCE_CONSOLE_JWT_KEY_FILE=/run/secrets/console_jwt_key`, `CAUCE_CONSOLE_PASSWORD_FALLBACK=mtls`,
   `CAUCE_CONSOLE_SESSION_TTL_SECONDS=28800`, y las `CAUCE_OIDC_*` vacías:

   ```sh
   CAUCE_AUTH_PROVIDER=password
   CAUCE_CONSOLE_JWT_KEY_PATH=/etc/cauce-v3/secrets/console_jwt_key
   # opcionales, con estos defaults:
   # CAUCE_CONSOLE_PASSWORD_FALLBACK=mtls      ← los agentes siguen entrando por certificado
   # CAUCE_CONSOLE_SESSION_TTL_SECONDS=28800
   ```

   ⚠️ **`_PATH` y `_FILE` no son la misma variable y las dos hacen falta.** En `prod.env` va
   `CAUCE_CONSOLE_JWT_KEY_PATH`, que es la ruta **en el host** y la usa `deploy/compose.yaml`
   para montar el secreto (`file: ${CAUCE_CONSOLE_JWT_KEY_PATH:-/dev/null}`). Lo que lee el
   código es `CAUCE_CONSOLE_JWT_KEY_FILE` (`main.ts`), la ruta **dentro** del contenedor, que la
   fija el propio compose en `/run/secrets/console_jwt_key`. Si se confunden, el gateway arranca
   contra `/dev/null` y falla con "debe contener al menos 32 bytes de clave".

5. ~~**Crear la cuenta de TENANT_ID**~~ **hecha** el <private-date>: `ACCOUNT_EMAIL`, rol `operator`,
   actúa como `TENANT_ID:AGENT_ALIAS`. Es la **única** fila de `console_users`; la cuenta de prueba
   `ACCOUNT_EMAIL` se **borró** en el mismo cambio (estaba desactivada, pero una
   cuenta de prueba con rol `operator` alcanza los datos de los cinco tenants y no podía quedar).
   La contraseña se generó al azar (32 caracteres, `secrets.choice`) y **no está en el repositorio
   ni se mandó por Telegram ni por el bus** — los mensajes quedan en texto plano en la base. Vive
   en un archivo `0600` en la torre: `/datos/workspaces/personal/CREDENCIALES-CONSOLA-CAUCE.txt`.

   Cómo se corrió, sin que la contraseña toque `argv` en ningún punto de la cadena:

   ```sh
   ssh ${SOURCE_HOST} 'cat ${PRIVATE_RUNTIME_FILE}' | ssh ${TARGET_HOST} 'docker exec -i cauce-v3-prod-gateway-1 sh -c "
     IFS= read -r P
     export CAUCE_CONSOLE_USER_PASSWORD=\"\$P\"
     export DATABASE_URL=\"\$(cat /run/secrets/database_url)\"
     cd /app && node services/gateway/dist/console-user-cli.js \
       --email ACCOUNT_EMAIL --name TENANT_ID --role operator --tenant TENANT_ID --alias AGENT_ALIAS"'
   ```

   `DATABASE_URL` no está en el entorno del contenedor: se lee de `/run/secrets/database_url`.
   El archivo temporal de la contraseña se borró después.

   La forma original, para cuando haya que crear otra cuenta:

   ```sh
   DATABASE_URL=... pnpm console:user --email ACCOUNT_EMAIL --name "TENANT_ID" \
     --role operator --tenant TENANT_ID --alias AGENT_ALIAS
   ```

   Pregunta la contraseña dos veces sin eco. En un contenedor sin TTY se pasa por
   `CAUCE_CONSOLE_USER_PASSWORD`, **nunca por argumento** (los argumentos se ven en `ps`); el
   comando rechaza `--password` a propósito. Reejecutarlo cambia la contraseña e invalida las
   sesiones abiertas. Para dar de baja: `pnpm console:user --email … --deactivate`.

6. ~~**Sacar la identidad inventada de nginx.**~~ **hecho y verificado en lo desplegado**, no sólo
   en el repositorio: `docker exec cauce-v3-prod-console-1 grep X-Cauce-Operator /etc/nginx/conf.d/default.conf`
   → `proxy_set_header X-Cauce-Operator "";`. Con el login encendido el operador sale del JWT y
   esta línea deja de tener sentido; mientras esté, no hace daño (el `operator_id` autenticado le
   gana), pero es exactamente la cabecera que hacía que la auditoría dijera `<private-identity>` entre quien
   entre. En `deploy/nginx-console-tls.conf`, dentro de `location /v3/`:

   ```diff
   -    # Identidad humana del operador para el plano PTY. El certificado de cliente sólo dice
   -    # `TENANT_ID:AGENT_ALIAS` (la consola); el gateway exige además nombrar a la persona, y sin esta
   -    # cabecera todo destino contesta `authorized:false` aunque los grants existan.
   -    # Se fija acá y no en el navegador a propósito: así el cliente no puede atribuirse a otro.
   -    # Si algún día hay más de un humano en la consola, esto pasa a salir de su sesión.
   -    proxy_set_header X-Cauce-Operator "<private-identity>";
   +    # La identidad del operador sale de la sesión del usuario (JWT -> console_users), no de
   +    # una cabecera fija. Se borra la que venga del cliente para que nadie se atribuya a otro.
   +    proxy_set_header X-Cauce-Operator "";
   ```

   El orden importaba: quitarla ANTES de encender `CAUCE_AUTH_PROVIDER=password` deja
   todas las sesiones PTY sin atribuir y cierra los destinos de otros tenants
   (`attribution_required`). Fue en el mismo despliegue que el paso 4, no antes.

   🔴 **Y arrastra las concesiones del PTY**: con la cabecera, el operador era la cadena fija
   `<private-identity>`, y así están escritas las 15 concesiones de `/etc/cauce-v3/terminal/grants.json`. Con
   el login, `operator_id` pasa a ser el **correo** de `console_users` (`principalFor` →
   `operator_id: user.email`), así que ninguna concesión casa y **todos los destinos contestan
   `authorized:false`** aunque la sesión sea válida. Hay que duplicar cada concesión con el correo
   de la cuenta. Hecho el <private-date> para `ACCOUNT_EMAIL`, dejando las de `<private-identity>` (inertes,
   pero permiten volver atrás si se repone la cabecera). Medido después: 15/15 destinos
   `authorized: true, reason: ok` en los cinco tenants. **Si la cuenta se crea con otro correo,
   hay que repetir esto con ese correo.**

   ⚠️ Ese 15/15 **no distingue por sí solo** si la atribución sale del correo o de la cabecera
   vieja: las concesiones están duplicadas con las dos formas, así que pasaría igual en los dos
   casos. Lo que sí lo distingue es el paso 6 comprobado en el contenedor (la cabecera se manda
   vacía) más el `header_up -X-Cauce-Operator` del Caddy. Reconfirmado el <private-date> con la cuenta
   de TENANT_ID: `items: 15`, `authorized: 15`, repartidos TENANT_ID 5 · TENANT_ID 4 · TENANT_ID 4 · TENANT_ID 1 ·
   TENANT_ID 1.

7. ~~**Sacar el basic auth y la cabecera de Caddy**~~ **hecho**, y con un cambio de mapa que este
   documento no anticipaba: **la consola se mudó a un solo dominio**. Hoy vive en
   `${CONSOLE_HOST}`, servida por el Caddy del **VPS** (${PRIVATE_ADDRESS}) contra el MISMO
   contenedor de `<private-identity>` por la tailnet. `${CONSOLE_HOST}` ya no sirve la consola:
   redirige `308` al dominio nuevo. **El `basic_auth` no está en ninguno de los dos.**

   O sea que el archivo a mirar hoy es el `/etc/caddy/Caddyfile` **del VPS**, no el de
   `<private-identity>`. El bloque vivo (con la lista blanca del §6; **el bloque de abajo ya no es el
   que corre**, quedó como referencia histórica de cómo estaba cuando se quitó el `basic_auth`):

   ```
   ${CONSOLE_HOST} {
     reverse_proxy https://${PRIVATE_ADDRESS}:8444 {
       header_up -X-Cauce-Operator
       transport http { tls_insecure_skip_verify }
     }
   }
   ```

   El diff original, que es lo que se aplicó (el bloque estaba entonces en `<private-identity>`):

   ```diff
    ${CONSOLE_HOST} {
   -  basic_auth {
   -    stev $2a$14$…
   -  }
      # La consola de Cauce V3 habla HTTPS con la PKI interna sobre el tailnet.
      reverse_proxy https://${PRIVATE_ADDRESS}:8444 {
   -    header_up -X-Cauce-Operator
   -    header_up X-Cauce-Operator <private-identity>
   +    # La identidad la pone el login de la consola; el proxy no inventa ninguna.
   +    header_up -X-Cauce-Operator
        transport http {
          tls_insecure_skip_verify
        }
      }
    }
   ```

   `tls_insecure_skip_verify` conviene cambiarlo por la CA interna ya que se toca el bloque igual.

8. ~~**Verificar**~~ **hecho**. La verificación está entera en §4, porque es lo único que sostiene
   que se pueda quitar la contraseña del navegador.

## 4. Por qué se puede vivir sin el `basic_auth` — la medición

Quitar el `basic_auth` sólo es defendible si **el API exige sesión de verdad**. No alcanza con que
el listener del gateway pida certificado de cliente: **el proxy de la consola tiene ese
certificado**, así que el navegador de un desconocido llega igual de lejos que el de TENANT_ID. La
pregunta correcta no es "¿se llega?" sino "**¿se llega y contesta con datos?**".

Medido el <private-date> **desde internet**, contra `https://${CONSOLE_HOST}`, **sin cookie de
sesión** y sin ninguna otra credencial — es decir, exactamente lo que tiene un extraño:

| sonda | resultado |
|---|---|
| **24 rutas** `GET` de datos (`/v3/status`, `/v3/accounts/selection`, los 20 `/v3/console/*`, incluida `/v3/console/terminal/*`) | **401** en todas, 83 bytes, `se requiere la cookie de sesión de la consola` |
| `POST /v3/deliveries/query`, `/v3/query`, `/v3/messages`, `/v3/heartbeat`, `/v3/ack`, `/v3/quotas/samples` | **401** |
| `POST /v3/connections/hello` con un cuerpo **válido** y una identidad que no casa con el certificado del proxy | **401**. Es la sonda que discrimina: si la auth hubiera pasado, el `hello` habría muerto más adelante en `403 authenticated identity does not match hello`. Murió antes. |
| `POST /v3/console/messages`, `/v3/console/jobs`, `/v3/console/config/changes` **con `Origin` same-origin** | **401** (sin `Origin` dan `403` por CSRF, que tapa la señal: hay que mandarlo para medir la auth) |
| `/v3/terminal/relay/*` (se autoriza con su token, no pasa por el proveedor de consola) | **401** |
| la raíz `/` | `200`, **686 bytes**: el shell de la SPA, sin un solo dato ni un solo alias adentro |
| `WWW-Authenticate` en cualquier respuesta | **ninguno** — ya no hay contraseña de navegador |

Y con sesión, la misma cuenta ve todo: `/v3/console/observability` 453 KB, `messages` 101 KB,
`audit` 66 KB, `queues` 24 KB, `activity` 15 KB. Después de `POST /v3/auth/logout` (`204`),
`/v3/console/activity` vuelve a **401** y `/v3/auth/session` a `{"authenticated":false}`.

**Lo que hace que esto sea estructural y no una lista de rutas** está en `PasswordAuthProvider.viaFallback()`:
todo lo que no trae cookie se resuelve con la identidad de **máquina** del `fallback` mTLS, y si esa
máquina es del canal `console` —que es el certificado que presenta el proxy en TODO lo que
proxea— el request muere en 401. Por eso cubre las rutas que todavía no existen. Los adaptadores
(`channel: adapter`) y el recolector de cuotas no tocan esta puerta: siguen entrando por su
certificado, y la flota siguió entregando durante todo el cambio.

🔴 **Si algún día `CAUCE_AUTH_PROVIDER` deja de ser `password`**, o el `fallback` deja de ser
`mtls`, o el certificado del proxy cambia de canal, esta medición deja de valer y la consola queda
**abierta a internet**, porque no hay segunda puerta. Volver a correr las sondas de esta tabla
—estaban en `ops/console-login/` y el script del parche ahora vive en (retirado; historial en git) (censo 2026-08-27; sin uso en este host)— antes de dar por bueno cualquier cambio en el
proveedor de autenticación.

El aviso permanente de "esta consola no tiene login de usuario" que mostraba la SPA **ya no
aparece**: era condicional al proveedor, y el proveedor ahora es `password`.

## 5. La alternativa OIDC, que sigue estando

`services/gateway/src/oidc-bff.ts` implementa un BFF OIDC completo (authorization code + PKCE,
sesión cifrada en `gateway_oidc_sessions`, mismas cookies y mismo CSRF) y se enciende con
`CAUCE_AUTH_PROVIDER=oidc` más las URLs del proveedor. Es más trabajo de configuración y depende
de un proveedor externo; el login por contraseña existe justamente para no necesitarlo. Las dos
variantes son excluyentes: el gateway corre una o la otra.

## 6. 🔴 El agujero que abrió la guarda por RUTA, y la lista blanca del borde (<private-date>)

La medición del §4 valía mientras la guarda era **por canal**: cualquier principal del canal
`console` —el certificado que el nginx del contenedor presenta en TODO lo que proxea— moría en 401
en cualquier endpoint. Eso cubría también las rutas que todavía no existían.

Esa guarda se cambió a **por ruta** (`isConsoleSurface`, ver §3 y `password-auth.ts`) porque la
guarda por canal dejó a la flota sin plano de control: `console-client` es el único principal mTLS
con permiso `control` y el que usan el guardia médico y las herramientas de operación para
publicar, así que `POST /v3/messages` empezó a devolver 401. El cambio destrabó el bus **y volvió a
abrir la superficie de bus a través del dominio público**. Medido desde internet, sin cookie y sin
ninguna credencial:

| sonda (antes de la lista blanca) | resultado |
|---|---|
| `GET /v3/accounts/selection?provider=claude` | **200 con datos reales**: `tenant_id: TENANT_ID`, `alias: AGENT_ALIAS`, el inventario de cuentas y las **rutas de los archivos de credenciales** |
| `POST /v3/messages` | **202**, publicando en el bus **como `TENANT_ID:AGENT_ALIAS`** (medido por el turno anterior; en la re-medición con cuerpo vacío daba `400` de validación de esquema del gateway, o sea que la autenticación ya había pasado) |
| `GET /v3/status`, `GET /v3/console/*` | 401 — la superficie de consola sí seguía cerrada |

O sea: cualquiera con la URL podía inyectar entregas a la flota con identidad de operador.

**El arreglo aplicado no toca ni el gateway ni el contenedor de la consola.** El dominio público no
tiene por qué proxear la superficie de bus en absoluto: la SPA sólo usa `/v3/auth/*`, `/v3/status` y
`/v3/console/*` (enumerado en `console/src/api/client.ts` y
`console/src/features/terminal/api.ts`; `/v3/ws` es el bus de los agentes y la propia SPA lo
dice en `LiveFleetPage.tsx`). En el Caddy del VPS, **lista blanca**, no negra —una lista negra se
queda vieja con la próxima ruta que alguien agregue al gateway—:

```
${CONSOLE_HOST} {
  @bus_privado {
    path /v3/*
    not path /v3/auth/* /v3/status /v3/console/*
  }
  route {                       # `route` conserva el orden escrito
    respond @bus_privado "not found" 404
    reverse_proxy https://${PRIVATE_ADDRESS}:8444 {
      header_up -X-Cauce-Operator
      transport http { tls_insecure_skip_verify }
    }
  }
}
```

Medido desde internet después del `systemctl reload caddy`:

| sonda | antes | después |
|---|---|---|
| `GET /v3/accounts/selection?provider=claude` | 200 con datos reales | **404** `not found` (cuerpo del borde, no JSON del gateway) |
| `POST /v3/messages`, `/v3/ack` | 202 / 400 del gateway | **404** del borde |
| `GET /v3/heartbeat`, `/v3/query`, `/v3/deliveries`, `/v3/connections`, `/v3/quotas/samples`, `/v3/ws` | llegaban al gateway | **404** del borde |
| evasiones: `/v3/console/../accounts/…`, `%2e%2e`, `/V3/…`, `/v3/%61ccounts/…`, `//v3/…`, `/v3//accounts/…` | — | **404** en las 8 (Caddy normaliza y decodifica **antes** de casar, así que falla cerrado) |
| `/`, `/assets/*.js`, ruta del router (`/cuentas`) | 200 | **200** |
| `GET /v3/auth/session` | 200 | **200** `{"authenticated":false,"login_mode":"password"}` |
| `GET /v3/status`, `/v3/console/*` sin sesión | 401 | **401** — la guarda de sesión **no** se reabrió |
| `GET /v3/console/terminal/ws` | cuelga (llega al relay) | **cuelga igual**; `/v3/ws` en cambio corta en 404 en 1 s — ése es el discriminador |

La flota siguió entregando durante todo el cambio (los adaptadores no pasan por este dominio: van
por la tailnet a `${PRIVATE_ADDRESS}:8443`). Después del reload: 16 leases vivos latiendo a <15 s y tres
entregas reales a `done` en tenants distintos (TENANT_ID/AGENT_ALIAS <private-time>, TENANT_ID/AGENT_ALIAS <private-time>,
TENANT_ID/AGENT_ALIAS <private-time>).

**Para revertir**: `cp /etc/caddy/Caddyfile.bak-antes-lista-blanca-<TS> /etc/caddy/Caddyfile` y
`systemctl reload caddy`. El parche es idempotente y busca el marcador `LISTA-BLANCA-CONSOLA`.

### Lo que falta: separar identidades (preparado, NO aplicado)

La lista blanca es una mitigación de borde: cierra el dominio público, pero **el certificado
`console-client` sigue siendo un principal `operator` con `permissions:[route,read,control]`**, y
el nginx del contenedor lo sigue presentando en todo lo que proxea. El arreglo estructural es
partirlo en dos, tal como lo pide el propio comentario de `password-auth.ts` (usar `console-client`
para el guardia médico es *prestado*):

| principal | quién lo usa | `channel` | `roles` | `permissions` |
|---|---|---|---|---|
| `console-proxy` (nuevo) | sólo el nginx de `cauce-v3-prod-console-1` | `console` | `[]` | `[]` |
| `ops-control` (nuevo) | guardia médico (`ops/guardias/cauce-envoltorio-local.sh`) y herramientas de operación | `adapter` | `["operator"]` | `["route","read","control"]` |
| `console-client` | — | se **retira** de `mtls_identities.json` cuando los dos anteriores estén medidos |

Con `console-proxy` sin permisos, una ruta de bus que se filtrara por el proxy muere en 403 aunque
el borde fallara: la consola sigue andando porque ahí el principal sale de la **cookie de sesión**,
no del certificado. Es defensa en profundidad de la misma cosa.

Secuencia sin recrear nada:

1. Emitir los dos pares cert/key con la CA de cliente del gateway y registrar sus huellas en
   `/etc/cauce-v3/secrets/identities/mtls_identities.json`. El gateway **relee ese archivo por
   request** (`HashedMtlsIdentityFileProvider.resolve` → `readIdentityFile`, caché de 1 s), así que
   **no hay que reiniciar el gateway ni recrearlo**.
2. Apuntar el guardia médico a `ops-control` (`--cert /etc/cauce-v3/pki/ops-control.crt`) **antes**
   de tocar nada más, y probar `cauce probar <alias>` de punta a punta.
3. Poner los bytes de `console-proxy` **encima** de `/etc/cauce-v3/pki/console-client.{crt,key}` y
   `docker exec cauce-v3-prod-console-1 nginx -s reload`. ⚠️ **En sitio** (`cat nuevo > archivo`),
   nunca `mv`/`install`: el bind-mount es de un **archivo**, y cambiar el inodo deja al contenedor
   con el certificado viejo y con cara de que el cambio se aplicó. Así **no hace falta recrear el
   contenedor `console`**; si el reload no lo tomara, ahí sí toca recrear con rutas nuevas.
4. Medir con sesión: login, una vista con datos, y el PTY. Si el login rompiera (habría que
   comprobar si `POST /v3/auth/login` y `GET /v3/auth/session` toleran un principal de transporte
   sin permisos), se revierte reponiendo los bytes viejos y otro `nginx -s reload`.
5. Recién entonces borrar la entrada `console-client` de `mtls_identities.json`.

Riesgo abierto que hay que medir en el paso 4, no suponer: **no está probado** que `/v3/auth/*` y
el relay de terminal funcionen con un principal de transporte con `permissions:[]`.

El script del parche de Caddy quedó en (retirado; historial en git) (censo 2026-08-27; mismo contenido que se corrió en el VPS como `/root/patch_caddy.py`); ya no se conserva copia activa en `ops/console-login/`.
