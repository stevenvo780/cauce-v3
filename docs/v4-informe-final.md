# Informe final de Cauce V4

<!-- ACTUALIZAR: estado, versión publicada (hoy `33b88409`; falta el despliegue 105 y el final), esquema efectivo y ubicación final de cada agente. -->

**Estado: borrador para el cierre. V4 todavía no está terminada.** Este texto solo afirma lo que tienes probado hoy, con su fuente. Lo que falte va en «Qué queda pendiente», no disimulado.

Trabajas con tres niveles, y no los mezclo:

- **Probado en local**: funcionó con PostgreSQL, Docker, Git o Chromium reales en el laboratorio.
- **Verificado en producción**: lo recorriste o quedó medido en el sistema publicado.
- **Pendiente**: falta hacerlo, y digo qué paso concreto lo cierra.

## Qué hace hoy Cauce V4

### Empresas, registro y aislamiento

Creas tu empresa, invitas personas con su función, registras ordenadores por invitación de un solo uso y cada empresa solo ve lo suyo: en la pantalla, en el servidor y en las operaciones remotas. Te registras en `/v3/auth/register` y entras como dueño sin que nadie te configure nada a mano.

- Dónde lo pruebas: `tests/integration/v4-rupturas-diagnose-1025.test.ts` y `packages/store/test/console-audit-company-postgres.test.ts` (cada dueño ve solo la auditoría de su empresa, también con un segundo tenant dentro de la misma empresa).
- Cómo funciona por dentro: esquema multiempresa 051–065 con 33 disparadores en la migración 053, y la guardia que recorre las rutas `/v3` con dos empresas (commit `0583c45b`, 294 casos y 0 fallos).

### Gestión completa desde la consola (CRUD)

Creas, editas, detienes, retiras y purgas empresas, salas, personas, agentes, cuentas y ordenadores desde la web, y el efecto ocurre de verdad en Docker y en los ordenadores enrolados. Al purgar ves antes el contenedor y los volúmenes, confirmas con el alias y recibes el resultado físico.

- Dónde lo pruebas: recorrido Chromium + PostgreSQL de entidades y executor contra Docker real (GOAL §6, casillas del 18 y del 25-oct).

### Flota distribuida y agentes en servidores locales

Los agentes ya no tienen que vivir en el servidor principal: Gaia, Hades, Argos, Hegel y los tres de Praxis responden desde el segundo servidor local, con su cuenta, su contexto y su terminal de shell. En la ficha ves en qué ordenador está cada uno, lo detienes y lo arrancas allí.

- Dónde lo pruebas: traslados con copia integral y vuelta atrás ejercida (GOAL §5, cortes del 20–21-oct) y medición antes/después con `ops/scripts/v4-medicion-migracion.sh`.
- Ojo, dos límites de hoy: la TUI del arnés dentro del contenedor y «Detener» entre releases distintas siguen abiertos (más abajo).

### Cuotas que puedes creer

Registras cuentas de proveedor, las compartes entre agentes sin que eso sea un error, y ves saldo, ventanas y próximo reinicio solo cuando el proveedor los informa de verdad. Nunca ves un número inventado: si no hay medición, la pantalla lo dice.

- Por agente: en su ficha, «Consultar cuota» ejecuta el lector de su arnés en el ordenador donde corre.
- Sin agente: en «Mis cuotas» creas un entorno Docker aislado, inicias sesión con tu cuenta, consultas, actualizas el CLI y eliminas el entorno; al eliminarlo desaparecen contenedor y volumen.
- Dónde lo pruebas: recorrido de producción del 25-oct en «Mis cuotas» (crear → iniciar sesión → consultar → actualizar CLI → volver a consultar → eliminar, sin contenedores ni volúmenes al final).

### Oficina y arneses

La oficina dibuja tus salas y agentes reales, sin nada fijo en el código. El color de cada agente es su cansancio: disponible, cansado, agotado, en pausa, sin datos o en error, calculado con la cuota real de su cuenta. Editas el plano y queda guardado al recargar y en otro navegador.

Añadir un arnés nuevo son tres ficheros: su descriptor JSON, su comando y su entrada en `package.json`. El sistema lo valida, lo anuncia con sus capacidades y lo ejecuta por la vía genérica, sin tocar listas repartidas por el código.

- Dónde lo pruebas: `tests/e2e/v4-arnes-alta-laboratorio.test.ts` (arnés de laboratorio dado de alta en tres ficheros y turno interpretado como terminado) y las suites de paridad de descriptores.

### Espacios estándar y contextos con Git

Cada agente tiene su espacio ordenado (`space/{config,context,data,directives,logs,projects,tmp}`) y su contexto versionado en un repositorio Git privado compartido: guardas desde la consola o desde el espacio, ves historial y diferencias, restauras una versión como versión nueva y el repositorio nunca recibe secretos.

- Dónde lo pruebas: `tests/e2e/v4-contexto-recuperacion.test.ts` (remoto caído, reintento, concurrencia y restauración) y las suites del broker Git con PostgreSQL real.
- Límite de hoy: que el agente *use* la versión nueva en su siguiente turno está probado en local con OpenClaw y Grok, y reabierto en producción (más abajo).

### Copias y diagnóstico sin leer código

Descargas la copia de un espacio con su SHA-256 visible y la restauras siguiendo el runbook. Cuando algo falla, no necesitas leer código: la consola muestra la operación con su paso y su causa, y con `cauce diagnose <id>` reconstruyes la cadena (traza, operación, sesión, entrega, copia o el propio evento de auditoría) acotada a tu empresa.

- Dónde lo pruebas: `tests/integration/v4-rupturas-diagnose-1025.test.ts` — host caído, Git de contextos sin red y login rechazado por el proveedor, los tres localizados solo con la consola y `cauce diagnose`.

