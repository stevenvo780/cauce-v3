# PLAN DE CIERRE — de las respuestas del dueño al primer despliegue real

Escrito 27-08 noche, tras leer TODAS las respuestas de `PENDIENTES-DEL-DUEÑO.md` y verificarlas contra repo, BD de producción y host (7 agentes de investigación, evidencia en los ficheros citados). Este doc es el mapa; los detalles operativos viven en `fase3/`.

## 0. El dictado del dueño, convertido en doctrina

1. **La flota real es lo que está activo HOY en la BD** — 14 agentes, todos enabled (Isa: salva · Jhon: hegel, heraclito, tales · Miguel: atlas, gaia, iza, janus, kratos · Steven: argos, jarvis, kant, socrates, zeus). Pablo se retiró: sus 4 agentes (dedalo, midas, seneca, vulcano) NO existen en la BD y NO se crean. La "contradicción" dedalo/salva era ficción de contextos contaminados: `salva` es de Isa (operativo, 4 bindings reales); dedalo/midas/seneca jamás tuvieron una fila.
2. **Migraciones que solo contaminan se borran, no se editan** — hecho (ver §1).
3. **Los historiales de la BD no valen: backup y poda** — backup automatizado ya existe y está PROBADO con restore verificado; la poda se ejecuta en la ventana (ver `fase3/migraciones.md` §Poda).
4. **Credenciales JAMÁS se borran** — carpeta `ops/private/credentials/` creada (git-ignorada, README rastreado) + regla dura en `ordenes/00-PROTOCOLO.md`.
5. **Una sola fuente** (D3): el compose corre desde el repo; los 4 binds dejan de copiarse a /opt.

## 1. EJECUTADO HOY (27-08 noche, commits en main)

- **Cirugía de migraciones-ficción** (`b4bc7b9`, −2.332 líneas): 029 y 036 fuera del repo con sus `down/`, su suite y su probe; gateway 468/468 verde. La tanda pendiente queda en **10 migraciones limpias**, todas con consumidor de producto verificado (`fase3/migraciones.md` reescrito).
- **Ficción física desmantelada** (mismo commit): `container-aliases.json` → 11 alias reales de este host, `historicalAliases` vacío; manifests/units/configs de Pablo fuera; Pablo fuera de los enums del schema (fail-closed); cred-guard sin ws-pablo.
- **Purga DLQ manual + herramientas de otras máquinas + Makefile raíz** (`7bf24a7`, −1.040 líneas): aprobación textual del dueño; digest de ops regenerado VERDE (de paso arregló un rojo preexistente del gate ops).
- **Carpeta de credenciales** (`affdff6`): `ops/private/credentials/` operativa y verificada con `git check-ignore`.
- **Funciones muertas**: censo simbólico CERRADO y repartido — Codex 28 símbolos (orden activa), Gemini 22 (orden activa), Claude 2 (borrados, `34e7ead`).
- **Órdenes nuevas**: Gemini (anexo + duplicados consola + dientes + P14), MiniMax ronda 8 (mapa, docs-que-mienten, mapa de credenciales, huérfanos v2), Codex anexo 2 (quitar el escalón 036 de 6 tests de migración — probablemente resuelve su tarea 0 de raíz).

## 2. PURGAS QUE NO SE EJECUTARON (y la razón honesta)

- **(d) quota-collector**: tu respuesta pide REHACERLO como parte del CLI integral, no borrarlo; y hay datos de producción vivos entrando por esa vía cuyo productor exacto no está confirmado. Se queda como referencia hasta que el CLI lo absorba.
- **(f) liveness-probe.mjs**: tiene 2 suites REALES dentro del gate obligatorio; mejor destino: cablearlo a `deploy/smoke.sh` (fue escrito para eso y nadie lo hizo).
- **(f) los "7 tests huérfanos" de ops**: la premisa del censo ("sin runner = huérfano") era engañosa — cubren scripts VIVOS (alias-lock-exec, verify-hermes-runtime, el reaper del container-runtime) y para 3 de ellos son la ÚNICA cobertura. Se quedan; el único redundante real (gate-collector.test.mjs, con gemelo wireado) puede caer en una limpieza futura.
- **(c) console-legibilidad**: NO es basura — son sondas reales contra Chrome headless que miden contraste/tipografía/CSP de la consola. Útiles justo para el mega-refactor que quieres. Pregunta abierta en §6.

