# OpenCode/MiniMax-2 — ORDEN ACTIVA (sesión nueva; 4 subagentes; TRADUCCIÓN MASIVA de comentarios a inglés)

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → esta orden. Eres la SEGUNDA instancia minimax: la primera está en la ronda de tests (NO toques `packages/adapter-sdk/test/**`). Regla de idioma del dueño (28-08): **.md en español; comentarios de CÓDIGO en inglés**. Tu fuerte: contexto gigante + mecánico masivo. 4 subagentes máximo, `umask 022`, commit+push por zona.

## La misión: SOLO LÍNEAS DE COMENTARIO — traducir a inglés conciso + podar contaminación
Zonas TUYAS (disjuntas de todos): **`packages/adapter-sdk/src`** · **`services/dispatcher/src`** · **`deploy/**`** · **`scripts/*.mjs`** · **`ops/pty-agent/*.py`** · **`tests/{unit,integration,e2e,gateway-hardening,store-hardening,terminal-pty,helpers}/**`**.
Reglas DURAS por fichero:
1. SOLO tocas líneas que son 100% comentario (o el bloque JSDoc). JAMÁS una línea de código, un string, un sql-string.
2. Traduce a inglés CONCISO. Si el comentario es narrativo/ceremonial/repite-la-firma → BÓRRALO en vez de traducirlo (dos pájaros). Invariantes y restricciones ("NO deducir del HOME…") se conservan traducidos con su fuerza.
3. Fechas y nombres propios en comentarios: FUERA siempre.
4. Gate global por commit; el conteo de comentarios solo puede BAJAR (el trinquete te vigila).
5. Verificación por zona: `git diff --stat` solo debe mostrar líneas de comentario cambiadas — un cambio de código = revertir el fichero entero y rehacerlo.

## PROHIBIDO: console/ y relay/bridge (gemini), packages/{protocol,store,mcp}/src y gateway (codex-2), ops/scripts+ops/tests (codex-1), ops/guardias/** (herramientas del dueño, decisión aparte), adapter-sdk/test (minimax-1), .md (quedan en español).
