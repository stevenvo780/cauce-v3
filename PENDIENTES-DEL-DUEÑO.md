# PENDIENTES DEL DUEÑO — entender el proyecto de verdad

Todas tus respuestas anteriores están preservadas en git (historial de este fichero) y ejecutadas o en ronda. Me dijiste que sigo perdido con la estructura REAL del proyecto — tienes razón: mis preguntas de reconciliación fueron el síntoma. Este doc son las dudas de fondo. Responde con matices en cada **Respuesta:**, y el **ANEXO final es tuyo** para explayarte con quiénes participan y los escenarios esenciales.

---

### [ ] (1) Las máquinas — mi mapa está confundido
Yo manejo: **esta VPS** ("server", donde corren los `cauce-v3-prod-*` y el bus) · **kratos** (remoto por tailscale, con tu CLI y varios contenedores de agentes) · **"la torre"** (¿es kratos, el 9950X3D? ¿u OTRA máquina distinta? — el vocabulario del repo a veces llama "torre" a la VPS y eso me cruza los cables) · **agora-storage** (aparece en el envoltorio y en hegel-ventas — ¿qué es y qué corre ahí?) · **el NAS** (backups) · **tu portátil**. Dame el inventario real: máquina → qué es físicamente → qué papel DEBE tener → qué agentes/contenedores corren ahí.

**Respuesta:**

### [ ] (2) Los humanos del proyecto
Steven (tú, dueño/operador), Miguel, Jhon, Isa — ¿quién es cada uno en la vida real del proyecto, qué hace su grupo de agentes POR él, y por qué canal usa el sistema (Telegram / consola / TUI / no lo usa aún)? ¿Pablo era una persona real que se retiró o fue siempre un experimento?

**Respuesta:**

### [ ] (3) La flota agente por agente — vi `grupos.json` en la raíz con los roles vacíos: ¿es tu borrador de esto?
Para cada uno de los 14: su MISIÓN en una línea (qué se supone que hace y para quién). Si prefieres, completa los `"rol"` de `grupos.json` y yo lo integro (y puede convertirse en semilla de los perfiles de la migración 026). Los que más me intrigan: argos, socrates, kant (¿"encargado de tu infraestructura" = qué hace en el día a día?), hegel (¿ventas de qué?), gaia/heraclito/tales (¿qué hacen para Jhon y Miguel?).

**Respuesta:**

### [ ] (4) Los escenarios esenciales — qué DEBE funcionar para que el primer despliegue sea un éxito
Dame los 3-5 flujos de un día normal, de punta a punta. Ejemplos de lo que imagino (corrígeme): "Miguel le escribe a atlas por Telegram y atlas trabaja en ws-humanizar y responde"; "tú editas la directiva de zeus desde /live y el cambio llega a su CLAUDE.md"; "zeus delega en socrates y ves la cadena". ¿Cuáles son los REALES y en qué orden importan?

**Respuesta:**

### [ ] (5) Comentarios: tu sensación de contaminación persiste — calibra mi puntería
Ya cayeron ~3.000 líneas y el trinquete solo baja, pero lo sigues sintiendo sucio. ¿El estándar que quieres es (a) "casi cero: solo invariantes que el código no puede expresar" (bajo los techos progresivamente hasta ahí), o (b) hay zonas concretas que TÚ lees y te ensucian (dime cuáles y las barremos primero)? ¿Los comentarios de tus propias herramientas rescatadas (médico: 709 líneas de comentario) entran en la purga o son tu diario de trabajo?

**Respuesta:**

### [ ] (6) Idioma: dijiste "homogenizar" — ¿hacia dónde?
(a) Identificadores exportados en INGLÉS, comentarios/docs en español (el estándar de facto de las zonas limpias hoy); (b) TODO español; (c) TODO inglés. El coste vive sobre todo en el hub de protocol (`ArnesDelAlias` etc., 9 consumidores) y un helper de tests con 62 consumidores.

**Respuesta:**

---

## ANEXO DEL DUEÑO — participantes y escenarios esenciales
(Este espacio es tuyo: explaya aquí quiénes son partícipes del proyecto y los escenarios esenciales que el sistema debe cumplir. Lo leo, actualizo mi memoria y los docs canónicos, y de aquí salen los perfiles reales de los agentes.)
