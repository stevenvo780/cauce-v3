import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Los mocks los decide UNA sola bandera de compilación: `VITE_USE_MOCKS`. Antes se exigía además
 * `import.meta.env.DEV`, lo que hacía imposible publicar una demostración: un build de producción
 * con la bandera puesta arrancaba contra un backend inexistente y se quedaba en pantallas de error.
 *
 * La bandera es de COMPILACIÓN, no de runtime: un build sin ella evalúa esta condición a constante
 * y el bundler elimina el `import()` entero, así que `msw` no viaja en el bundle de producción.
 * Y cuando sí está puesta, la aplicación lo declara en pantalla con el cartel `MOCK API` de la
 * barra superior (`App.tsx`): una demostración que no se anuncia como tal es una mentira.
 */
async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS !== 'true') return;
  try {
    const { worker, keepMockingAlive } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
    keepMockingAlive();
  } catch (cause) {
    // Que los mocks no arranquen NO puede costar la aplicación entera. Sin este `catch` la promesa
    // se rechaza, el `.then()` de abajo no corre y no se monta React: pantalla en blanco, sin una
    // sola palabra que explique por qué. Medido: detrás de una auth básica, el registro del service
    // worker puede recibir 401 (el navegador aún no tiene credenciales en caché para ese origen) y
    // toda la consola desaparecía por eso. Montando igual, la aplicación se ve y cada vista informa
    // su propio error de red, que es un diagnóstico y no un vacío.
    console.error('[mocks] no se pudo iniciar MSW; la consola se monta igual y las vistas van a fallar contra el backend real.', cause);
  }
}

void enableMocking().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
