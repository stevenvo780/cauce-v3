import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);

/**
 * Mantiene vivo —y re-registrado— el service worker de MSW.
 *
 * El worker guarda los clientes con mocking activo en un `Set` **en memoria**
 * (`activeClientIds`, en `public/mockServiceWorker.js`). El navegador apaga un service worker
 * ocioso a los ~30 s; cuando después lo despierta, ese `Set` viene vacío y su handler de `fetch`
 * deja pasar TODO a la red (`if (activeClientIds.size === 0) return`). La página sigue
 * "controlada" —`navigator.serviceWorker.controller` sigue estando— así que no hay error, ni
 * aviso, ni nada roto a la vista: simplemente los datos dejan de llegar.
 *
 * Medido en la consola desplegada: al entrar directo a una vista se dibujaba entera, pero al
 * llegar a esa misma vista por el menú medio minuto después la pantalla salía vacía, con
 * "UNKNOWN" en vez de datos, porque `GET /v3/console/topology` se lo terminaba comiendo el
 * fallback SPA del servidor estático y devolvía el `index.html`. Peor todavía: la revalidación de
 * sesión cada 60 s caía en la misma red real y tiraba la pantalla de "No se pudo verificar la
 * sesión" sobre una consola que hasta hacía un momento funcionaba.
 *
 * El ping resuelve las dos mitades del problema con un solo mensaje: atender un evento renueva la
 * vida del worker (así no lo apagan mientras la pestaña esté abierta), y `MOCK_ACTIVATE` vuelve a
 * meter este cliente en el `Set` si igual lo apagaron —una suspensión de la máquina, por
 * ejemplo—. Se dispara además al volver a la pestaña, que es cuando más probable es que el worker
 * haya muerto mientras nadie miraba.
 */
export function keepMockingAlive(intervalMs = 10_000): () => void {
  const reactivate = (): void => {
    navigator.serviceWorker?.controller?.postMessage('MOCK_ACTIVATE');
  };
  const timer = window.setInterval(reactivate, intervalMs);
  document.addEventListener('visibilitychange', reactivate);
  window.addEventListener('focus', reactivate);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', reactivate);
    window.removeEventListener('focus', reactivate);
  };
}