## 3. VISTAS DE CONSOLA — veredicto razonado (lo pediste delegado)

El reporte anterior medía **alias de redirección**, no vistas (4 de 8 veredictos se caían). Real:
- **Se retiran**: `jobs` (lápida de 20 LOC) y `chains` (pestaña del cajón + su API client, ~295 LOC). Lo ejecuta Gemini en una ronda próxima con el mapa exacto.
- **Se parten**: `topology` → SOLO muere `hypergraph.css` (256 LOC huérfanas); el resto de `features/topology/` es EL MOTOR DE LAYOUT DE /live (1.348 LOC) — renombrarlo a `features/live/hypergraph/` en el mega-refactor para que ninguna auditoría futura vuelva a proponer borrarlo. `adapters` → solo muere el alias (1 línea).
- **Se conservan**: `audit` y `relays` (son pestañas VIVAS de /observability), `fleet/:tenant/:alias` (único deep-link al TUI, lo usa el botón "Abrir TUI" de /messages), y `role-brief-tab` (**es la capa 1 del editor de directivas** — tu feature — y el único camino de rollback del rol).
- Ahorro real inmediato: ~572 LOC. Deudas para el mega-refactor anotadas (deep-link en /terminal desbloquea borrar 180 LOC más + todos los casos especiales del router; regenerar docs/grafo.md).

## 4. CAMINO A LA VENTANA (sin fecha aún — la pones tú)

1. Instancias cierran órdenes activas → revisión integradora + gate global verde.
2. **Ajuste de rutas pre-despliegue** (Claude): `deploy/runtime/` (~11 refs), re-validando render + builds.
3. **Re-ensayo de la tanda limpia** contra clon de prod (la 029 ya no existe: el ensayo anterior quedó obsoleto). Criterio: 10 migraciones en una transacción, flota intacta en 14/14 enabled, huella 024 verde.
4. **Alertmanager listo para la ventana** (tu D2): el bloque compose YA existe (`deploy/compose.alertmanager.yaml`, bien escrito) — falta engancharlo a `compose-files.sh` + `deploy.sh` y aprovisionar 7 variables, 5 de ellas derivables automáticamente del telegram-bridge ya desplegado con `ops/scripts/provision-alertmanager-config.py`. Necesito tus 3 datos de §6b.
5. **LA VENTANA** (~2-3h, contigo, `CAUCE_FASE3_CON_DUENO=si`): backup fresco → B1 (revocar las 3 sesiones fantasma: 2× kant, 1× vulcano) → prod.env (instance-id, rutas repo-como-fuente por D3, borrar líneas rancias) → build imágenes desde main → migrar la tanda de 10 → `up -d --wait` → smoke de efectos reales → **poda de historiales** (tablas y antigüedad decididas contigo en vivo, tras el backup) → GC del registry (§6e). Regla intacta: si algo falla dos veces, PARAR.

## 5. POST-PRIMER-DESPLIEGUE (el roadmap que dictaste)

