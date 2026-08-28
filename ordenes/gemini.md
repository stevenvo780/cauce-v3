# Gemini — ORDEN ACTIVA: RONDA FLOTA-COMO-DATOS, carril G (+ el runbook que enseña la nueva era)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → **`plan-reestructura/flota-como-datos.md`** (§5 credenciales, §6 gates, §7 tu carril) → `docs/flota-y-participantes.md`. Tu mega-ronda quedó verificada COMPLETA (typechecked, 31 promesas, citas, relay corriendo — excelente). Reglas de siempre + `umask 022`, commit+push POR TAREA.

## G2 (primero — no depende de nadie) — `ops/pty-agent/publish-alias-key.sh`
Envuelve el `derive-alias-key.py` existente y publica su stdout como `alias-key.hex` 0400 atómico (patrón de publicación de provision-terminal-client). Con test en la suite PTY. Es la pieza 3 del `cauce aprovisionar`.

## G3 — El runbook de la nueva era + purga de los pasos viejos
`ops/runbooks/alta-y-baja-de-agente.md` (en ESPAÑOL — regla nueva de idioma): el flujo completo del diseño — INSERT en BD → export → regenerate → validate → aprovisionar → efecto verificado; y la baja inversa. PURGA de `authentication.md` y `container-adapters.md` todo paso que diga editar `container-aliases.json`/manifests A MANO (van a ser generados: documentarlo como prohibido). Criterio del diseño: el runbook debe poder ejecutarlo alguien que no lo escribió.

## G1 (ÚLTIMO — espera la señal K2 del integrador en tu orden o en main: "snapshot real conmutado")
Cuando `ops/container-aliases.json` cambie de bytes (flota de 14 + historicals desde BD): re-publica y re-firma el release PTY (mappingSha256 nuevo) UNA sola vez, y ajusta/ejercita los tests de `Fleet.load` con `historicalAliases` NO vacío y la flota real (recuerda: argos=openclaw, iza=openclaw@claw-miguel, gaia/heraclito/tales presentes — `grupos.json` tiene sus roles). `test_rollout_pty.py` verde con el mapping nuevo.

## Mientras esperas G1: los "assert-sobre-texto" de consola del top-20 de dientes que quedaran pendientes, y comentarios de CÓDIGO NUEVO en inglés (regla de idioma del dueño 28-08).
