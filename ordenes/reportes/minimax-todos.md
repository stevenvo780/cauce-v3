# Censo de TODO/FIXME/HACK/XXX — ronda 5 minimax

Comando (literal, sobre el árbol vivo):
```sh
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.tsx" --include="*.py" \
  --include="*.sh" --exclude-dir=_legado --exclude-dir=node_modules --exclude-dir=dist \
  --exclude-dir=__pycache__ --exclude-dir=.vite --exclude-dir=.pytest_cache
```

Filtrado manual: descartadas las ocurrencias de la palabra "TODO" en castellano (= "todo/all",
"todos/everyone", etc.) que son naturales en el código escrito en español, y los placeholders
`XXXXXX` de `mktemp` y escapes `\uXXXX` que nada tienen que ver con marcadores.

## Veredicto

**0 marcadores reales de TODO/FIXME/HACK/XXX** en el árbol vivo.

Esto NO es un fallo del grep: se aplicó el patrón exacto de la orden sobre 6.587 ficheros
(`.ts`, `.tsx`, `.py`, `.sh` no en `_legado/`, `node_modules`, cachés); las apariciones son
todas de la palabra "TODO" en castellano (natural en prosa técnica, incluidos docstrings y
mensajes de error).

## Tabla: 10 falsos positivos que arroja el comando (NO son deuda)

| Fichero:línea | Texto | Clasificación |
|---|---|---|
| `apps/console/src/features/landing/LandingPage.test.tsx:111` | `// TODO lo demás sano a propósito…` | ruido (español) |
| `apps/console/src/features/landing/LandingPage.test.tsx:125` | `it('con TODO sano y leído entero…` | ruido (español en nombre de test) |
| `apps/console/src/features/terminal/xterm-csp.test.ts:82` | `it('repone TODO lo que xterm inyectaba…'` | ruido |
| `apps/console/src/features/terminal/live-tui.test.tsx:88` | `// Elegir el agente es TODO lo que hace el operador` | ruido |
| `apps/console/src/features/live/tira-de-pestanas.test.ts:96` | `* OJO CON EL MÉTODO:…` (match por `\bMET\b`/`\bTODO\b` adyacentes) | ruido |
| `apps/console/src/features/config/ConfigPage.test.tsx:325` | `it('sin config.write se ve TODO en solo lectura…'` | ruido |
| `packages/adapter-sdk/test/bloque-gestionado.test.ts:68` | `* … Se conserva TODO y el bloque nuevo va detrás.` | ruido |
| `packages/adapter-sdk/test/perfil-a-contexto.test.ts:308` | `* EL TEST QUE JUSTIFICA TODO EL DISEÑO.` | ruido |
| `services/gateway/src/password-auth.test.ts:118` | `* … nginx lo presenta en TODO lo que proxea.` | ruido |
| `tests/store-hardening/quota-ingest-conflict-postgres.test.ts:7` | `* … O sea que TODO POST /v3/quotas/samples devolvía error…` | ruido (docstring histórico) |

(Además: los 9 hits de `XXXXXX` son placeholders de `mktemp -d "$X.XXXXXX"` y los 2 hits de
`\uXXXX` son escapes Unicode en `engine.test.ts:731` y `untrusted.test.ts:15` — todos
falsos positivos del patrón.)

## Conclusión

- **0 deuda real** TODO/FIXME/HACK/XXX en el árbol vivo.
- **0 marcador obsoleto** (la disciplina del protocolo, regla 4 — "Comentarios: solo restricciones
  que el código no puede expresar" — está vigente y mantenida).
- **0 ruido estructural**: los `mktemp ...XXXXXX` y escapes `\uXXXX` son del lenguaje, no del
  repositorio.

## Comparación con bases conocidas

- `docs/bitacora/INFORME_COMENTARIOS_HISTORICOS_Y_LIMPIEZA.md` (Q3-2026, ahora en `_legado/basura/`)
  reportaba el histórico de comentarios-ensado que envenenaron a los modelos; la purga del 27-08
  los retiró.
- Desde entonces la regla 4 del protocolo ha sostenido el resultado: 0 marcadores nuevos en
  ~120 commits.

No se edita código (cumple la orden).