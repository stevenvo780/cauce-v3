# 15 — Documentación real (para humanos y para las IA operadoras)

**Fase:** 1 · **Tamaño:** mediano · **Ejecutor:** Claude · **Revisor:** el dueño (lectura humana)
**Rama:** `reestructura/15-docs` · **Depende de:** 11 y 12 mergeados (documenta el árbol ya ordenado)

## Objetivo
Hoy la "documentación" son 715 líneas de admiración arquitectónica + 88 informes sueltos fuera del repo + comentarios que mienten. Este repo lo operan esencialmente IAs: **el repo es su contexto**. La documentación debe ser corta, exacta y verificada, porque cada palabra falsa envenena a cada agente que la lee.

## Tareas

1. **README raíz nuevo** (≤120 líneas): qué es Cauce (bus de mensajes entre agentes CLI de 4 tenants + consola + Telegram), qué servicios corren de verdad, cómo se desarrolla (gates), cómo se despliega (apuntar a 31 cuando exista). Borrar las menciones a componentes en cuarentena.
2. **Un README de ≤40 líneas por servicio/paquete vivo** (gateway, dispatcher, terminal-relay, telegram-bridge, protocol, store, adapter-sdk, console, pty-agent): qué hace, qué NO hace (p.ej. "el dispatcher NO reparte mensajes: es el segador de retries"), puertos/env, cómo probarlo. Cada afirmación verificada contra el código en el momento de escribirla.
3. **Archivos de contexto del repo para las IA constructoras** — la pieza más importante:
   - `CLAUDE.md`, `AGENTS.md` (codex) y equivalente OpenClaw en la raíz del repo, ≤60 líneas cada uno, con: mapa del árbol en 10 líneas, las 8 reglas globales de 00-LEEME, la lista NO-TOCAR, y el gate copiable.
   - Prohibición explícita dentro de esos ficheros: no comentarios narrativos, no planes >100 líneas, no declarar hecho sin efecto mostrado, no trabajar fuera de rama.
4. **Depurar `docs/`**: tras el barrido de 11, lo que quede en `docs/` debe ser: ADRs (conservar), threat-model (conservar, marcar qué partes aplican de verdad), y `docs/bitacora/` (histórico congelado, con README de una línea: "material histórico, no confiable como estado actual").
5. **Runbooks de `ops/runbooks/`**: conservar solo los operativos vigentes (deploy se reescribe en 31); el resto a `docs/bitacora/`.

## Regla de estilo
Prosa mínima, presente, verificable. Ni una fecha de incidente, ni una cita de nadie, ni "recientemente", ni "por ahora". Si algo puede quedar obsoleto rápido, no se escribe.

## Gate de aceptación
- El dueño puede leer el README raíz + 2 de servicio en <10 min y describir el sistema correctamente.
- Un agente nuevo (sesión limpia de cualquier modelo) recibe el repo y responde correctamente: "¿qué corre en producción?", "¿cómo pruebo un cambio?", "¿qué no debo tocar?" — prueba real a ejecutar antes de mergear.
