# Puerta de diseño V4

`pnpm qa:layout` ejecuta la puerta existente y los estados V4. Chromium mide doce estados en 390×1000 y 1440×1000, con los temas claro y oscuro elegidos mediante la preferencia real `cauce.tema`. Los datos son sintéticos; la prueba no acredita CRUD, cuotas de proveedores ni autenticación en producción.

```sh
pnpm qa:layout:update --v4-only
pnpm qa:layout
node --test console/qa/layout-v4-measure.test.mjs
cd console && pnpm exec eslint qa/layout-gate.mjs qa/layout-dev-server.mjs qa/layout-v4-*.mjs
```

La actualización selectiva modifica exclusivamente `layout-v4-baseline.json` y `layout-v4-references/`. Conserva `layout-baseline.json` y no acepta aumentos del presupuesto de altura. Un estado con desborde, texto cortado, solape, error o datos incompletos no genera referencia. La prueba ordinaria sigue rechazando esos defectos aunque exista una referencia anterior.

## Estados y datos

| Identificador | Estado comprobado |
|---|---|
| `my-quotas` | Dos cuentas y entornos; Codex compartida por dos agentes. |
| `office-plan` | Plano, sala seleccionada y editor habilitado; captura adicional del editor. |
| `campus` | Canvas y modo Campus activo. |
| `computers` | Ordenador con ejecutor listo y otro cuya preparación está pendiente. |
| `companies` | Dos empresas bajo autoridad de plataforma. |
| `company-admins` | Dueño y administrador de empresa, con formulario de autoridad. |
| `people` | Tres personas, permisos y acciones de acceso web. |
| `agent-profile` | Perfil no vacío; captura adicional al fondo del formulario. |
| `agent-history` | Dos cambios y sus autores. |
| `context-versions` | Archivo de contexto, dos versiones y sus autores; captura adicional al fondo. |
| `company-retired` | Sesión sin autoridad y pantalla de empresa retirada. |
| `registration` | Sesión sin autenticar y formulario abierto desde «Crear cuenta y empresa». |

`layout-v4-fixtures.mjs` reutiliza los handlers mediante `loadFixtures()` y añade los datos V4 fuera de los mocks de la aplicación. El navegador intercepta los GET; bloquea mutaciones y conexiones externas. Los service workers se desactivan y el servidor V4 arranca sin MSW para conservar una única fuente de respuestas.

## Mediciones y evidencia

Las mediciones rechazan desborde del documento, recorte por `hidden`/`clip`, solapes entre fragmentos de texto y controles, y scroll horizontal sin acceso por teclado. Registran los scrollers y el tema efectivo. Los textos auxiliares ocultos para lectores de pantalla no participan en la geometría pintada.

La ellipsis se acepta si tiene nombre completo explícito. El único título redundante adicional permitido es el de «Perfil y contexto» cuando su línea de identidad siguiente sigue completa y visible. Una barra sticky solo puede cubrir temporalmente contenido dentro de un scroller compartido si su opacidad efectiva es al menos 0,9; el contenido cubierto por una barra inferior al final del scroll sigue fallando. Las pruebas negativas cubren esas excepciones.

La evidencia incremental y el informe JSON quedan en `console/qa/.test-state/layout-v4/`. Un fallo de carga se reintenta una vez; el JSON conserva las causas del primer intento y su captura lleva el sufijo `-initial`. Las referencias PNG sirven para revisión humana; el gate compara geometría, no píxeles. `fullPage` no expande scrollers internos y conserva la posición de barras fijas. Las capturas `-detail` cubren editor, fondo del perfil y fondo de las versiones. La tabla de personas tiene scroll horizontal; su captura móvil inicial muestra solo la posición izquierda.

Cada servidor del gate reutiliza la configuración de Vite mediante `vite-layout.config.mjs`, con una caché única bajo `.test-state/vite-cache/`. El cierre elimina únicamente esa caché después de confirmar la terminación del proceso. Esto evita compartir dependencias optimizadas entre servidores QA; no demuestra la causa de errores anteriores de red o hooks.

## Hallazgo conservado

En el plano de 1440 px, claro y oscuro, la tarjeta de `argos` tapa el inicio de «Mesa de coordinación» en `grp.steven`. Parte y tarjeta comparten el mapa, de modo que desplazar el visor no recupera la etiqueta. El fixture es válido y se conserva: no se crea referencia para esos dos estados. Las capturas del defecto y su medición quedan en `layout-v4-findings/`; corregirlo requiere trabajo en el componente de oficina, fuera del alcance del arnés.
