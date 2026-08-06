# Login de verdad para la consola

La consola tiene login de usuario **implementado y probado, pero NO encendido**. Este documento
dice qué protege hoy, qué se construyó, y el encendido exacto — que no está aplicado.

## 1. Qué protege la consola HOY (medido el 2026-08-06)

```
navegador
  │  HTTPS (Let's Encrypt)
  ▼
Caddy @ agora-storage          ← basic_auth: UN usuario, contraseña compartida, bcrypt
  │  reverse_proxy https://100.64.0.6:8444   (tls_insecure_skip_verify)
  │  header_up X-Cauce-Operator steven       ← la identidad la INVENTA el proxy
  ▼
nginx @ cauce-v3-prod-console-1   ← sirve el SPA estático
  │  proxy_pass https://gateway:8443 con certificado de cliente `console_gateway_client_cert`
  │  header X-Cauce-Operator: steven         ← y otra vez acá
  ▼
gateway                          ← CAUCE_AUTH_PROVIDER=mtls
```

Consecuencias, en orden de gravedad:

1. **No hay identidad.** Todo el que pasa el basic auth *es* `steven` para el gateway y para la
   auditoría. Dos personas con la misma contraseña son indistinguibles en `audit_events`.
2. **No hay cierre de sesión.** El navegador reenvía la credencial en cada request hasta que se
   cierra el navegador. No existe "cerrar sesión" ni vencimiento.
3. **No hay revocación granular.** Sacarle el acceso a alguien es cambiar la contraseña de todos.
4. La credencial viaja en cada request en vez de una vez, y no hay segundo factor.

El mTLS de este dibujo es **entre servicios** (nginx→gateway), no entre el navegador y nada. **El
login humano se suma, no reemplaza**: los agentes siguen entrando por su certificado de cliente.

## 2. Lo que ya está construido (código en la rama, sin desplegar)

| pieza | dónde |
|---|---|
| Tabla de cuentas humanas | migración `packages/store/migrations/023_console_users.sql` → tabla `console_users` |
| Derivación de contraseñas | `services/gateway/src/password.ts` — scrypt (RFC 7914, OpenSSL vía Node), formato PHC |
| Lectura de cuentas | `services/gateway/src/console-users.ts` |
| Proveedor de autenticación + rutas | `services/gateway/src/password-auth.ts` — `POST /v3/auth/login`, `POST /v3/auth/logout`, `GET /v3/auth/session` |
| Alta / cambio de contraseña / baja | `services/gateway/src/console-user-cli.ts` (`pnpm console:user`) |
| Puerta del navegador | `apps/console/src/features/auth/` (formulario cuando `login_mode: 'password'`) |

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

### 🔴 El certificado del proxy NO reemplaza a una sesión (medido el 2026-08-06)

Encender `CAUCE_AUTH_PROVIDER=password` **no alcanzaba**. Medido en producción con el login ya
encendido, `/v3/console/*` y `/v3/status` seguían devolviendo **200 sin cookie de sesión**: unos
850 KB de entregas, mensajes, auditoría, colas, cuotas y salas de los **cinco** tenants a cualquiera
que llegara al proxy.

El mecanismo, que no se ve leyendo sólo el código del login:

1. El listener del gateway exige certificado de cliente (`rejectUnauthorized: true`), así que desde
   internet no se le llega: probado, el handshake muere (`curl` devuelve `000`).
2. Pero el nginx de la consola **sí** tiene un certificado, y lo presenta en TODO lo que proxea.
   Ese certificado está provisionado en `mtls_identities.json` como `Steven:kant`,
   `channel: console`, rol `operator`.
3. `PasswordAuthProvider.handles()` es "¿trae cookie?". Sin cookie, el request cae al `fallback`
   mTLS → resuelve el certificado del proxy → entra como operador.

