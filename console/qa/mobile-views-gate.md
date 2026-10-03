# Gate de primera pantalla móvil

## Alcance y procedencia

Base verificada: árbol `7325a83db546ca53453548975f885eebf3eab5c1`, copia aislada de `cauce-reviewed-stack/source-r2`. Los 2230 archivos del manifiesto conservan su SHA256. Sólo se añaden estos cinco archivos `mobile-views-*`; no se cambian baseline, gate histórico, scripts ni producto.

La auditoría `cauce-mobile-view-audit-20261003/AUDITORIA.md` detectó que el trinquete histórico permite contenido principal bajo el pliegue. Este gate exige presupuesto absoluto y falla cuando un estado no se puede medir. No dispone de modo para regrabar baseline ni excepciones por ruta.

## Contrato

- 26 estados, 360×800, 390×844, 430×932 y 760×1000; claro y oscuro con movimiento reducido: 208 mediciones previstas
- Cero desborde horizontal de documento
- Objeto principal pintado, comienzo dentro del primer 50% del área útil y al menos 120px visibles, o toda su altura si es menor; se descuentan navegación inferior y clipping de ancestros
- Grafo con nodos abierto al entrar y después de recargar, sin expandirlo desde la prueba
- Desplazamiento horizontal interno permitido si su contenedor o sus controles son alcanzables mediante teclado
- Cualquier excepción, error de página, fixture ausente, mutación intentada, WebSocket o estado no medido impide aprobar

Estados: entrada, lista de conversaciones, hilo, contexto del hilo, resumen, flota, las cinco pestañas del cajón, las tres de cuentas, entregas, señales, auditoría, configuración de agentes, las seis pestañas administrativas, terminal y ayuda. Los selectores de cuentas son específicos del panel activo para evitar medir el panel Consumo oculto. Tras hacer clic se restablece el scroll antes de medir: el desplazamiento automático de Playwright no convierte contenido bajo el pliegue en un pase.

## Reutilización

`mobile-views-fixtures.mjs` compila con el esbuild ya disponible los handlers de `src/mocks/handlers.ts` y el fixture de conversación existente. `msw.getResponse` resuelve las lecturas sin servidor de API. Sólo se añade una colección de configuración sintética para hacer accesible «Otros», oculto cuando no hay colecciones desconocidas. No se copian el esquema de cuentas ni las respuestas de contexto.

Los tests puros comprueban reglas, nombres/selectores por fuente y respuestas de fixtures. No montan la UI ni producen evidencia visual. Una futura corrida de Chromium medirá CSS y DOM reales con datos sintéticos: tampoco acredita backend, permisos reales, credenciales, PTY, publicación ni despliegue.

## Ejecución por revisor independiente

Desde la raíz de la copia:

```sh
node --test console/qa/mobile-views-contract.test.mjs
for f in console/qa/mobile-views-*.mjs; do node --check "$f"; done
(cd console && node node_modules/eslint/bin/eslint.js qa/mobile-views-*.mjs)
```

Sólo en un entorno donde navegador y servidor estén autorizados, con la consola ya servida desde el árbol exacto a revisar y `VITE_USE_MOCKS=false`:

```sh
CAUCE_QA_ORIGIN=http://127.0.0.1:4174 \
CAUCE_MOBILE_VIEWS_BROWSER=1 \
CAUCE_MOBILE_QA_OUTPUT=artifacts/mobile-views \
node console/qa/mobile-views-gate.mjs
```

La variable habilita una operación ya autorizada; no concede permisos ni habilita eludir una denegación. El gate no inicia servidor, no instala dependencias, no se conecta a una sesión humana y no envía mutaciones. Intercepta `/v3/` con fixtures GET; bloquea otros orígenes y sockets. Usar una instancia de prueba aislada, nunca producción.

El revisor debe conservar árbol/versión del servidor, stdout/stderr, código de salida, `report.json` y PNG reales. Un informe incompleto o `passed:false` no es aprobación. No rebajar presupuestos para pasar: coordinar el arreglo del producto. R2 tiene al menos el grafo cerrado, por lo que se espera fallo hasta integrar su corrección.

## Verificación realizada y límites

Pasado: doce tests de contrato, `node --check` de los cuatro módulos, ESLint enfocado desde `console` y comprobación SHA256 de 2230 archivos base. La primera invocación de ESLint desde la raíz no aplicó el bloque de globals de `qa/**`; se repitió desde el directorio correcto y pasó sin cambios en configuración.

No ejecutado: Playwright, servidor, sockets, mediciones DOM, capturas, gate histórico, mobile-chat-gate, build, typecheck o suites globales. No hay capturas nuevas ni aprobación visual.

Fuera de esta cobertura mínima: 404/agente ausente, carga/error/vacío por vista, formularios/confirmaciones, DLQ operativo, búsqueda compacta interactiva, abrir nodo y verificar agente, Escape/foco/Back/Forward, teclado físico y safe-area real, objetivos táctiles y zoom. El gate de chat existente sigue siendo necesario para el contrato de hilo ≥60%. La cobertura ampliada de interacción necesita una ronda posterior, sin confundirla con estas 208 mediciones de navegación y geometría.

## Endurecimiento tras revisión independiente

La primera entrega quedó preservada por el revisor en `review-cauce-mobile-qa-20261003/console/qa`. Esta revisión conserva las mismas cinco rutas y 26 estados.

- El contexto del hilo y las cinco pestañas live esperan contenido específico poblado: datos de Ahora, capacidades de Conexión, tarjeta de entrega, perfil/documentos del Contexto y elementos del inventario de Ficheros. El wrapper del cajón o del contexto no basta
- Respuestas de navegación y fixtures requieren estado HTTP 2xx; errores HTTP y `requestfailed` quedan registrados. No se acepta una pantalla de error como respuesta normal de fixture
- Cada estado intenta guardar PNG también al fallar, sin borrar el fallo original. Si la captura falla, se registra ese segundo fallo y no se publica una ruta de captura nueva
- `clientWidth`, dimensiones de `visualViewport` y su escala deben coincidir con el viewport solicitado, para rechazar una página móvil renderizada con viewport de escritorio
- Los nodos del grafo cuentan sólo pintados y dentro de la intersección visible del grafo y viewport; controles ocultos, inertes, deshabilitados o excluidos del tabulado no acreditan acceso por teclado
- `report.json` se inicializa con `passed:false` antes de configurar o lanzar Chromium. Errores de setup, lanzamiento y cierre se conservan y el cierre no impide intentar escribir el informe final. Un error de escritura del propio informe sigue siendo un error del proceso

Los seis tests adicionales cubren estados HTTP negativos/ausentes, meta-viewport regresado, selección de contenido de live y disponibilidad real de los datos sintéticos necesarios. Siguen siendo contratos puros, sin navegador ni validación visual.

La comprobación de teclado se limita al diálogo modal activo cuando existe: el fondo que el modal inertiza no es una superficie interactiva. Dentro del diálogo siguen rechazándose contenedores y controles inertes. Un test estático protege ese alcance; no acredita comportamiento de foco real.
