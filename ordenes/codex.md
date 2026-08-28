# Codex-1 — ORDEN ACTIVA (ronda nocturna, la DIFÍCIL): contextos NATIVOS por harness — matar la inyección por mensaje

ARRANQUE: `git pull` → `ordenes/00-PROTOCOLO.md` → `docs/flota-y-participantes.md` (§visión) → esta orden. Tu ronda 2 fue ejemplar (4 tareas, 4 commits, Fase A automatizada). Esta noche nadie revisa en vivo: cada fase cierra con evidencia PEGADA en el commit y push. Zona EXCLUSIVA: `packages/adapter-sdk/src/**` (minimax-2 NO toca src esta noche: tiene tests y guardias), `packages/protocol/src/**`, `packages/store/src/**`, `services/gateway/src/**` (codex-2 está en molienda de lint ahí — coordinación: tú tocas SOLO los ficheros del subsistema de perfiles/contexto que identifiques en la Fase 1; anótalos en tu primer commit para que codex-2 los evite).

## EL PROBLEMA (palabras del dueño, 28-08)
"Poder establecer los roles modificando los contextos según cada harness — el CLAUDE.md, el Codex.md o el Soul.md de OpenClaw — y que cada harness maneje sus contextos. Ahora mismo el sistema INYECTA los contextos en cada mensaje y eso consume contexto sin aprovechar cómo funciona cada harness realmente." Es el punto 3 de su visión y uno de sus dolores centrales.

## Fase 1 — Diagnóstico medido (commit: `ordenes/reportes/codex-contextos-nativos.md` §1)
Mapea con evidencia ruta:línea el flujo COMPLETO de hoy: dónde nace el perfil (agent_profiles en BD, 026/028/035), cómo llega al adapter (`packages/adapter-sdk/src/context/{perfil-a-contexto,siembra-del-perfil}.ts`, `harnesses/contexto-fijo.ts`, prompt.ts), y EXACTAMENTE qué se inyecta en cada turno/mensaje (bytes/tokens estimados por harness — mide con un delivery real de la BD de prod, SOLO SELECT). Confirma o refuta la afirmación del dueño con números: ¿cuántos tokens de contexto repetido gasta cada entrega por harness?

## Fase 2 — Cómo consume contexto cada harness DE VERDAD (§2 del reporte)
Investiga en el código/binarios instalados y docs de cada CLI: Claude Code (`CLAUDE.md` jerárquico + memoria), Codex CLI (`AGENTS.md`/instrucciones de proyecto), OpenClaw (`Soul.md`/workspace), Hermes (lo que aplique). Para cada uno: fichero(s) nativos que lee, cuándo los relee (arranque / cada turno / nunca sin reinicio), límites, y qué YA hace el runtime de cauce con ellos (busca `siembra-del-perfil` y `CAUCE_SEMBRAR_PERFIL=1` en las units: algo de siembra existe — ¿qué cubre y qué no?). Los agentes reales corren en los contenedores `agv2-*-oc`, `ws-*`, `claw*` — puedes inspeccionar SOLO LECTURA sus homes vía `docker exec <c> cat` para ver los ficheros nativos reales de hoy.

## Fase 3 — Diseño (§3): "perfil → fichero nativo, una vez; turno → solo el mensaje"
Propón el modelo objetivo: el perfil autorado (agent_profiles) se PROYECTA al fichero nativo del harness al publicar (revision/applied_revision de 028/035 ya son el fencing perfecto para esto), el harness lo carga por su mecanismo propio, y la entrega deja de inyectar contexto (o inyecta solo un puntero mínimo). Cubre: reinicio-o-no del harness al cambiar el perfil, qué pasa con harnesses que solo leen al arrancar, compatibilidad con la UI /live (edición de directivas → PUT perfil → proyección), y la medición de ahorro esperada. Riesgos y qué NO hacer.

## Fase 4 — Implementación mínima verificable (commits por pieza)
Implementa la proyección para AL MENOS dos harnesses (claude y openclaw — los que más pesan en la flota real) detrás de un flag por alias (fail-closed: comportamiento actual por defecto), con tests que demuestren: (a) el fichero nativo se escribe con el contenido del perfil y la revision; (b) una entrega con el flag activo NO lleva el bloque de contexto inyectado; (c) cambiar el perfil re-proyecta y avanza applied_revision. NO cambies el comportamiento por defecto de producción; NO toques migraciones (fila NADIE). Gate global verde por commit.

## Cierre: el reporte con las 4 fases, cifras de ahorro medidas, y la lista exacta de qué activar en la ventana. Push.