1. **Cirugía de dominios** (ya planificada): `flota/`, consola a raíz, ops repartida — con checklists del grafo.
2. **CLI integral de cauce** (tus respuestas a-b-d): una sola app instalable donde haga falta, con auth para conectarse a TUIs/máquinas; absorbe el CLI de cuotas y reemplaza al quota-collector: autenticar modelos amigablemente (como kratos hoy), renovar credenciales vencidas entrando a la TUI, consumos en tiempo real. Centro de mando SIEMPRE esta VPS; multi-server posible (como kant).
3. **Zeus guardián** (tu D2/e): 3 opciones evaluadas con lo que ya existe — (1) timer que lee alertas de Prometheus y publica al bus con el patrón del revividor-de-colas (~100 líneas, YA hay pieza probada; portar su salvaguarda de idempotencia); (2) receptor webhook de alertmanager → bus (reacción instantánea, un servicio más que vigilar); (3) además registrar `mcp-fleet-monitor` en el harness de zeus para que investigue con tools. Recomendación: empezar por (1), evolucionar a (3).
4. **Aislamiento por tenant** (tu D1): cada tenant en su docker con carpetas aparte. Ojo: el checkout compartido de git hoy lo leen los 4 tenants — el aislamiento real exige credenciales por-tenant DENTRO del contenedor de cada uno (patrón `/opt/cauce-v3-secrets/<alias>` ya existente).
5. **Mega-refactor de consola**: con las deudas de §3 + los 74 asserts-sobre-texto + renombre de topology.

## 6. LO ÚNICO QUE QUEDA PENDIENTE DE TI (micro-preguntas, todo lo demás rueda solo)

**(a) Fecha/hora de la ventana** (~2-3h contigo).

**(b) Alertmanager, 3 datos**: (1) qué alias de telegram-bridge es el canal de alertas — candidatos ya desplegados: argos, jarvis, kant, socrates, zeus (recomiendo uno que NO sea zeus, para que zeus reciba por el bus, no por telegram); (2) escríbele a ese bot por Telegram <24h antes de aprovisionar (el derivador de chat_id lo necesita); (3) un digest pinneado de `prom/alertmanager` (mismo patrón que prometheus en prod.env).

**(c) Copias a "la torre"**: ¿kratos (100.64.0.1, ssh YA probado hoy, clave de ayer) ES tu torre? Nota: ya existe respaldo nocturno VPS→NAS funcionando + señal de que el NAS reenvía a Drive con restic. Si eso te cubre, no toco nada; si quieres VPS→kratos directo o VPS→Drive directo (requiere instalar rclone + credenciales), dímelo.

**(d) console-legibilidad**: 6 sondas CDP que miden contraste/tipografía/CSP de la consola real. ¿Se quedan para el mega-refactor o fuera?

**(e) Registry del stack de prod**: 20 tags basura confirmados borrables, pero el espacio solo se libera con `registry garbage-collect` DENTRO del contenedor del registry productivo — lo corro en la ventana contigo. (Y el tag `rc-20260722` tiene una contradicción interna en el informe de minimax: su prosa dice "no podar" y su tabla "podar" — con tu ok lo podo también.)

**(f) SEGURIDAD, la más urgente**: los contenedores de testcontainers publican Postgres 5432 en `0.0.0.0` con ufw INACTIVO — alcanzables desde internet por la IP pública. Propongo activar ufw (allow ssh/8444/443 y lo que confirmes) o forzar bind a loopback en el helper de tests. ¿Cuál prefieres?

## 7. ANOTADO (dictado del dueño 27-08 noche, NO ejecutar aún): desacoplar la flota del código
La identidad de los agentes está clavada en ≥7 sitios del código (container-aliases.json, ops/manifests/<alias>.yaml, units generadas, cred-guard, mocks del harness, enums del schema, telegram-runtime, PKI por alias) — por eso la ficción de Pablo hizo metástasis y retirar/añadir un agente cuesta tocar N capas. Objetivo: **la flota como DATOS, no como código** — alta/baja = 1 fila en BD + aprovisionar credenciales; todo lo demás DERIVADO de esa fuente única. Encaja con el aislamiento por tenant y el CLI integral. Va después del primer despliegue, con censo previo de acoplamiento (candidato: ronda MiniMax).
