/**
 * Utilidades para el control de desplazamiento automático y anclaje al final del hilo de mensajes.
 */

/**
 * Cuánto puede faltar para el final y seguir contando como «está mirando el final».
 *
 * No es cero: un hilo con imágenes o fuentes que terminan de cargar mueve el fondo unos píxeles, y
 * con margen cero el operador quedaría «despegado» sin haber tocado nada — y entonces los mensajes
 * nuevos dejarían de seguirlo. 80 px es menos que una burbuja, así que nunca tapa un mensaje.
 */
export const MARGEN_PEGADO = 80;

export interface CajaDesplazable {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** ¿El operador está mirando el final del hilo? De esto depende si los mensajes nuevos lo siguen. */
export function estaPegadoAlFinal(caja: CajaDesplazable): boolean {
  return caja.scrollHeight - caja.scrollTop - caja.clientHeight <= MARGEN_PEGADO;
}

/**
 * Lleva la caja al final.
 *
 * Usa `scrollTo` cuando existe y cae a `scrollTop` cuando no: `Element.prototype.scrollTo` no
 * está implementado en jsdom, y una prueba que espiara sólo `scrollTop` no distinguiría «no se
 * llamó» de «se llamó y jsdom lo ignoró» —jsdom no tiene layout, así que `scrollHeight` es 0 y el
 * asignador queda en 0 pase lo que pase—. Con el `scrollTo` de por medio la prueba puede exigir
 * el EFECTO: a qué caja y con qué destino.
 */
export function irAlFinal(caja: HTMLElement, suave = false): void {
  const destino = caja.scrollHeight;
  if (typeof caja.scrollTo === 'function') {
    caja.scrollTo({ top: destino, behavior: suave ? 'smooth' : 'auto' });
    return;
  }
  caja.scrollTop = destino;
}
