import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CauceApi } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import { LiveFleetPage } from '../src/features/live/LiveFleetPage';
import type { FleetActivitySnapshot } from '../src/api/types';
import '../src/styles.css';
import { STEP_MS, scenarioSnapshot } from './scenario';

/**
 * Banco de pruebas visual de la sala de máquinas. Monta el MISMO componente que se despliega
 * (`LiveFleetPage`) y le enchufa un `CauceApi` cuyo `getFleetActivity()` devuelve el guion en vez
 * de pegarle al gateway. Sirve para mirar las animaciones sin producción delante y para que la
 * revisión de diseño no dependa de que la flota se ponga a trabajar en el momento justo.
 */

let step = 0;
setInterval(() => { step += 1; }, STEP_MS);

class ScriptedApi extends CauceApi {
  override getFleetActivity(): Promise<FleetActivitySnapshot> {
    return Promise.resolve(scenarioSnapshot(step));
  }
}

function PreviewBanner() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="auth-banner" role="status" style={{ marginBottom: 18 }}>
      <p>
        <strong>PREVIEW — datos simulados.</strong> Los 16 alias, sus tenants y sus arneses son los
        reales de producción; <em>qué está haciendo cada uno</em> lo dicta un guion de {Math.round(STEP_MS / 1000)} s
        por paso para que se vean los siete estados y las delegaciones sin esperar a la flota.
        Ciclo en curso: {seconds} s. En la consola real este mismo componente lee
        <code> GET /v3/console/activity</code>.
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider api={new ScriptedApi('')}>
      <div className="app-shell" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <div className="workspace">
          <main id="main-content">
            <PreviewBanner />
            <LiveFleetPage />
          </main>
        </div>
      </div>
    </ApiProvider>
  </StrictMode>,
);
