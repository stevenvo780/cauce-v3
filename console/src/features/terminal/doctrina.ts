/**
 * La frase de doctrina de la vista del terminal.
 *
 * Vive en su propio módulo porque se escribe en DOS sitios y tiene que decir lo mismo en los dos:
 * el pie de la rejilla (`.terminal-doctrine`), que es donde se lee mientras se elige a quién abrir,
 * y el desplegable «Estado de la flota» de la cabecera, que es donde queda alcanzable cuando ese
 * pie se repliega para devolverle su alto al terminal. Copiada a mano en los dos sitios, el día que
 * cambie una va a quedar la otra contando la versión vieja de lo que la consola promete no hacer.
 */
export const TEXTO_DOCTRINA =
  'Cliente de transporte: no crea workers remotos, no ejecuta adapters y no persiste sesiones.';
