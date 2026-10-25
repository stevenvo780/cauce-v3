# q10b — Reinicio real del gateway, aviso rápido y diagnóstico de la banda fija

Estado: COMPLETA en los puntos 1 y 2; el punto 3 queda con registro de diagnóstico porque la banda de qa4 no se reproduce.

## 1. Reinicio real del gateway (laboratorio `lab`, `zz-canary-qa-q10b`)
En el laboratorio el gateway no es un contenedor aparte: corre dentro del proceso del runner. Un `docker restart` del runner mataría también Vite, la BD y la URL, así que no prueba lo que se pide. Añadí al fixture (`tests/e2e/qa-lab-app.ts`) un reinicio real: `docker kill -s USR2 <runner>` cierra el servidor Fastify, espera un tiempo configurable (`private/gateway-restart-down-ms`, 6 s por defecto) y lo levanta de nuevo en el mismo puerto y con la misma BD. Mientras está caído, el proxy de Vite contesta 502 como haría Caddy (el suyo por defecto es 500, que la consola no trata como caída).

Un agente con navegador real (Chromium, escritorio 1440×900 y móvil 390×844): una página observa el chat y otra envía.
| Caso | Escritorio | Móvil |
|---|---|---|
| Línea base, 10 s | sin banda | sin banda |
| Reinicio con 6 s de caída | banda a los 2,3 s; desaparece a los 2 s de volver; mensaje nuevo en 2,5 s | banda a los 2,1 s; desaparece a los 2 s; mensaje en 2,5 s |
| Reinicio con 25 s de caída | banda a los 2,4 s y se mantiene los 25 s («No hay conexión…» con «Recargar la página»); desaparece a los 3 s; mensaje en 1,8 s | banda a los 2,1 s, se mantiene; desaparece a los 3 s; mensaje en 1,3 s |

La consola reconecta sola sin recargar y el mensaje llega en menos de 10 s en todos los casos. Registros en `recibos/q10b-reconexion-reinicio-gateway-1025/final.log`; capturas `d-aviso-reinicio.png` y `m-aviso-reinicio.png`.

## 2. Aviso en 10 s o menos con el servidor colgado
Cambio de producto: latido del canal en tiempo real (`console/src/api/connection-heartbeat.ts`, `CauceApi.startHeartbeat`, arrancado por `ReconnectNotice`).
- Cada 3 s pide `/v3/auth/session` con 2,5 s de espera. Cuenta como caída un 502/503/504, un error de red o un vencimiento.
- Avisa («No hay conexión…») a los 2 fallos seguidos. Un fallo aislado no avisa; cualquier otra respuesta (200, 401…) cuenta como servidor vivo.
- Sin falsos positivos por segundo plano: con la pestaña oculta no se cuentan fallos, y al volver a primer plano, `pageshow` u `online` se reinicia la cuenta y se pide un latido inmediato.
- El latido también retira el aviso en cuanto el servidor contesta, aunque ninguna vista esté sondeando.

Medición con `docker pause` del runner 25 s (servidor colgado de verdad): aviso a los **7,6 s** en escritorio y **7,5 s** en móvil (antes, 30 s); desaparece 3 s después de reanudar; mensaje nuevo en 2,0-2,3 s. Sin avisos en 90 s de reposo ni en 12 recargas en escritorio y móvil.
Pruebas nuevas (`connection-heartbeat.test.ts`, 6): colgado avisa antes de 10 s y no antes del segundo fallo, fallo aislado, 401 vivo, recuperación, pestaña oculta, y que el registro no guarda rutas ni datos. Toda la suite de la consola pasa (220 ficheros, 2230 pruebas); tsc y eslint limpios.

## 3. Banda fija de qa4
No se reproduce. En móvil y escritorio: 3 recargas de Cuotas, Ajustes y Mensajes (perfil incluido), vuelta de segundo plano con visibilitychange después de reiniciar el gateway estando oculto, vuelta por `pageshow` de bfcache y 90 s de reposo: 0 bandas (`bg-d.log`, `bg-m.log`).
Hipótesis sin confirmar: un aviso `unreachable`/`reconnecting` que quedaba al volver de segundo plano en una vista sin sondeo no se retiraba hasta una lectura nueva; el latido lo retira ahora. Para diagnosticarlo en producción, la consola guarda un registro con vocabulario cerrado (`connection-diagnostics.ts`): carga (tipo de navegación), visibilidad, pageshow/pagehide, online/offline, cambios de aviso, fallos de latido y lecturas agotadas. Solo nombre del evento, un detalle corto (estado HTTP o `timeout`) y hora; sin rutas, cuerpos, identificadores ni datos personales. Se conserva en `sessionStorage` y se lee desde la consola del navegador con `cauceDiagnosticoConexion()`.
Ajuste de prueba: `agent-navigation.test.tsx` prohibía cualquier `setItem`; ahora solo exceptúa la clave del registro de conexión.

## Pendiente y riesgos
- El gateway reiniciado de verdad es el del laboratorio; la cadena Caddy de producción no se probó (sin producción). Caddy devuelve 502 en ese caso, que es lo que emula el fixture.
- Un servidor que tarde más de 2,5 s dos veces seguidas en `/v3/auth/session` mostrará el aviso; se retira solo al siguiente latido correcto.
- Sin pasar el gate completo; ejecutadas las pruebas de la consola.

## Recibo de recursos
Laboratorio `q10b` cerrado con `qa-lab.sh down`: 0 contenedores, redes, volúmenes e imágenes (`recibos/q10b-reconexion-reinicio-gateway-1025/inventario-final.txt`).