O sea: **el login era una cortina de la SPA** (`AuthGate` escondía la interfaz) y lo único que
tapaba la API era el `basic_auth` de Caddy. Por eso nadie lo había notado.

El arreglo está en `PasswordAuthProvider`: el certificado del proxy es una credencial de
**transporte** ("soy la consola"), no una autorización para leer la flota. Cuando el login está
encendido, un principal de máquina cuyo `channel` sea el de la consola **no** sustituye a una
sesión y el request muere en 401. La puerta está *después* de resolver la identidad de máquina, no
en una lista de rutas: cubre toda ruta presente y futura sin que haya que acordarse de nada.

Lo que NO se toca, y es la mitad que importa no romper: los adaptadores (`channel: adapter`) y el
recolector de cuotas siguen entrando por su propio certificado, y las rutas
`/v3/terminal/relay/*` se autorizan con su token sin pasar por este proveedor. Verificado tras el
despliegue: los 16 alias de los 5 tenants latiendo, y entregas aceptadas y arrancadas por agentes
de Steven, Miguel, Pablo, Jhon e Isa.

### Conviven `password` y `mtls` en el mismo proceso — probado

Era la pregunta abierta de la versión anterior de este documento ("si no conviven, la consola
necesita su propio listener"). **Conviven.** `PasswordAuthProvider` atiende solamente lo que trae
la cookie de consola y delega TODO lo demás a `CAUCE_CONSOLE_PASSWORD_FALLBACK` (por defecto
`mtls`). Comprobado el 2026-08-06 arrancando `services/gateway/src/main.ts` con
`CAUCE_AUTH_PROVIDER=password` + fallback `mtls`: el listener sigue pidiendo certificado de
cliente (`Acceptable client certificate CA names: CN = Cauce V3 Private CA`) y una conexión sin
certificado muere en el handshake, exactamente como hoy.

## 3. El encendido — NO APLICADO

Los pasos 1 y 2 ya están hechos. Del 3 en adelante, no.

1. ~~Migración `023_console_users.sql`~~ **aplicada** en producción el 2026-08-06 (tabla vacía).
   Es aditiva e inerte: nadie la lee hasta que el gateway corra con `CAUCE_AUTH_PROVIDER=password`.
2. ~~Secreto de firma~~ **generado** en `/etc/cauce-v3/secrets/console_jwt_key`.
3. **Desplegar la imagen** con este código (el `migrator` verá la 023 ya aplicada y no hará nada).
4. **`prod.env`** — encender el proveedor y apuntar el secreto:

   ```sh
   CAUCE_AUTH_PROVIDER=password
   CAUCE_CONSOLE_JWT_KEY_PATH=/etc/cauce-v3/secrets/console_jwt_key
   # opcionales, con estos defaults:
   # CAUCE_CONSOLE_PASSWORD_FALLBACK=mtls      ← los agentes siguen entrando por certificado
   # CAUCE_CONSOLE_SESSION_TTL_SECONDS=28800
   ```

5. **Crear la cuenta de Steven** (la contraseña la elige él; no está en ningún archivo del repo):

   ```sh
   DATABASE_URL=... pnpm console:user --email steven@elenxos.com --name "Steven" \
     --role operator --tenant Steven --alias kant
   ```

   Pregunta la contraseña dos veces sin eco. En un contenedor sin TTY se pasa por
   `CAUCE_CONSOLE_USER_PASSWORD`, **nunca por argumento** (los argumentos se ven en `ps`); el
   comando rechaza `--password` a propósito. Reejecutarlo cambia la contraseña e invalida las
   sesiones abiertas. Para dar de baja: `pnpm console:user --email … --deactivate`.

6. **Sacar la identidad inventada de nginx.** Con el login encendido el operador sale del JWT y
   esta línea deja de tener sentido; mientras esté, no hace daño (el `operator_id` autenticado le
   gana), pero es exactamente la cabecera que hacía que la auditoría dijera `steven` entre quien
   entre. En `deploy/nginx-console-tls.conf`, dentro de `location /v3/`:

   ```diff
   -    # Identidad humana del operador para el plano PTY. El certificado de cliente sólo dice
   -    # `Steven:kant` (la consola); el gateway exige además nombrar a la persona, y sin esta
   -    # cabecera todo destino contesta `authorized:false` aunque los grants existan.
   -    # Se fija acá y no en el navegador a propósito: así el cliente no puede atribuirse a otro.
   -    # Si algún día hay más de un humano en la consola, esto pasa a salir de su sesión.
   -    proxy_set_header X-Cauce-Operator "steven";
   +    # La identidad del operador sale de la sesión del usuario (JWT -> console_users), no de
   +    # una cabecera fija. Se borra la que venga del cliente para que nadie se atribuya a otro.
   +    proxy_set_header X-Cauce-Operator "";
   ```

   **No se aplicó a propósito**: quitarla ANTES de encender `CAUCE_AUTH_PROVIDER=password` deja
   todas las sesiones PTY sin atribuir y cierra los destinos de otros tenants
   (`attribution_required`). Va en el mismo despliegue que el paso 4, no antes.

   🔴 **Y arrastra las concesiones del PTY**: con la cabecera, el operador era la cadena fija
   `steven`, y así están escritas las 15 concesiones de `/etc/cauce-v3/terminal/grants.json`. Con
   el login, `operator_id` pasa a ser el **correo** de `console_users` (`principalFor` →
   `operator_id: user.email`), así que ninguna concesión casa y **todos los destinos contestan
   `authorized:false`** aunque la sesión sea válida. Hay que duplicar cada concesión con el correo
   de la cuenta. Hecho el 2026-08-06 para `steven@elenxos.com`, dejando las de `steven` (inertes,
   pero permiten volver atrás si se repone la cabecera). Medido después: 15/15 destinos
   `authorized: true, reason: ok` en los cinco tenants. **Si la cuenta se crea con otro correo,
   hay que repetir esto con ese correo.**

7. **Sacar el basic auth y la cabecera de Caddy** (`/etc/caddy/Caddyfile` en `agora-storage`,
   fuera del repositorio), en el mismo cambio o quedan dos puertas y la nueva no aporta:

   ```diff
    consola.elenxos.com {
   -  basic_auth {
   -    stev $2a$14$…
   -  }
      # La consola de Cauce V3 habla HTTPS con la PKI interna sobre el tailnet.
      reverse_proxy https://100.64.0.6:8444 {
   -    header_up -X-Cauce-Operator
   -    header_up X-Cauce-Operator steven
   +    # La identidad la pone el login de la consola; el proxy no inventa ninguna.
   +    header_up -X-Cauce-Operator
        transport http {
          tls_insecure_skip_verify
        }
      }
    }
   ```

   `tls_insecure_skip_verify` conviene cambiarlo por la CA interna ya que se toca el bloque igual.

8. **Verificar en ese orden**: login → `session` con el correo real → una escritura con CSRF →
   `logout` → `session` sin sesión → **y una entrega real de un agente**, para confirmar que el
   mTLS siguió funcionando después del cambio.

Mientras el paso 4 no esté hecho, la consola muestra el aviso permanente de "esta consola no
tiene login de usuario". Es intencional: es preferible una puerta abierta y señalizada a un
candado dibujado.

## 4. La alternativa OIDC, que sigue estando

`services/gateway/src/oidc-bff.ts` implementa un BFF OIDC completo (authorization code + PKCE,
sesión cifrada en `gateway_oidc_sessions`, mismas cookies y mismo CSRF) y se enciende con
`CAUCE_AUTH_PROVIDER=oidc` más las URLs del proveedor. Es más trabajo de configuración y depende
de un proveedor externo; el login por contraseña existe justamente para no necesitarlo. Las dos
variantes son excluyentes: el gateway corre una o la otra.
