# Sesiones de consola y del CLI

La consola y `cauce login` comparten una sola sesión: la cookie `__Host-cauce_session`
(`HttpOnly; Secure; SameSite=Strict`), un JWT HS256 firmado por el gateway. El CLI guarda esa misma
cookie en su archivo de sesión (`~/.local/state/cauce-v3/console-session.json`, modo 600).

## Plazos

| Plazo | Valor por defecto | Variable | Qué significa |
|---|---|---|---|
| Ventana de inactividad | 24 h | `CAUCE_CONSOLE_SESSION_TTL_SECONDS` (60 s a 7 d) | Cada petición autenticada empuja el vencimiento a «ahora + ventana». Sin uso, la sesión caduca a las 24 h. |
| Tope absoluto | 30 días desde el login | `CAUCE_CONSOLE_SESSION_MAX_SECONDS` (de la ventana a 90 d) | Ninguna actividad extiende la sesión más allá del tope; después hay que volver a entrar. |

El instante de login es el claim `iat`, que nunca cambia al renovar; el vencimiento (`exp`) es lo que
se desliza, siempre acotado por `iat + tope`.

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
- `cauce login --renew` sigue siendo el camino cuando la sesión ya caducó (flujo de dispositivo o
  contraseña): una sesión caducada no se revive.

## Qué no se relaja

- Se relee el usuario en cada petición: `active=false` o un cambio de contraseña (sello de
  credenciales) cortan la sesión aunque no haya caducado.
- **Logout** borra la cookie y registra el `sid` en `console_session_revocations` (migración 093)
  hasta el día en que el tope lo habría cerrado; una copia de la cookie deja de valer y no puede
  mantenerse viva renovando.
- Una sesión caducada, pasada del tope, revocada o de un usuario retirado falla la carga y no recibe
  cookie nueva: la renovación solo ocurre sobre una sesión que ya superó todas las comprobaciones y
  una respuesta no exitosa (>= 400) no renueva.
- El aislamiento por empresa no cambia: la empresa activa (`cmp`) se revalida contra la base en cada
  decisión de autoridad.
- Cambio de empresa y login emiten su propia cookie; la renovación no la pisa en esa misma respuesta.
  Una petición lenta lanzada antes del cambio de empresa puede devolver la cookie anterior; el efecto
  es volver a la empresa de origen, nunca ganar autoridad.
