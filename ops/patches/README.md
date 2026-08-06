# Parches sobre software de terceros

Acá vive lo que arreglamos **fuera** de este repo: archivos de paquetes que no publicamos nosotros
y que, por eso, no se pueden corregir con un commit y un despliegue.

Un parche de este directorio se aplica sobre un artefacto **ya instalado**. Cualquier cosa que
reinstale o recree ese artefacto —`npm i -g`, una imagen nueva, un `docker compose up` que recree el
contenedor— lo borra en silencio y el fallo vuelve sin avisar. Por eso el parche vive acá con su
script: para poder volver a aplicarlo sin reconstruirlo de memoria, y para saber qué hay que revisar
después de cada actualización del paquete.

Reglas:

- **El script tiene que ser idempotente.** Se corre sobre contenedores que ya pueden estar
  parcheados; correrlo de nuevo no puede duplicar nada ni romper el archivo.
- **Backup antes de escribir**, con la fecha en el nombre. Es la única marcha atrás que hay.
- **Verificar el resultado**, no el código de salida del editor: el script comprueba que el archivo
  parcheado sigue siendo JavaScript válido antes de dejarlo en su lugar.
- **Reportar el estado de cada objetivo** (`aplicado` / `ya-aplicado` / error) por separado. Un
  parche a medias en la flota es peor que ninguno, porque el síntoma aparece en unos alias y en
  otros no.

Antes de tocar nada, comprobá que los archivos de acá siguen sanos:

```bash
bash -n ops/patches/*.sh
node --check ops/patches/*.mjs
```

---

## `openclaw-turn-compaction-guard` — una compactación fallida se llevaba la respuesta ya calculada

**Paquete:** `openclaw` 2026.6.6 (instalación global, `/usr/lib/node_modules/openclaw`).
**Archivo:** `dist/agent-command-DimMXeog.js`.
**Aplicado el 2026-08-06 en 10 contenedores**: `claw`, `claw-miguel`, `claw-iza`, `ctrl-infra`,
`agv2-pablo-personal-oc`, `agv2-pablo-marcas-oc`, `agv2-jhon-hegel-oc`, `agv2-jhon-heraclito-oc`
(VPS) y `agv2-pablo-infra-oc`, `agv2-pablo-developer-oc` (kratos).

### Qué falla

Terminado el turno, `agent-command` persiste el transcript y después llama a
`runCliTurnCompactionLifecycle(...)` para compactar la sesión. Esa llamada estaba **sin proteger**,
mientras que la persistencia del transcript, tres líneas más arriba, sí tiene su `try/catch` con
`log.warn`. Si la compactación tiraba —el modelo de resumen sin cuota, un store a medio escribir—,
la excepción se llevaba puesto el turno **entero**: la respuesta ya estaba calculada y pagada, y no
se entregaba nunca.

Se ve como un agente que trabaja y no contesta. No hay error en el canal ni entrega fallida: el
trabajo estaba hecho y se tiró en el último paso, por una tarea de mantenimiento que ni siquiera
forma parte de la respuesta.

### El arreglo

Envolver la llamada en `try/catch` y dejar constancia con `log.warn`, exactamente como ya hace el
bloque de persistencia del transcript que tiene al lado. Una compactación fallida pasa a costar una
línea de log —y una sesión sin compactar, que se compactará en el turno siguiente— en vez de un
turno completo.

```diff
-if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) sessionEntry = await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({
+if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) try { sessionEntry = await (await loadCliCompactionRuntime()).runCliTurnCompactionLifecycle({
 	...
 });
+} catch (error) { log.warn(`Turn compaction failed for ${sessionKey ?? sessionId}: ${error instanceof Error ? error.message : String(error)}`); }
```

### Cómo aplicarlo

```bash
# Sobre el contenedor donde corre openclaw (uno o varios):
ops/patches/apply-openclaw-turn-compaction-guard.sh claw claw-miguel claw-iza

# Sobre esta máquina, si openclaw está instalado acá:
ops/patches/apply-openclaw-turn-compaction-guard.sh --local

# Otra ruta (el nombre del bundle cambia con cada versión de openclaw):
OPENCLAW_DIST=/otra/ruta/agent-command-XXXX.js ops/patches/apply-openclaw-turn-compaction-guard.sh --local
```

El script deja un `.bak-<fecha>` al lado del archivo y no toca nada si el parche ya está puesto.
**No reinicia nada**: openclaw carga el bundle al arrancar, así que el parche recién surte efecto
en el próximo arranque del proceso.

### Cómo comprobar que está puesto

```bash
docker exec claw grep -c 'Turn compaction failed' \
  /usr/lib/node_modules/openclaw/dist/agent-command-DimMXeog.js   # 1 = parcheado, 0 = no
```

### Cuándo revisarlo

En **cada actualización de openclaw**. El nombre del archivo (`agent-command-DimMXeog.js`) es un
hash del bundle y cambia con la versión, así que una versión nueva llega siempre sin el parche y con
otro nombre. Si el upstream ya lo arregló, el script avisa que no encuentra el punto de anclaje: eso
es la señal para borrar esta sección, no para forzar el reemplazo.
