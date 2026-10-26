# Sesiones de consola y del CLI

La consola y `cauce login` comparten el formato de sesión, no la sesión: cada uno hace su propio login
y tiene su propio `sid`. Es la cookie `__Host-cauce_session` (`HttpOnly; Secure; SameSite=Strict`), un
JWT HS256 firmado por el gateway. El CLI guarda su cookie en su archivo de sesión
(`~/.local/state/cauce-v3/console-session.json`, modo 600).

## Plazos

| Plazo | Valor por defecto | Variable | Qué significa |
|---|---|---|---|
| Ventana de inactividad | 24 h | `CAUCE_CONSOLE_SESSION_TTL_SECONDS` (60 s a 7 d) | Cada petición autenticada empuja el vencimiento a «ahora + ventana». Sin uso, la sesión caduca a las 24 h. |
| Tope absoluto | 30 días desde el login | `CAUCE_CONSOLE_SESSION_MAX_SECONDS` (de la ventana a 90 d) | Ninguna actividad extiende la sesión más allá del tope; después hay que volver a entrar. |

El instante de login ancla el tope: es el claim `iat`, que nunca cambia al renovar, o `auth_time` si la
sesión nació de aprobar un dispositivo (ver abajo). El vencimiento (`exp`) es lo que se desliza,
siempre acotado por ese instante más el tope. `GET /v3/auth/session` informa en `expires_at` el
vencimiento ya renovado.

## Cómo se renueva

- El gateway añade una `Set-Cookie` con el nuevo vencimiento a la respuesta de cualquier petición
  autenticada con la cookie, siempre que la extensión sea de al menos una 24ª parte de la ventana
  (1 h con 24 h): no reescribe la cookie en cada llamada. Mantiene `sid`, token CSRF, sello de
  credenciales y empresa activa.
- **Consola**: ya consulta `GET /v3/auth/session` cada 60 s mientras está abierta; esa consulta
  renueva en segundo plano y el navegador guarda la cookie nueva. Una pestaña cerrada más de 24 h
  pide login.
- **CLI**: `ConsoleSessionClient` y `ContextClient` (usados por `cauce login --status`, `cauce spaces`,
  `cauce-diagnose` y los comandos de contexto) leen la `Set-Cookie` de la respuesta y reescriben el
  archivo de sesión de forma atómica (temporal 600 + `rename`). `cauce login --status` basta para
  mantenerla viva.
- `cauce login --renew` sigue siendo el camino cuando la sesión ya caducó: vuelve a pedir la
  contraseña (`--renew` y `--dispositivo` son excluyentes). Una sesión caducada no se revive.
- **Flujo de dispositivo** (`cauce login --dispositivo`): aprobar un dispositivo no cuenta como login
  nuevo. La aprobación guarda el instante de login de la sesión que aprueba
  (`device_authorizations.session_auth_at`, migración 094) y la sesión emitida lo hereda como claim
  `auth_time`, de modo que su tope es el de la sesión de origen. Encadenar aprobaciones no extiende el
  acceso más allá del tope; pasado el tope, la aprobación se rechaza y hay que volver a poner la
  contraseña.

## Qué no se relaja

- Se relee el usuario en cada petición: `active=false` o un cambio de contraseña (sello de
  credenciales) cortan la sesión aunque no haya caducado.
- **Logout** borra la cookie y registra el `sid` en `console_session_revocations` (migración 093)
  hasta el día en que el tope lo habría cerrado; una copia de la cookie deja de valer y no puede
  mantenerse viva renovando. Si la base no responde, la cookie se borra igual, el error se registra
  y el proceso rechaza esa sesión hasta que se reinicie.
- Una sesión caducada, pasada del tope, revocada o de un usuario retirado falla la carga y no recibe
  cookie nueva: la renovación solo ocurre sobre una sesión que ya superó todas las comprobaciones y
  una respuesta no exitosa (>= 400) no renueva.
- El aislamiento por empresa no cambia: la empresa activa (`cmp`) se revalida contra la base en cada
  decisión de autoridad.
- Cambio de empresa y login emiten su propia cookie; la renovación no la pisa en esa misma respuesta.
  El cambio de empresa también desliza el vencimiento. El gateway recuerda en memoria la empresa vigente
  de cada `sid`: una cookie emitida antes del cambio (petición lenta o sondeo en curso) no se renueva y
  no puede devolver la empresa anterior.
- Si la autoridad de la sesión ya no vale (`GET /v3/auth/session` responde `authenticated:false`), esa
  respuesta tampoco renueva la cookie.
