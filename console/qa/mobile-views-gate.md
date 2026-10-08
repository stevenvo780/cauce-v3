# Gate de primera pantalla móvil

Mide en Chromium real, con datos sintéticos de sólo lectura, que cada vista de la consola pone su objeto principal en la primera pantalla de un teléfono. Falla cuando un estado no se puede medir: completar la matriz no es aprobarla.

## Contrato

- 22 estados × 360×800, 390×844, 430×932 y 760×1000 × claro y oscuro (movimiento reducido): 176 mediciones
- Cero desborde horizontal del documento
- Objeto principal pintado, con su borde superior dentro del primer 50 % del área útil y al menos 120 px visibles (o toda su altura, si es menor). Se descuentan la barra inferior y el recorte de los ancestros
- La oficina de `/live` trae su lienzo pintado al entrar y también tras recargar
- Un desplazamiento horizontal interno se acepta sólo si el contenedor o alguno de sus controles se alcanza con el teclado. Con un diálogo abierto, la comprobación se limita a él
- Cualquier excepción de página, fixture ausente, mutación, WebSocket o estado sin medir impide aprobar

Estados: entrada y lista de chats, hilo, perfil y contexto del hilo, resumen, oficina, hoja del agente, las tres pestañas de cuentas, entregas, señales, auditoría, las seis secciones de ajustes, selector de terminal, terminal con un agente abierto y ayuda. Tras cada clic se restablece el scroll antes de medir: el desplazamiento automático de Playwright no convierte contenido bajo el pliegue en un pase.

Los selectores se apoyan en lo que la interfaz promete a un lector de pantalla (regiones con nombre, `role`, `aria-label`) y en los `data-objeto-principal` del armazón, no en clases de estilo. `mobile-views-contract.test.mjs` comprueba que cada uno sigue existiendo en la fuente que lo dibuja.

Interacciones medidas además de la geometría: el filtro «Pendientes» de entregas estrecha la tabla; el inventario de cuentas y su botón de actualizar se pintan sin recorte.

## Fixtures

`mobile-views-fixtures.mjs` compila con esbuild los handlers de `src/mocks/handlers.ts` y el fixture de conversación de `src/test/mobile-chat-fixtures.ts`; `msw.getResponse` resuelve las lecturas sin servidor de API. Sólo se añade una colección de configuración sintética para que «Avanzado» tenga una colección desconocida que mostrar. Las mutaciones y los endpoints no declarados se rechazan.

Los handlers del banco de pruebas del navegador (`terminal-demo.ts`, `chat-demo.ts`) no entran aquí: el gate mide los fixtures compartidos.

## Ejecución

El gate no inicia servidor ni instala dependencias, y bloquea cualquier origen distinto del indicado. No sirve el servidor de desarrollo de Vite: su HMR abre un WebSocket y el gate los rechaza. Se mide un build servido con `vite preview`; con `--outDir` aparte no se pisa el `dist` compartido.

```sh
cd console
VITE_USE_MOCKS=false npx vite build --outDir /tmp/cauce-qa/dist --emptyOutDir
VITE_USE_MOCKS=false npx vite preview --outDir /tmp/cauce-qa/dist --host 127.0.0.1 --port 4377 --strictPort &
CAUCE_QA_ORIGIN=http://127.0.0.1:4377 CAUCE_MOBILE_VIEWS_BROWSER=1 \
CAUCE_MOBILE_QA_OUTPUT=/tmp/cauce-qa/mobile-views node qa/mobile-views-gate.mjs
```

Produce `report.json` y un PNG por combinación de estado, viewport y tema. Un informe incompleto o con `passed:false` no es aprobación, y no se rebajan presupuestos para pasar: se arregla la vista. Los contratos puros se prueban sin navegador:

```sh
npx vitest run qa/mobile-views-contract.test.mjs
```

## Alcance

Los fixtures son sintéticos: aprobar el gate no acredita el gateway, permisos reales, credenciales, PTY ni la aceptación de extremo a extremo. Tampoco cubre carga, error y vacío por vista, formularios, teclado físico ni safe-area real. El contrato del hilo de chat (≥ 60 % del contenido) lo mide `mobile-chat-gate.mjs`.
