/**
 * The terminal view doctrine sentence.
 *
 * It lives in its own module because it is written in TWO places and has to say the same in both:
 * the grid footer (`.terminal-doctrine`) is where it is read while picking who to open, and the
 * "Fleet status" dropdown in the header is where it stays reachable when that footer folds away to
 * give the terminal back its height. Hand-copied in both places, the day one changes the other keeps
 * telling the old version of what the console promises not to do.
 */
export const TEXTO_DOCTRINA =
  'Cliente de transporte: no crea workers remotos, no ejecuta adapters y no persiste sesiones.';
