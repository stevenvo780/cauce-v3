# Informe final de Cauce V4

**Estado: cerrado el 27-oct-2026 por decisión del dueño.** Lo publicado es `e26305dc` (despliegue 139), igual a `dev` y a `main`; después solo hay commits de documentación. Este texto solo afirma lo que tienes probado, con su fuente. Lo que falta va en «Qué queda pendiente», con quién lo cierra: queda para la estrategia siguiente, no disimulado.

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

- Dónde lo ves: `deploy/HISTORIAL.md` (última fila: 26-oct, despliegue 139, commit `e26305dc`) y los recibos en `.delegados/v4/recibos/gate/`.

## Qué está verificado en producción

| Qué | Recibo |
|---|---|
| Los 17 agentes de las dos empresas con arriendo vivo y los 9 servicios healthy | 27-oct 00:15 (latido de 1–9 s; consola 200; ejecutores de server2, Praxis y el VPS activos) |
| Contexto editado en la consola y aplicado en el turno siguiente | 26-oct: Argos v1, Jarvis v2, Sócrates v2 y Zeus v3 (directiva del dueño; respuesta con adopción y consumo; «Aplicada · Sincronizado»), GOAL §6 |
| Hades responde sin esperar despertares de fondo | 26-oct 22:50, despliegue 138: nonce en 29 s (bf796b85) |
| Copia de un espacio: crear, descargar con su SHA y restaurar | 26–27-oct: Jarvis, Sócrates y Zeus; descarga por la consola con el SHA del recibo y restauración aislada `restored`, idéntica al origen (GOAL §5, item de copias) |
| El VPS como ordenador solo de copias | 26-oct 23:06: enrolado por invitación desde Ajustes → Computadoras, `execution_scope: backups`, sin capacidades de flota |
| Zeus en el espacio estándar con turno real | 26-oct 23:53: aplicado con recibo, entrega `done` con el nonce exacto (GOAL §6) |
| Adaptadores V3 de Steven en la release vigente | 27-oct: Jarvis, Sócrates y Zeus en `live-e26305dc09c1`, cada uno con entrega real verificada |
| «Mis cuotas» de punta a punta en el segundo servidor local | 25-oct 00:35–00:40, GOAL §3 |
| Agente creado desde la consola que responde en el chat | 25-oct, `zz-canary-144` con login de dispositivo y respuesta exacta, GOAL §6 |
| Agentes en servidores locales con terminal desde la consola | 20–25-oct, GOAL §5 (Gaia, Hades, Argos y Hegel en server2; terminales de Argos y Hegel) |
| Límite de registro por IP real y roles de base de datos sin superusuario | 25-oct, GOAL §1 |
| Historial de contextos en GitHub y su recuperación sin red | 25-oct, GOAL §6 de criterios |
| Origen liberado tras migrar, medido | 24-oct, GOAL §5 |

## Qué queda pendiente

Cerrado el GOAL, esto pasa a la estrategia siguiente. Nada de lo que sigue impide el uso diario actual.

### Lo cierras tú, Steven

1. **Praxis**: «Aplicar al agente» del contexto de operador, perseo y teseo, y la actualización en cola de perseo.
2. **Registro de un usuario nuevo en producción**, una vez, con el recorrido completo (en local está en verde).
3. **`cauce login`** en tu CLI: la sesión caducó; con ella se prueba `cauce <alias>` de un agente dinámico.
4. **Disco del VPS al 95 %** (24 GB libres): decidir qué se mueve o se amplía. El crecimiento viene sobre todo de `ws-humanizar`.
5. **Espacios de Miguel e Isa** (Janus, Iza, Atlas, Kratos y Salva): sus copias y su espacio estándar los hace su dueño, o tú con su permiso.
6. **Panel de GitGuardian**: marcar los falsos positivos históricos.

### Lo cierra el equipo en la siguiente etapa

1. **Espacio estándar en Kant y Astra.** Kant, cuando no lo estés usando, con `sembrar-recibo-contexto.py` antes de aplicar (la lección de Zeus). Astra espera el drop-in `KillMode=process`. Después, sus copias.
2. **Terminal por CLI para la flota dinámica**: el CLI instalado necesita el checkout para `ws` y `session-limits`; empaquetarlo.
3. **Mensaje claro cuando la copia de un espacio falla porque aún no tiene estructura estándar**: hoy la consola solo dice «Fallida».
4. **Adaptadores V3 restantes en la release vigente**: Kant, Astra, Salva y los de Miguel (Atlas y Kratos sin reiniciar el árbol compartido).
5. **TUI del arnés en contenedor V4 y «Detener» entre releases**; cuota consultada agente por agente desde su ficha.
6. **Retirar el código legacy** (`fleet_adoption_probe_*`, `fleet_executor_legacy*`): sigue en uso, y la parte de copias legacy es nueva y se queda.
7. **Rollout del PTY** para que la espera de hechos medidos (8fcb24d1) llegue a las unidades del VPS.

## Cómo operar

- Uso diario y administración: `docs/v4-guia.md`.
- Desplegar y operar el sistema: `docs/operacion.md` (sección «Desplegar V4»).
- Copias y restauración de espacios: `docs/v4-runbook-copias.md`.
- Diagnosticar un fallo: `cauce diagnose <id>` (traza, operación, sesión, entrega, copia o evento de auditoría) y `docs/v4-diagnostico.md`.
- Qué pruebas existen y cómo correrlas: `docs/v4-pruebas.md`.
- Plan y estado de la migración de agentes: `docs/v4-migracion-plan.md`.

## Fuentes

Este informe se apoya en `GOAL.md` (estado verificado a 27-oct), en los informes de la tanda en `.delegados/v4/informes/` — en particular `d3-informe-final-1025.md` (esqueleto anterior), `g1-auditoria-marcas-1025.md` y `g2-cierres-auditoria-1025.md` (auditoría de las marcas y sus cierres) —, en `deploy/HISTORIAL.md` hasta su fila del 26-oct (despliegue 139) y en los commits citados en el texto. Lo que no tenía fuente no se afirma: está en pendientes.
