# Login de verdad para la consola

Qué falta para que `consola.elenxos.com` deje de estar protegida por una contraseña compartida y
pase a tener sesión de usuario. **Nada de esto está desplegado**: es la lista exacta de lo que hay
que decidir y configurar, y qué decisiones son de Steven.

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

El mTLS de este dibujo es **entre servicios** (nginx→gateway), no entre el navegador y nada. No lo
toca ninguno de los cambios de abajo: los agentes siguen entrando por su propio certificado de
cliente exactamente igual. **El login humano se suma, no reemplaza.**

## 2. Lo que YA está hecho y no hay que escribir

- **Gateway**: `services/gateway/src/oidc-bff.ts` implementa el BFF completo — authorization code
  con PKCE, verificación de `iss`/`aud`/`azp`/`nonce`/`at_hash`, sesión cifrada AES-GCM en la tabla
  `gateway_oidc_sessions` (ya existe en producción), cookies con prefijo `__Host-`, `SameSite`,
  token CSRF exigido en todo `POST/PUT/PATCH/DELETE` bajo `/v3/`, refresh con validación de que el
  `sub` no cambió, y las cuatro rutas `/v3/auth/{login,callback,session,logout}`.
- **Consola**: `apps/console/src/features/auth/` — la puerta que bloquea la aplicación hasta que el
  servidor confirma la sesión, la pantalla de login, la identidad con su vencimiento en la barra
  superior, y el cierre de sesión que **vuelve a preguntarle al servidor** en vez de creerse su
  propio optimismo. Cubierto por `AuthGate.test.tsx`.

O sea: no hay que inventar criptografía ni escribir un esquema de sesión. Falta **configurar**.

## 3. Lo que hace falta — y es decisión de Steven

### 3.1 Elegir el proveedor de identidad

El BFF habla OIDC estándar (authorization code + PKCE). Sirve cualquiera de estos, y la elección
cambia sólo las cuatro URLs:

| opción | a favor | en contra |
|---|---|---|
| **Google Workspace / cuenta Google** | cero infraestructura nueva; las cuentas ya existen | hay que registrar un cliente OAuth y restringir por dominio o por lista de correos |
| **Authentik / Keycloak** autoalojado en el VPS | control total, grupos y roles propios, sirve para el resto del ecosistema | un servicio más que mantener y respaldar |
| **Auth0 / Entra ID** | gestionado | dependencia externa de pago |

Sea cual sea: **hay que decidir quién puede entrar**. El BFF autentica (dice quién sos), no
autoriza (no dice si podés). La lista de sujetos admitidos o el claim de grupo que habilita es una
decisión de producto que no tomo yo.

### 3.2 Los secretos — ninguno está en el repositorio, y ninguno debe estarlo

| variable | qué es | quién lo genera |
|---|---|---|
| `CAUCE_OIDC_ISSUER` | issuer del proveedor | el proveedor |
| `CAUCE_OIDC_AUTHORIZATION_URL` | endpoint de autorización | el proveedor |
| `CAUCE_OIDC_TOKEN_URL` | endpoint de token | el proveedor |
| `CAUCE_OIDC_JWKS_URL` | JWKS para verificar firmas | el proveedor |
| `CAUCE_OIDC_AUDIENCE` | audiencia esperada en el token | el proveedor |
| `CAUCE_OIDC_CLIENT_ID` | id del cliente | al registrar la app |
| `CAUCE_OIDC_CLIENT_SECRET_FILE` | **ruta a un fichero** con el secreto | al registrar la app |
| `CAUCE_OIDC_REDIRECT_URI` | `https://consola.elenxos.com/v3/auth/callback` | fijo |
| `CAUCE_OIDC_SESSION_KEY_FILE` | **ruta a un fichero** con **exactamente 32 bytes** de clave | `openssl rand 32 > <ruta>` en el host |
| `CAUCE_AUTH_PROVIDER` | pasa de `mtls` a `oidc` | — |

El gateway lee los dos secretos **desde ficheros**, nunca desde una variable de entorno con el
valor adentro. Van como secretos de Docker, con permisos `600`, fuera del repositorio.

⚠️ **`CAUCE_AUTH_PROVIDER=oidc` cambia el proveedor para TODO el gateway**, y los agentes entran
hoy por `mtls`. Antes de cambiarlo hay que confirmar contra el código cómo conviven los dos
proveedores en el mismo proceso: si no conviven, la consola necesita su propio listener (por
ejemplo un segundo puerto con `oidc` mientras `:8443` sigue en `mtls`). **No lo probé** — es la
primera verificación a hacer antes de tocar nada, y puede cambiar la forma del despliegue.

### 3.3 El agujero que hay que cerrar junto con esto

Con OIDC encendido, **el `X-Cauce-Operator: steven` fijo de Caddy y de nginx tiene que
desaparecer** y la identidad del operador tiene que salir del `sub` de la sesión. Mientras esa
cabecera la ponga el proxy, el login no sirve de nada para la auditoría: seguiría diciendo
`steven` sea quien sea el que entró. Y el `basic_auth` de Caddy se saca en el mismo cambio, o
quedan dos puertas y la nueva no aporta.

`tls_insecure_skip_verify` en el `reverse_proxy` de Caddy también convendría cambiarlo por la CA
interna, ya que se va a tocar el bloque igual.

## 4. Orden sugerido

1. Comprobar si `oidc` y `mtls` conviven en un mismo gateway (§3.2). Esto manda sobre todo lo demás.
2. Steven elige proveedor y la regla de quién entra.
3. Registrar el cliente OIDC con el redirect URI de arriba; guardar los dos ficheros de secreto.
4. Encender `CAUCE_AUTH_PROVIDER=oidc` en un stack de prueba y verificar el ciclo completo:
   login → `session` con `sub` real → una escritura con CSRF → `logout` → `session` sin sesión.
5. Recién ahí: sacar `basic_auth` y `X-Cauce-Operator` fijo de Caddy y de nginx.
6. Confirmar que los agentes siguen entrando por mTLS **después** del cambio, con una entrega real.

Mientras el paso 4 no esté verificado, la consola muestra el aviso permanente de
"esta consola no tiene login de usuario". Es intencional: es preferible una puerta abierta y
señalizada a un candado dibujado.
