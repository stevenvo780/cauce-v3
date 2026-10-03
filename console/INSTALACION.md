# Instalar Cauce en el teléfono

La consola declara `display: standalone`: al abrirla desde su icono instalado, un navegador compatible usa una ventana de aplicación sin la barra de direcciones habitual. Abrir el enlace en una pestaña sigue mostrando el navegador. El sistema conserva sus barras de estado y gestos; no se solicita pantalla completa.

## Android

1. Abrir la consola publicada por HTTPS en Chrome actualizado e iniciar sesión si corresponde.
2. Abrir el menú de Chrome y elegir **Añadir a pantalla de inicio → Instalar**. El texto puede variar según la versión.
3. Confirmar la instalación y abrir **Cauce** desde el icono del teléfono. El inicio abre Conversaciones (`/messages`).

La decisión y la instalación pertenecen al usuario. No hay un aviso flotante ni una solicitud automática que ocupe espacio de conversación. Si Chrome solo ofrece un acceso directo que vuelve a una pestaña, revisar los recursos de instalación y la compatibilidad del navegador antes de dar el resultado por válido. Una pestaña no puede ocultar su propia barra de direcciones mediante este cambio.

## iPhone y iPad

En Safari, usar **Compartir → Añadir a pantalla de inicio**, activar **Abrir como app web** si aparece y confirmar **Añadir**. Se incluyen icono y metadatos compatibles con la pantalla de inicio de iOS. Puede hacer falta iniciar sesión de nuevo en la aplicación instalada; no se presupone que comparta la sesión de Safari. La disponibilidad y los rótulos dependen de la versión del sistema.

## Requisitos y límites

- HTTPS con certificado válido y el origen accesible desde el teléfono. La excepción de desarrollo para `localhost` no convierte una dirección HTTP de la red local en un origen seguro.
- `manifest.json` y los iconos deben responder con su contenido real, no con HTML de login o de la SPA. El enlace incluye `crossorigin="use-credentials"` para conservar el acceso a manifiestos protegidos incluso dentro del mismo origen; no se cambian las reglas de autenticación del servidor.
- El despliegue actual sirve la SPA en la raíz (`console/nginx.conf` y `deploy/console/nginx-console-tls.conf`). Por eso el ámbito y la identidad estable son `/`, y los recursos usan rutas absolutas del mismo origen. Un despliegue bajo un prefijo necesita revisar conjuntamente estas rutas y el enrutador.
- Los enlaces internos, incluidos los de conversaciones y contexto, siguen dentro del ámbito. No se interceptan enlaces ni se reescriben retornos de login. Un proveedor de identidad u otro destino externo puede mostrar controles del navegador por seguridad. Volver a Cauce debe recuperar su experiencia de aplicación cuando el navegador lo permita.
- No se añade ni registra un service worker de producción. No hay caché de mensajes, API autenticada o credenciales añadida por esta función, ni cola de acciones sin conexión. La consola sigue necesitando red y una sesión válida. El service worker de MSW existente sigue limitado a las compilaciones de demostración con `VITE_USE_MOCKS=true`.
- La instalación desde el menú de Chrome Android no requiere un service worker. La promoción automática depende del navegador y del uso previo; no se promete que aparezca un aviso de instalación.
- El manifiesto usa el color claro del arranque; la página conserva sus metadatos de tema claro/oscuro y el control de tema existente.

## Verificación antes de publicar

`pnpm --filter @cauce/console exec vitest run src/pwa-manifest.test.ts` comprueba enlace autenticado, identidad, ámbito, tamaños PNG y el círculo seguro del icono adaptable. Ejecutar además los gates del repositorio y `pnpm --filter @cauce/console build`; el build debe contener el manifiesto y todos sus iconos sin alterar sus bytes.

En el origen HTTPS de prueba, comprobar el manifiesto con las herramientas del navegador, sus respuestas e iconos, el login y un enlace profundo. Después instalar en Android, cerrar y volver a abrir desde el icono, navegar entre conversaciones/contexto, usar Atrás y abrir el teclado. Verificar que no aparece la barra de direcciones dentro de Cauce y que el compositor permanece accesible. Comprobar también el error real al perder red; no debe simularse un envío correcto. La emulación de `display-mode` y las pruebas unitarias no sustituyen esta instalación real.

## Marca e iconos

`public/icons/cauce.svg` reutiliza el trazo **Activity** de Lucide que ya usa la marca de la consola, con los colores `--mint-dim` y `--on-mint`. Su licencia se conserva en `public/icons/LICENSE-lucide.txt`. Los PNG son representaciones opacas del mismo vector; la versión adaptable tiene fondo hasta los bordes y la marca dentro del círculo central de radio 40 %.

Para regenerarlos con herramientas de gráficos ya disponibles, exportar el SVG con Inkscape a PNG de 1024 × 1024 y reducirlo con ImageMagick a 192, 512 y 180 píxeles. Usar RGB de 8 bits (`-alpha off -strip -define png:color-type=2`) y copiar el de 512 como `cauce-maskable-512.png`. No se requiere una dependencia nueva del proyecto.

## Referencias

- [Criterios de instalación de Chrome](https://web.dev/articles/install-criteria)
- [Instalación desde el menú sin service worker](https://developer.chrome.com/blog/update-install-criteria)
- [Instalar aplicaciones web en Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=es)
- [Pantalla de inicio en Safari](https://support.apple.com/guide/iphone/iph42ab2f3a7/ios)
- [Manifiestos que requieren credenciales](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/crossorigin#web_manifest_with_credentials)
- [Ámbito de la aplicación instalada](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/scope)
- [Zona segura de los iconos adaptables](https://www.w3.org/TR/appmanifest/#icon-masks-and-safe-zone)
