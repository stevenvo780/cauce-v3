# PENDIENTES DEL DUEÑO — la única página que necesitas leer

Tus respuestas del 27-08 están TODAS procesadas y ejecutadas o planificadas — el mapa completo está en `plan-reestructura/plan-de-cierre.md` (léelo: 2 minutos). Resumen de lo ya hecho con tus decisiones: migraciones-ficción 029/036 borradas con toda su maquinaria (la flota queda 14/14 activos, Pablo fuera, nadie más se toca) · purga DLQ + herramientas de otras máquinas · carpeta de credenciales git-ignorada con regla dura · compose desde el repo (D3) · alertmanager y Zeus guardián planificados · poda de historiales lista para la ventana · vistas de consola razonadas (se retiran 2, se parten 2, se conservan 4 — el editor de directivas intacto).

Quedan SOLO estas micro-preguntas. Mismo formato: escribe tu decisión en **Respuesta:**.

---

### [ ] (a) La ventana de despliegue (~2-3h contigo)
¿Qué día y a qué hora?

**Respuesta: en cuanto se termite todo el refactor, llevamos 6 dias de atrazado en el despliegue asi que es prioridad**

### [ ] (b) Alertmanager — 3 datos
(1) ¿Qué alias de telegram-bridge es el canal de alertas? Candidatos ya desplegados: argos, jarvis, kant, socrates, zeus (recomiendo uno que NO sea zeus: que zeus reciba por el bus, no por telegram). (2) Escríbele a ese bot por Telegram <24h antes de la ventana (el aprovisionador deriva el chat_id de ahí). (3) ¿Me das un digest pinneado de `prom/alertmanager` o lo elijo yo del Docker Hub oficial?

**Respuesta: creo que entendiste mal, las alertas son un mecanismo de notificación para cualquier agente que yoquiera que levante un mensaje en sun canal de forma recurrente como un croj**

### [ ] (c) Copias a "la torre"
¿kratos (100.64.0.1, ssh probado hoy) ES tu torre? Ya existe respaldo nocturno VPS→NAS funcionando (con restore probado) y señal de que el NAS reenvía a Drive. ¿Te basta esa ruta, o quieres además VPS→kratos directo / VPS→Drive directo (esto último requiere instalar rclone aquí + credenciales)?

**Respuesta: la torre es un 9950x3d o el nass tambien preferiblemetne la torre y el drive**

### [ ] (d) console-legibilidad (6 ficheros)
NO era basura: son sondas reales contra Chrome que miden contraste/tipografía/CSP de la consola — útiles justo para el mega-refactor que pediste. ¿Se quedan o fuera?

**Respuesta: creo que tener codigo para eso encucia el codigo, deberian ser agentes con uso de chrome no codigo quemado es menos fiable que un agente que siempre revise**

### [ ] (e) Registry de producción — garbage collect
20 tags basura confirmados; el espacio solo se libera con GC dentro del registry del stack vivo → lo corro en la ventana contigo. Y el tag `rc-20260722` tiene informes contradictorios: ¿lo podo también?

**Respuesta: si poda, entre menos basura mejor**

### [ ] (f) SEGURIDAD — la más urgente
Los contenedores de testcontainers publican Postgres 5432 en `0.0.0.0` con ufw INACTIVO: alcanzables desde internet. ¿Activo ufw (allow ssh/8444/443 + lo que digas) o fuerzo bind a loopback en el helper de tests? (Puedo hacer las dos.)

**Respuesta: hay bases de datos que necesito publicas dejalas asi ña seguriodad no es la prioridad ya lo habia establecido antes**

### [ ] (g) TU CLI REAL vive solo en tu home — rescatarlo al repo
Hallazgo de hoy (evidencia: `ordenes/reportes/claude-duplex-cli.md`): `/home/stev/.local/bin/cauce` tiene 1.138 líneas y 21 funciones que NO están en git — incluido `cauce <alias> login` completo, el embrión literal del CLI integral que pediste. Está byte-idéntico en torre y kratos (lo sincronizas a mano), sobre un RAID 0 sin redundancia. Escaneado: LIMPIO de secretos. ¿Lo subo al repo como nueva fuente de `ops/cli/cauce` (y desde ahí tu home se escribe SOLO con el instalador)?

**Respuesta: como dij el CLI hay que evolucionarlo para instalarlo facil en cualquier ordenador que deje de depdner de mi torre, no impiar secretos dejar una carpta con todos secretos ignroada de git pero no se borran ya dije eso siempre provoca que los agentes pierdan autonomia al isntante**

### [ ] (h) ops/guardias/cauce-kratos.sh — la copia de rescate
No era un duplicado divergido: es el manifiesto de restauración del RAID. Si apruebas (g), la copia queda obsoleta dos veces (el rescate real sería el binario nuevo). ¿La actualizo al binario real junto con (g), o la retiro y el README de guardias apunta a `ops/cli/cauce` como única fuente de restauración?

**Respuesta: si actualiza a los vinarios reales porfavor veo que sigues hablandod e ops y eso ya ahbias dicho que son duplicados hay que evitarlos **

### [ ] (i) El zoológico de kratos
Por ssh verificado: ~30 variantes `cauce-*` + ~25 .bak en tu `~/.local/bin` de kratos, y **6 guardianes systemd activos sin fichero en el repo** (attach-guard, panel-guard, ai-live, quien-consume, cred-guard-kratos, medico-monitor) + un `cred-guard.py` divergido. Es el patrón "versiones paralelas" vivo HOY en producción. ¿Autorizo una ronda de rescate+censo sobre kratos (leer, versionar lo vivo, retirar lo muerto — sin tocar nada que corra hasta tener el mapa)?

**Respuesta: autorizado, menos duplicados y eso levanta a alerta de se antipatron de cosas duplicadas**

anexo: COmo adjunto entonces veo que mucyhos antipatrones se siguen repitiendo por todo el sistema, hay que tirar un workflow gigante para revisar que no se repitan funcionaldaides inecxistentes o inconexas, codigo ma lescrito, codigo que se repite en varias partes, archivos demaciado grandes, falta de linerts, duplcaidos de dist o duplicados  de estos, mal ordenamiento de los archivos, sobre comentarios que ensucian los contextos de las IA, entre otros elementos y anti patrones que ya habia mencioando y que ya habiamos tratados estas preguntan levnata mi alarma de, realmente no se a terminado de ahcer un buen trabajo en la refactrorizacion, ordenamiento documentacion, para desaaparecer los anti patrones y que se pueda tener un sistema mas limpio, ordenado, documentado y funcional, por lo que se requiere una nueva ronda de refactorizacion y limpieza de todo el sistema para poder tener un sistema mas funcional y limpio.


### [ ] (j) Libro de reconciliación BD↔físico — 4 respuestas y la ronda flota-como-datos arranca
El diseño está en `plan-reestructura/flota-como-datos.md` (Anexo A con la evidencia). La regla de la ronda: el drift se corrige SIEMPRE en la BD, jamás parcheando ficheros. Necesito: (1) argos: ¿claude o hermes?; (2) iza: ¿openclaw@claw-miguel o hermes@ws-humanizar?; (3) kant: confirmar la rama host (BD parece la buena); (4) gaia/heraclito/tales: ¿en qué host corren físicamente, o se deshabilitan en BD hasta tener placement?

**Respuesta:**
