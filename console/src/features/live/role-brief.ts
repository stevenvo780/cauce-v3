/**
 * The limits of the declared role cap (`agents.role_brief`), outside the component.
 *
 * They live in their own module for one mechanical and one substantive reason. Mechanical:
 * exporting constants and functions from a component file breaks Vite's fast refresh and
 * `npm run lint` runs with `--max-warnings 0`, so the editor wouldn't compile in CI because of
 * two `react-refresh/only-export-components` warnings. Substantive: the cap isn't the screen's
 * business —it's the same number as the database CHECK and the protocol schema— and keeping it
 * separate makes clear that the screen OBEYS it, not defines it.
 */

/**
 * The cap is NOT cosmetic: the CHECK in migration 020 and the protocol's `self_role` both hit
 * 1200, and going over leaves the alias DEAF —the envelope is rejected against the schema and
 * the agent stops receiving— without any visible error. That's why the counter warns BEFORE
 * the limit and the button turns off: it's the only warning that will exist.
 *
 * Keep this cap aligned with `ROLE_BRIEF_MAX_CODE_POINTS`; avoid the protocol's Node barrel
 * in the browser bundle. The unit is a code point, as in `contarRoleBrief()` below.
 */
export const ROLE_BRIEF_MAX = 1200;

/** How many characters before the cap to start warning, before it's too late. */
const ROLE_BRIEF_CERCA = 120;

/**
 * Counts the SAME thing the server will count, and that's why it trims before measuring.
 *
 * Two decisions, both copied from `normalizeRoleBrief` (packages/store/src/configuration.ts):
 *
 * 1. Trim first (`trim()`), because the store trims and ONLY THEN measures. Counting the raw
 *    text, pasting a `.md` that ends in a newline blocked here a save the server would have
 *    accepted without complaint —and the screen didn't explain why, because the newline isn't
 *    visible—. A counter that doesn't measure what the one that decides measures is a counter
 *    that lies.
 * 2. Count CODE POINTS, same as Postgres's `char_length`. `String.length` counts UTF-16 units,
 *    so a brief with emojis would be declared over the limit when the database accepts it —or
 *    the other way around, depending on where the cutoff fell—.
 */
export function contarRoleBrief(text: string): number {
  return Array.from(text.trim()).length;
}

type RoleBriefTono = 'ok' | 'cerca' | 'pasado';

export function tonoRoleBrief(largo: number): RoleBriefTono {
  if (largo > ROLE_BRIEF_MAX) return 'pasado';
  return largo > ROLE_BRIEF_MAX - ROLE_BRIEF_CERCA ? 'cerca' : 'ok';
}

/**
 * Compatibility guard with runtime: adapters in execution validate UTF-16 length with
 * `z.string().max(1200)`. To prevent a brief with emojis from exceeding the UTF-16 limit when
 * processed by the adapter, it is validated against the stricter of UTF-16 and code points.
 */
export function bloqueoPorRuntimeDesplegado(text: string): string | undefined {
  const recortado = text.trim();
  const utf16 = recortado.length;
  const puntos = Array.from(recortado).length;
  if (utf16 <= ROLE_BRIEF_MAX || puntos > ROLE_BRIEF_MAX) return undefined;
  return (
    `Son ${String(puntos)} caracteres, que la base acepta, pero ${String(utf16)} unidades UTF-16 — y los ` +
    'adaptadores que corren hoy en producción todavía miden así. Guardarlo dejaría al alias ' +
    'SORDO sin dar ningún error. Quitá algún emoji o acortá el texto; la restricción se levanta ' +
    'cuando salga el runtime nuevo.'
  );
}
