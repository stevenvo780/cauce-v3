# PENDIENTES DEL DUEÑO — la única página que necesitas leer

Tus respuestas del 27-08 están TODAS procesadas y ejecutadas o planificadas — el mapa completo está en `plan-reestructura/plan-de-cierre.md` (léelo: 2 minutos). Resumen de lo ya hecho con tus decisiones: migraciones-ficción 029/036 borradas con toda su maquinaria (la flota queda 14/14 activos, Pablo fuera, nadie más se toca) · purga DLQ + herramientas de otras máquinas · carpeta de credenciales git-ignorada con regla dura · compose desde el repo (D3) · alertmanager y Zeus guardián planificados · poda de historiales lista para la ventana · vistas de consola razonadas (se retiran 2, se parten 2, se conservan 4 — el editor de directivas intacto).

Quedan SOLO estas micro-preguntas. Mismo formato: escribe tu decisión en **Respuesta:**.

---

### [ ] (a) La ventana de despliegue (~2-3h contigo)
¿Qué día y a qué hora?

**Respuesta:**

### [ ] (b) Alertmanager — 3 datos
(1) ¿Qué alias de telegram-bridge es el canal de alertas? Candidatos ya desplegados: argos, jarvis, kant, socrates, zeus (recomiendo uno que NO sea zeus: que zeus reciba por el bus, no por telegram). (2) Escríbele a ese bot por Telegram <24h antes de la ventana (el aprovisionador deriva el chat_id de ahí). (3) ¿Me das un digest pinneado de `prom/alertmanager` o lo elijo yo del Docker Hub oficial?

**Respuesta:**

### [ ] (c) Copias a "la torre"
¿kratos (100.64.0.1, ssh probado hoy) ES tu torre? Ya existe respaldo nocturno VPS→NAS funcionando (con restore probado) y señal de que el NAS reenvía a Drive. ¿Te basta esa ruta, o quieres además VPS→kratos directo / VPS→Drive directo (esto último requiere instalar rclone aquí + credenciales)?

**Respuesta:**

### [ ] (d) console-legibilidad (6 ficheros)
NO era basura: son sondas reales contra Chrome que miden contraste/tipografía/CSP de la consola — útiles justo para el mega-refactor que pediste. ¿Se quedan o fuera?

**Respuesta:**

### [ ] (e) Registry de producción — garbage collect
20 tags basura confirmados; el espacio solo se libera con GC dentro del registry del stack vivo → lo corro en la ventana contigo. Y el tag `rc-20260722` tiene informes contradictorios: ¿lo podo también?

**Respuesta:**

### [ ] (f) SEGURIDAD — la más urgente
Los contenedores de testcontainers publican Postgres 5432 en `0.0.0.0` con ufw INACTIVO: alcanzables desde internet. ¿Activo ufw (allow ssh/8444/443 + lo que digas) o fuerzo bind a loopback en el helper de tests? (Puedo hacer las dos.)

**Respuesta:**
