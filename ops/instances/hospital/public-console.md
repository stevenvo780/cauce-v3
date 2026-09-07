# Dominio de la consola Hospital

URL: `https://cauce-hospital.stevenvallejo.com`.
Cuenta: `steven@hospital.local`, rol operador, tenant Hospital.

La consola permite consultar actividad, agentes, entregas, errores y auditoría,
además de los controles habilitados para el operador. La publicación del dominio
no habilita capacidades de terminal que no estén instaladas en esta instancia.

## Configuración

- DNS Vercel: registro A `cauce-hospital` de `stevenvallejo.com` hacia `51.222.206.51`.
- Caddy importa `/etc/caddy/hospital-console.caddy`, instalado desde `console.Caddyfile`.
- Caddy obtiene y renueva el certificado público automáticamente. Su conexión al
  upstream `172.17.0.1:18444` usa TLS verificado con SNI `console` y la CA pública
  de esta instancia, instalada en `/etc/caddy/hospital-cauce-ca.crt`.
- La CA es un certificado público: no se copian claves privadas ni certificados
  de cliente. El mTLS entre nginx y gateway conserva su configuración.
- `CAUCE_CONSOLE_ORIGINS` debe incluir exactamente la URL pública. El `Host`
  original se conserva para las comprobaciones de mismo origen y WebSocket.
- El proxy publica `/v3/auth/*`, `/v3/console/*` y `/v3/status`. El resto de `/v3`
  devuelve 404; las rutas de agentes no se publican mediante la identidad mTLS
  interna del proxy de consola.
- La SPA usa API del mismo origen. Se conserva el login por contraseña, cookie
  HttpOnly/Secure y CSRF; la publicación no altera la cuenta ni su contraseña.

La cuenta y contraseña existentes se recuperan en una terminal privada del VPS:

```sh
sudo hospital-cauce-access
```

No redirigir esa salida a logs, mensajes ni artefactos públicos.

## Comprobación y reversión

Antes de recargar: validar la configuración completa con `caddy validate`,
incluyendo el certificado de confianza. Conservar una copia del Caddyfile anterior
y el ID del registro DNS creado. Añadir solamente el import de Hospital consola,
sin reemplazar los sitios existentes.

Después de publicar, verificar certificado y redirección HTTPS desde fuera del
VPS, login real, tres agentes activos, actividad/entregas/auditoría, bloqueo sin
sesión y rechazo de mutaciones sin CSRF. Comprobar por separado la web del hospital.
No usar `tls_insecure_skip_verify` ni `curl -k` como aceptación.

Reversión: quitar únicamente el import agregado, validar y recargar Caddy; retirar
el registro DNS por su ID sólo si sigue apuntando al valor instalado. Mantener
consola, gateway y agentes activos en su enlace privado. Un cambio posterior de
otro operador exige reconciliar el archivo antes de restaurarlo.

Referencias: [proxy HTTPS y conservación de Host en Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#https),
[gestión de DNS con Vercel](https://vercel.com/docs/cli/dns).
