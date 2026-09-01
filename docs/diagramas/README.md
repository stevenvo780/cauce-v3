# Arquitectura visual con Archify

El mapa navegable de Cauce vive en dos archivos:

- `cauce-v3.architecture.json`: especificación tipada y revisable.
- `cauce-v3.architecture.html`: visor autónomo, sin servidor ni dependencias web.

Abrí el HTML directamente para recorrer componentes, relaciones, vistas guiadas, fuentes de código y temas claro/oscuro. Para trabajar en vivo:

```bash
pnpm arch:preview
```

El preview escucha únicamente en loopback y vuelve a renderizar cuando cambia el JSON. Los demás comandos son:

```bash
pnpm arch:verify
pnpm arch:validate
pnpm arch:render
pnpm arch:visual-check
```

## Instalación fijada

El wrapper acepta una instalación en `.agents/skills/archify`, en `ARCHIFY_SKILL_ROOT` o en el directorio personal de skills de Codex. Antes de ejecutar compara los 190 archivos con `scripts/archify.lock.json`; una versión distinta o un byte modificado falla cerrado. La comprobación remota de actualizaciones de Archify permanece desactivada durante todos los comandos del proyecto y el proceso hijo recibe una allowlist de variables, nunca el entorno completo.

La versión fijada es `v2.16.0`, commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`, bajo licencia MIT. El tag upstream no está firmado; por eso el lock conserva también el SHA-256 del ZIP oficial y el digest del árbol instalado.

Para instalar exactamente esa versión con el instalador de Codex:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo tt-a1i/archify --path archify --ref v2.16.0
```

Para render y preview se deriva una copia temporal del árbol ya verificado y se retira del template la carga automática de Google Fonts. El gate rechaza `link`, `script`, `img`, `iframe`, `source` o `url(...)` remotos en el HTML final: los enlaces de evidencia hacia GitHub siguen siendo clicables, pero abrir el mapa no dispara dependencias web.

Las capturas y recibos de `visual-check` son evidencia regenerable y no se versionan. El HTML entregado sí se versiona para que cualquier persona pueda abrir el mapa sin instalar Archify.
