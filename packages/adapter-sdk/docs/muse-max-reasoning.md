# Muse: máximo anunciado y verificación sin ejecutar tareas

El runner fija el modelo configurado y envía el esfuerzo explícito en cada
`turn/start`. Antes consulta `model/list`, valida la ruta y sus esfuerzos,
y rechaza soporte desconocido o contradictorio. No cambia de licencia,
modelo o esfuerzo para ocultar un fallo.
Un esfuerzo explícito exige `source=providerCatalog`; un catálogo local,
configurado o sin resolver no prueba el soporte de la suscripción.

## Qué admite la instalación de Hospital

Las consultas independientes en Teseo y Perseo, con sus estados propios y
Muse `1.4.0-R4302.1`, devolvieron `source=providerCatalog` y:

- `muse-spark-1.3`: `minimal,low,medium,high,xhigh,max`.
- `muse-spark-1.3-contributor`: la misma lista, incluido `max`.
- Ambas rutas 1.2: hasta `xhigh`.

La suscripción existente anuncia `max` para las dos rutas 1.3. La documentación
de [Meta Model API](https://dev.meta.ai/docs/models) limita el `max` de la API
directa a Standard; esa restricción no debe extrapolarse al catálogo de la
suscripción. Se mantiene el modelo explícito ya configurado en cada adaptador.
Después de instalar `1.4.1-R4503.1`, los dos catálogos propios confirmaron de nuevo
`maximum=max`, `supportVerified=true`, sin iniciar sesiones ni turnos.

`ultra` es una opción cliente relacionada con flujos de subagentes,
según [Meta](https://dev.meta.ai/resources/blog/muse-code-new-plans-and-features).
No figura en el catálogo observado como esfuerzo del modelo. El runner no
inventa ese soporte ni rebaja silenciosamente `ultra` a `max`.

## Compatibilidad del catálogo

La exportación offline del binario `1.4.1-R4503.1` declara:

- `variants`: lista completa ordenada o el literal `unknown`.
- `reasoningEffortVariants`: subconjunto opcional con `{tier,description?}`.
- `defaultReasoningEffort`: opcional y perteneciente a la lista completa.

El host 1.4.0 observado devuelve sólo `variants`. Los fixtures cubren ambos
formatos reales, capacidades desconocidas, descripciones contradictorias,
Contributor con/sin `max`, y rechazo de `ultra` no anunciado.

## Instalación y prueba

El binario público local está en `/tmp/hospital-muse-release-20260929/`.
Instalar su ejecutable versionado en el montaje de Muse requiere la ventana
de despliegue del operador; este chequeo no cambia ningún estado existente.
Hospital conserva `MUSE_EXECUTABLE=/opt/muse-code/muse`, requerido por la guardia
del supervisor. El aprovisionador instala allí `muse-pinned-launcher.sh`, que
ejecuta únicamente `muse-bin-1.4.1-R4503.1` del mismo montaje. Así se conserva
la guardia y se evita autoactualizar dentro del montaje de sólo lectura.
El ejecutable instalado se verificó con SHA-256
`8b53c9cdbc025bc2d9068bc7016e2c1e51c3a0c608821da17528ad23be900a12`.

Tras instalar el binario, ejecutar una vez por developer con sus `HOME`,
`XDG_CONFIG_HOME` y `XDG_DATA_HOME` propios:

```sh
node packages/adapter-sdk/scripts/muse-catalog-check.mjs \
  /opt/muse-code/muse-bin-1.4.1-R4503.1 muse-spark-1.3 max
```

Para un contenedor sin el script montado, alimentar el mismo script por stdin:

```sh
docker exec -i -w /home/node/clawd \
  -e HOME=/home/node \
  -e XDG_CONFIG_HOME=/home/node/.muse/config \
  -e XDG_DATA_HOME=/home/node/.muse/data \
  hospital-agent-muse-backend-1 node --input-type=module - \
  /opt/muse-code/muse-bin-1.4.1-R4503.1 muse-spark-1.3 max \
  < packages/adapter-sdk/scripts/muse-catalog-check.mjs
```

Repetir en `hospital-agent-muse-frontend-1`; usar el modelo explícito de su
configuración si difiere. Exigir salida `serverVersion=1.4.1`,
`source=providerCatalog`, `maximum=max`, `supportVerified=true`, y exit 0.
El script sólo envía `initialize`, `initialized` y `model/list`:
`sessionStarts=0`, `turnStarts=0`. No imprime credenciales, perfil ni historial.

## Espera del turno

`timeoutKind=no-progress` renueva su ventana sólo con items o deltas nuevos
del turno exacto. Los eventos de otros turnos y los replays de revisiones
viejas no cuentan, ni los deltas vacíos o con cursor repetido. Los cursores
se deduplican como valores opacos, con presupuesto de 65.536 valores y 16 MiB
por turno; rebasarlo produce un fallo explícito. `hard` conserva el límite de duración. El preflight sigue
acotado y la reconciliación dispone de cinco segundos propios; ningún error
reinicia el reloj ni vuelve a enviar `turn/start`.

La salida demuestra soporte anunciado y selección configurada; no mide el
presupuesto interno de razonamiento de una respuesta. La telemetría del runner
registra ruta, soporte, esfuerzo solicitado y terminal durable de cada turno.
Un catálogo sin credenciales no demostró soporte: 1.4.1 devolvió lista vacía y
el chequeo cerró con exit 1. Debe verificarse con cada estado propio instalado.
