# El punto ciego de `.mjs` en el lint estricto — decisión y el número que la sostiene

`eslint.estricto.config.js` declara `files: ['**/*.ts', '**/*.tsx']`. En el árbol hay **71 ficheros
`.mjs` / 11.771 líneas** —`ops/harness`, `ops/tests`, `ops/scripts`, `scripts/`, `deploy/runtime`,
`console/qa`, `packages/adapter-sdk/{scripts,test/fixtures,bridge}`, `tests/terminal-pty`,
`packages/mcp-fleet-monitor`— que ese config no mira nunca. Entre ellos
`ops/tests/container-supervisor.test.mjs`, la suite adversarial del supervisor de contenedores.

**No es que estén sin lint.** El gate que corre de verdad (`pnpm lint`, `eslint.config.js`) sí los
mira: su primer bloque es `files: ['**/*.{js,mjs}']` con `js.configs.recommended`. Lo que no los
mira es el nivel **estricto**, que es donde viven las reglas con tipos.

## Lo medido (2026-08-30, con configs de usar y tirar, ya borrados)

| Qué se apunta a los 71 `.mjs` | Resultado |
|---|---|
| `tseslint.configs.strict` + `stylistic` (**sin** tipos) | **5 problemas** |
| `strictTypeChecked` + `stylisticTypeChecked`, tal como está el config hoy | **71 errores de parseo** — los 71 ficheros: «was not found by the project service» |
| Lo mismo, **metiendo los 71 en un `tsconfig` con `allowJs`** | **4.086 problemas** |

Los 5 del primer caso, enteros:

```
ops/harness/contract-runner.mjs
  351:7  error  Expected a `for-of` loop instead of a `for` loop with this simple iteration  @typescript-eslint/prefer-for-of
ops/tests/container-supervisor.test.mjs
  106:41  error  Do not delete dynamically computed property keys  @typescript-eslint/no-dynamic-delete
scripts/calidad.mjs
  58:82  error  Do not delete dynamically computed property keys  @typescript-eslint/no-dynamic-delete
scripts/grafo.mjs
  51:13  error  'ruta' is never reassigned. Use 'const' instead  prefer-const
  59:9   error  'r' is never reassigned. Use 'const' instead     prefer-const
```

Y el reparto de los 4.086 del tercer caso:

```
1732 no-unsafe-member-access     349 restrict-template-expressions    48 prefer-nullish-coalescing
 839 no-unsafe-assignment        269 no-unsafe-argument               40 no-floating-promises
 485 no-unsafe-call              168 no-unsafe-return                 39 no-confusing-void-expression
  57 restrict-plus-operands       18 no-unnecessary-condition         …y 22 reglas más con ≤18 cada una
```

## La decisión

**Se acepta el punto ciego del nivel estricto sobre `.mjs`, y no se meten en un `tsconfig`.**

El motivo está en el reparto: **3.942 de los 4.086 (el 96%)** son la familia `no-unsafe-*` más
`restrict-template-expressions`. No son defectos: son el ruido que produce apuntar reglas con tipos
a JavaScript sin anotar, donde todo es `any` por construcción. Cerrarlos no es una ronda de
limpieza —es **tipar 11.771 líneas de JavaScript de operación**, es decir, convertirlas a
TypeScript. Ese es un proyecto con su propia justificación, no un efecto colateral de un config de
lint.

Y el primer número dice que no hay nada escondido: con las reglas estrictas **sin** tipos, 11.771
líneas dan **5 problemas**. El punto ciego no tapa una montaña de defectos.

## Lo que sí conviene hacer, y de quién es

Añadir a `eslint.estricto.config.js` un bloque `files: ['**/*.mjs']` con
`tseslint.configs.strict` + `stylistic` (**sin** los `TypeChecked`). Eso sube el listón sobre los
71 ficheros al coste de los 5 problemas de arriba, sin tocar ningún `tsconfig` y sin abrir los
4.086.

`eslint.estricto.config.js` es de otra orden en curso; aquí solo queda medido y decidido.
