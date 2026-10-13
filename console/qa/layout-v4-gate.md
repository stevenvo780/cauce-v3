# Puerta de diseño V4

`pnpm qa:layout` ejecuta la puerta existente y los estados V4. Chromium mide doce estados en 390×1000 y 1440×1000, con los temas claro y oscuro elegidos mediante la preferencia real `cauce.tema`. Los datos son sintéticos; la prueba no acredita CRUD, cuotas de proveedores ni autenticación en producción.

```sh
pnpm qa:layout:update --v4-only
pnpm qa:layout
node --test console/qa/layout-v4-measure.test.mjs
cd console && pnpm exec eslint qa/layout-gate.mjs qa/layout-dev-server.mjs qa/layout-v4-*.mjs
```

La actualización selectiva modifica exclusivamente `layout-v4-baseline.json` y `layout-v4-references/`. Conserva `layout-baseline.json` y no acepta aumentos automáticos del presupuesto de altura. Un estado con desborde, texto cortado, solape, error o datos incompletos no genera referencia. La prueba ordinaria sigue rechazando esos defectos aunque exista una referencia anterior.

## Estados y datos

| Identificador | Estado comprobado |
|---|---|
| `my-quotas` | Dos cuentas y entornos; Codex compartida por dos agentes. |
| `office-plan` | Plano visible, sala seleccionada, agentes en panel independiente y editor habilitado; captura adicional del editor. |
| `campus` | Canvas y modo Campus activo. |
| `computers` | Ordenador con ejecutor listo y otro cuya preparación está pendiente. |
| `companies` | Dos empresas bajo autoridad de plataforma. |
| `company-admins` | Dueño y administrador de empresa, con formulario de autoridad. |
| `people` | Tres personas, permisos y acciones de acceso web. |
| `agent-profile` | Perfil no vacío; captura adicional al fondo del formulario. |
| `agent-history` | Dos cambios y sus autores. |
| `context-versions` | Archivo de contexto, dos versiones y sus autores; captura adicional al fondo. |
| `company-retired` | Sesión sin autoridad y título exacto «Tu cuenta no tiene acceso vigente». |
| `registration` | Sesión sin autenticar y formulario abierto desde «Crear cuenta y empresa». |

`layout-v4-fixtures.mjs` reutiliza los handlers mediante `loadFixtures()` y añade los datos V4 fuera de los mocks de la aplicación. El navegador intercepta los GET; bloquea mutaciones y conexiones externas. Los service workers se desactivan y el servidor V4 arranca sin MSW para conservar una única fuente de respuestas.

## Mediciones y evidencia

Las mediciones rechazan desborde del documento, recorte por `hidden`/`clip`, solapes entre fragmentos de texto y controles, y scroll horizontal sin acceso por teclado. Registran los scrollers y el tema efectivo. Los textos auxiliares ocultos para lectores de pantalla no participan en la geometría pintada.

La ellipsis se acepta si tiene nombre completo explícito. El único título redundante adicional permitido es el de «Perfil y contexto» cuando su línea de identidad siguiente sigue completa y visible. Una barra sticky solo puede cubrir temporalmente contenido dentro de un scroller compartido si su opacidad efectiva es al menos 0,9; el contenido cubierto por una barra inferior al final del scroll sigue fallando. Las pruebas negativas cubren esas excepciones.

La evidencia incremental y el informe JSON quedan en `console/qa/.test-state/layout-v4/`. Un fallo de carga se reintenta una vez; el JSON conserva las causas del primer intento y su captura lleva el sufijo `-initial`. Las referencias PNG sirven para revisión humana; el gate compara geometría, no píxeles. `fullPage` no expande scrollers internos y conserva la posición de barras fijas. Las capturas `-detail` cubren editor, fondo del perfil y fondo de las versiones. La tabla de personas tiene scroll horizontal; su captura móvil inicial muestra solo la posición izquierda.

El estado legacy `/live#hoja` conserva su enlace `/live?agente=Steven/jarvis`: mide la tarjeta del campus, no la ficha completa que exige `ficha=1`. Un timeout de apertura se reintenta una sola vez con el mismo enlace y viewport; quedan el aviso y un PNG inicial en `.test-state/layout-legacy/`. Un segundo fallo deja el estado sin medir y el gate en rojo. Esta recuperación no demuestra la causa del timeout.

Cada servidor del gate reutiliza la configuración de Vite mediante `vite-layout.config.mjs`, con una caché única bajo `.test-state/vite-cache/`. El cierre elimina únicamente esa caché después de confirmar la terminación del proceso. Esto evita compartir dependencias optimizadas entre servidores QA; no demuestra la causa de errores anteriores de red o hooks.

## Revisión de referencias

Un crecimiento intencional autorizado se acepta por estado, con evidencia y revisión independiente:

1. Ejecutar el gate ordinario y conservar su JSON completo y sus capturas.
2. Identificar el commit que cambió la UI y comparar la captura con su referencia, en ambos temas y tamaños afectados.
3. Comprobar que las métricas principales y de detalle no tienen desborde, recorte, solape ni errores. Solo se admite el fallo de altura o la ausencia de una referencia nueva.
4. Cambiar exclusivamente las alturas de los estados revisados al valor medido y copiar exclusivamente sus PNG. Documentar alturas anteriores, nuevas y commit causal. `--update` por sí solo conserva el presupuesto anterior.
5. Ejecutar `pnpm qa:layout` completo, sin opciones de aceptación. Las tolerancias y las comprobaciones absolutas siguen vigentes.

Las acciones por estado de empresa de `b02419a0` envuelven «Retirar» a otra fila por empresa en móvil: Empresas pasa de 1191 a 1263 px y administradores de 1669 a 1741 px, tanto en claro como en oscuro. Este crecimiento intencional de 72 px tiene controles y etiquetas completos. La confirmación escrita y el aviso de empresa de origen pertenecen al mismo commit; las capturas de estas dos vistas no abren esa confirmación.

El plano conserva el fixture de sala 300×260 y parte `(16,180,220,60)`. Las tarjetas de agentes se muestran fuera del rectángulo geométrico, en la sala seleccionada, también para lectores; editar y guardar siguen sujetos a autoridad de escritura. El visor tiene una altura mínima y el gate comprueba que puede mostrar un selector de sala. Los PNG y JSON de `layout-v4-findings/` muestran los fallos previos; las referencias y el informe de cada pasada describen el resultado actual.
