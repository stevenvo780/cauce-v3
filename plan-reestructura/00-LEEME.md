# Plan de reestructura de Cauce V3

Fecha: 2026-08-27. Basado en la auditoría multi-agente de esta fecha (58 agentes, verificación adversarial).
Informe completo: https://claude.ai/code/artifact/fe3022ea-7c0b-4a47-8093-9389f7726d08

## Veredicto en 5 líneas

1. El bus de mensajería IA↔IA **funciona** (15.605 mensajes reales, fencing correcto). No se reescribe.
2. Las 2 features pedidas (editor de CLAUDE.md/AGENTS.md/SOUL.md; stream TUI) están **escritas y completas en HEAD, pero nunca desplegadas**. El bloqueo es el despliegue, no el código.
3. El despliegue es **imposible por diseño**: el gate exige evidencia que está en .gitignore, la borra `pnpm clean` y caduca con cualquier commit. 17 intentos la noche del 26-ago, 0 éxitos.
4. El 40% de las líneas commiteadas nunca llegó a main (203 commits, +119K líneas, 75 worktrees vivos). La misma feature se escribió hasta 4 veces en paralelo.
5. Sobre-ingeniería confirmada: solo 20–30% de services+packages sirve al camino crítico. Hay subsistemas enteros con 0 filas / 0 llamadores / 0 despliegues.

## Secuencia (decisión del dueño)

- **FASE 1 — Orden y legibilidad** (sin desplegar nada): ficheros 11–15. Sectores disjuntos, paralelizables.
- **FASE 2 — Correcciones sobre lo mapeado**: fichero 21. Requiere FASE 1 terminada en su sector.
- **FASE 3 — Despliegue y pruebas reales**: ficheros 31–33. Aquí es donde se quemaron los tokens antes; no se entra hasta tener base ordenada.

## Reglas globales (aplican a TODA tarea, cualquier modelo)

1. **Todo directo a `main`, sin ramas** (decisión del dueño 27-08: las ramas fueron el cementerio del proyecto). Sectores disjuntos + `git add` solo por rutas propias sustituyen a las ramas. Ver `ordenes/00-PROTOCOLO.md`.
2. **Gate mínimo por commit**: `pnpm typecheck && pnpm lint` en verde (hoy pasan; deben seguir pasando). Tras el fichero 21, también `pnpm test:unit`.
3. **Mover ≠ editar.** Los `git mv` van en commits separados de cualquier cambio de contenido. Un commit mezcla las dos cosas = rechazado.
4. **Commits pequeños.** Nada de monolitos de 400 ficheros. Máximo ~20 ficheros por commit salvo mv masivos mecánicos.
5. **El que revisa nunca es el que escribió.** Revisor cruzado de otro modelo antes de mergear a main.
6. **Prohibido declarar "hecho" sin mostrar el efecto.** Para código: el gate en verde pegado en el mensaje/PR. Para despliegues (FASE 3): el `curl`/captura del efecto real.
7. **Nada de comentarios narrativos nuevos.** Comentario solo para una restricción que el código no puede expresar. Sin historia, sin fechas, sin "incidentes".
8. **Ningún plan nuevo >100 líneas.** Si una tarea necesita más plan, está mal partida.

## Lista NO-TOCAR (para todos, en todas las fases)

- `packages/store/migrations/**` (SQL aplicado o pendiente; se gestiona solo en FASE 3, fichero 31)
- `ops/rollback-bridge/rollback-bridge-schema029.patch` y cualquier `*.patch` (editarlos los corrompe)
- `deploy/**` y `/etc/cauce-v3/**` y `/opt/cauce-v3*/**` (producción; solo FASE 3)
- `ops/guardias/**` hasta el fichero 32 (espejos de scripts desplegados en /usr/local/sbin)
- La base de datos productiva: ni una escritura fuera de FASE 3.
- Contenedores y unidades systemd: no reiniciar/parar nada fuera de lo listado en URGENTE.

## Reparto sugerido por naturaleza de tarea

| Tarea | Ejecutor sugerido | Revisor cruzado |
|---|---|---|
| 11 Higiene raíz y worktrees | Gemini o MiniMax (mecánico masivo) | Codex |
| 12 Cuarentena de legado | Claude (Sonnet) | GPT 5.6 Ultra |
| 13 Carpintería backend | GPT 5.6 Ultra o Claude (Opus) | Codex |
| 14 Carpintería consola | Codex | Gemini |
| 15 Documentación real | Claude | dueño (lectura humana) |
| 21 Correcciones mapeadas | Codex / Claude Sonnet | GPT 5.6 Ultra |
| 31 Despliegue simple | Claude (Opus) + dueño presente | GPT 5.6 Ultra |
| 32 Flota PTY y guardias | Claude + dueño presente | Codex |
| 33 Gobierno de flota | dueño + Claude | — |

## URGENTE (independiente del plan; decisión del dueño, no de los agentes)

1. **Bucle PTY**: hay 24 procesos `cauce-pty-agent-*.py` vivos dentro de los contenedores para 10 clientes. Los huérfanos se expulsan mutuamente cada 1–2 s (~46.000 conexiones/93 min, 92% del tráfico del gateway). Matar los huérfanos (los que no tienen cliente `docker exec` asociado) probablemente resucita la TUI sin tocar código. Detalle en fichero 32.
2. **Limpieza de Gemini sin commitear**: ~300 ficheros modificados sobre main sin rama. Crear rama `limpieza/comentarios-20260827`, commitear, pasar el gate. Si se pierde, se repite el gasto.
3. **Credencial muerta**: `cauce-cred-guard` está en `failed` detectando la credencial Claude de socrates (ws-prizma) muerta. Nadie recibe el aviso.
4. **zeus caído**: el adaptador de zeus no corre desde el 25-ago (1 entrega `pending` esperando).