### Pruebas, despliegue y documentación

Cada despliegue sale de un SHA con recibo de gates ligado (typecheck, lint y empaquetado), backup previo cuando hay migración y humo posterior. La guía de uso y la operación describen solo lo que el sistema hace de verdad.

- Dónde lo ves: `deploy/HISTORIAL.md` (última fila: 25-oct, commit `33b88409`, «smoke OK») y los recibos en `.delegados/v4/recibos/gate/`.

## Qué está verificado en producción

<!-- ACTUALIZAR: confirmar contra el sistema vivo tras el despliegue 105 y el final; no heredar estas filas sin re-comprobar. -->

| Qué | Recibo |
|---|---|
| «Mis cuotas» de punta a punta en el segundo servidor local | 25-oct 00:35–00:40, GOAL §3 (crear, sesión verificada, consultar, actualizar CLI, eliminar; 0 contenedores y 0 volúmenes) |
| Agente creado desde la consola que responde en el chat | 25-oct, `zz-canary-144` con login de dispositivo y respuesta exacta, GOAL §6 |
| Los siete agentes del segundo servidor local responden | 20–21-oct, GOAL §5 y §7 (incluye la confirmación de León del 24-oct para Praxis) |
| Terminales de Argos y Hegel en el segundo servidor local | 25-oct 00:50, GOAL §5 (relay acredita el contenedor exacto; pestaña Terminal desde la consola) |
| Límite de registro por IP real tras el proxy | 25-oct 09:35, GOAL §1 (sexto intento: 429; otro origen sigue en 400) |
| Roles de base de datos sin superusuario en los servicios | 25-oct, GOAL §1 (cuatro logins de runtime; sesiones vivas comprobadas en solo lectura) |
| Historial de contextos en GitHub al día | 25-oct, GOAL §6 de criterios (17 agentes reales, último commit igual a su última versión, outbox `synced` 23/23) |
| Recuperación de contextos con la salida a GitHub cortada | 25-oct 08:32, GOAL §6 de criterios (error visible, reapertura y publicación sola; commit exacto en GitHub) |
| Origen liberado tras migrar, medido | 24-oct, GOAL §5 (−2,18 GB de RAM usada y −8,1 GB de swap tras liberar) |

## Qué queda pendiente

<!-- ACTUALIZAR: tachar aquí con el recibo del despliegue 105/final; hasta entonces, esto manda sobre cualquier casilla suelta. -->

### Lo cierras tú, Steven

1. **Relogin de Zeus**: su login de Claude está caducado; hasta que lo renueves no se puede acreditar su entrega en la release vigente.
2. **Prueba de registro en producción con un usuario nuevo**: el recorrido completo (registrarse, crear empresa y usarla, con ataques cruzados) está en verde en local (365/365). Falta que lo hagas tú una vez en el sistema publicado.
3. **Panel de GitGuardian**: marcar los falsos positivos históricos. El código ya no contiene secretos de producción ni identificadores de cuentas.

### Lo cierra el equipo antes del despliegue final

1. **Despliegue 105 y final**: recorrer en producción «Reiniciar agente» con el agente canario y, después, integrar en `dev`, avanzar `main` y desplegar el candidato con su gate. Hoy lo publicado es `33b88409` y la rama de cierre va por delante.
2. **Aplicación de contextos en producción (N+1)**: ningún agente de producción tiene versión aplicada. Hay que aplicar sin hacer retroceder a nadie (hay cambios posteriores a la siembra sin registrar) y acreditarlo con un turno real por arnés.
3. **«Consultar cuota» desde la ficha de cada agente**: en producción ya mediste algunos, pero el lector dentro del contenedor falló por imagen y por vinculación de cuenta; queda cerrar el recorrido agente por agente.
4. **TUI del arnés en contenedor y «Detener» entre releases**: la terminal web da shell, no la TUI del arnés; y detener un agente creado con una release anterior puede fallar por digest distinto.
5. **Terminal por CLI para la flota dinámica y `cauce <alias>`**: el CLI vigente está instalado y `cauce spaces` recorrido en modo registro; faltan el login en el segundo servidor ya hecho, abrir un agente dinámico por CLI y un `create` físico completo por esa vía.
6. **Adaptadores V3 restantes**: quedan el caso con `KillMode`, la espera cuando la API falla al instante y acreditar la entrega de Salva en su sala.
7. **Espacio estándar en producción, agente a agente**: aplicado en 5 de 9 agentes V3; quedan los que tienen motivo concreto (login caducado, borrador sin enviar y el supervisor compartido que no se puede reiniciar sin tumbar a otros).

## Cómo operar

- Uso diario y administración: `docs/v4-guia.md`.
- Desplegar y operar el sistema: `docs/operacion.md` (sección «Desplegar V4»).
- Copias y restauración de espacios: `docs/v4-runbook-copias.md`.
- Diagnosticar un fallo: `cauce diagnose <id>` (traza, operación, sesión, entrega, copia o evento de auditoría) y `docs/v4-diagnostico.md`.
- Qué pruebas existen y cómo correrlas: `docs/v4-pruebas.md`.
- Plan y estado de la migración de agentes: `docs/v4-migracion-plan.md`.

## Fuentes

Este borrador se apoya en `GOAL.md` (estado verificado a 25-oct), en los informes de la tanda en `.delegados/v4/informes/` — en particular `d3-informe-final-1025.md` (esqueleto anterior), `g1-auditoria-marcas-1025.md` y `g2-cierres-auditoria-1025.md` (auditoría de las marcas y sus cierres) —, en `deploy/HISTORIAL.md` hasta su fila del 25-oct y en los commits citados en el texto. Lo que no tenía fuente no se afirma: está en pendientes.
