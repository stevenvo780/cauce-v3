/**
 * **Dónde empieza un hilo de conversación.**
 *
 * Medido en producción el 2026-08-23: al abrir la conversación de zeus, el hilo arrancaba en la
 * burbuja de las 2:00:01 —la MÁS VIEJA— y el último mensaje (16:16:09) quedaba a 10.976 px dentro
 * del contenedor, con `scrollY = 0` y una ventana de 900: unas doce pantallas de arrastre. Una
 * búsqueda en el DOM de cualquier botón o enlace con `ultimo|reciente|abajo|final|bajar` daba
 * CERO resultados. O sea: la consola abría por el principio y no ofrecía ninguna forma de llegar
 * al final. Es lo contrario de lo que hace cualquier mensajería, y era lo primero que un operador
 * necesita: lo último que dijo el agente.
 *
 * Las dos decisiones viven acá, puras, porque jsdom no tiene layout y en el componente no se
 * pueden probar: ahí sólo se comprueba que el efecto llame a esto (`MessagesPage.test.tsx`).
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
