# Lectura de gobierno del modal de directiva — caso histórico sanitizado

> El nombre del archivo se conserva para mantener estables las referencias. Hosts, aliases,
> rutas, fechas, releases, digests, métricas, cuerpos e identificadores viven sólo en el ledger
> privado.

## Síntoma

El modal podía leer el rol declarado, pero mostraba como ausentes los documentos de gobierno y la
memoria. La interfaz no era la causa única: la lectura atravesaba varias capas incompletas.

## Cadena causal

El incidente reunió siete fallos independientes:

1. La imagen del gateway no contenía o no montaba la ruta de lectura.
2. La imagen del relay no exponía la operación requerida.
3. El agente de terminal desplegado no anunciaba la capacidad de gobierno.
4. Las variables presentes en el archivo de entorno no llegaban al servicio porque Compose
   declaraba su bloque `environment` de forma explícita.
5. El gateway usaba una credencial TLS de servidor donde el relay exigía una identidad de cliente.
6. La fuente de hechos del alias devolvía vacío; sin home no podía construirse una ruta.
7. El agente publicaba el home, pero el relay lo descartaba al reconstruir la presencia campo por
   campo.

La lección central es que una configuración escrita no equivale a una capacidad desplegada. Cada
salto debe verificarse en el proceso vivo.

## Corrección aplicada

- Se construyó una imagen completa y reproducible. Copiar módulos compilados sueltos entre builds
  incompatibles había demostrado que podía romper el grafo de imports.
- Se preservó el acotado de dimensiones del relay para no reintroducir una regresión de terminales.
- Se emitió una identidad TLS de cliente con la CA autorizada y se añadió a la allowlist sin retirar
  identidades anteriores.
- El agente de terminal se publicó como release nueva y el selector se movió al artefacto validado.
- El home se mantuvo opcional durante el rollout: agentes anteriores siguieron operando, aunque sin
  lectura de directiva hasta actualizarse.

## Reinicio seguro

Un reinicio directo podía dejar un proceso huérfano dentro del contenedor. La secuencia verificada
fue detener la unidad, retirar únicamente el proceso huérfano y volver a iniciar. Dos procesos por
alias podían ser normales por la frontera host/contenedor; la detección no debe basarse sólo en un
conteo fijo.

## Verificación

La evidencia privada conserva:

- un control negativo de autenticación y otro de ruta inexistente;
- una lectura real gateway → relay → agente de terminal;
- suites focales de los tres componentes;
- salud del stack y estado de entregas durante la ventana observada.

Los valores, identidades y resultados exactos no se transcriben aquí. La prueba no incluyó abrir el
modal con una sesión humana ni repetir el flujo de terminal desde la interfaz, por lo que esos dos
puntos no quedaron acreditados por el incidente.

## Escritura todavía pendiente

El camino observado era sólo de lectura. Crear o modificar un documento requería, como mínimo:

1. capacidad explícita en el agente;
2. operación equivalente en el relay;
3. ruta autenticada en el gateway;
4. control de interfaz;
5. validación del directorio padre y contención de ruta.

En un home montado, una sustitución por `rename` puede cambiar ownership o cruzar fronteras de
filesystem. La estrategia de escritura debe validar ese contrato antes de elegirse.

## Reversa

La reversa debe restaurar los selectores exactos de runtime y agente de terminal desde el ledger
privado, recrear los servicios afectados y aplicar la secuencia segura de reinicio. No reconstruir
releases, digests, rutas ni credenciales desde este documento.

---

## Anexo histórico: soporte de adjuntos de la flota

La evidencia privada mostró que un harness emitía cero `artifacts` y escribía rutas privadas en el
texto. Los bodies, aliases, hosts, paths, fechas, releases y digests observados no se transcriben en
este repositorio.

No era culpa del agente y había tres capas:

1. El harness inyectaba una convención de medio válida para su canal propio, pero inerte dentro del
   sobre de Cauce.
2. El agente había emitido `artifacts` correctamente; la release activa aún no incluía el inliner
   que convierte un fichero local a `data:`.
3. El protocolo nombraba `artifacts` sin una invariante comparable a las de los demás campos.

### Estado histórico

Se desplegó un canario autenticado y el resto de la flota permaneció en la release previa hasta
validación humana. Las identidades y referencias exactas viven sólo en el ledger privado; esta
sección no es una instrucción de despliegue vigente.

### Trampas relevantes

- El supervisor verificaba el digest del bundle, no un manifiesto reconstruido a mano.
- Sustituir sólo una mitad de dos paquetes acoplados podía romper el grafo de módulos.
- La prueba de vuelo debía cargar el paquete completo e importar el engine, el inliner y el binario
  antes de fijar el release.

### Reversa del canario

La reversa histórica comparaba el CAS y digest anteriores con los actuales, ambos recuperados del
ledger privado, y reiniciaba únicamente la unidad afectada. No reutilizar esta descripción como
comando ni inferir valores faltantes.
