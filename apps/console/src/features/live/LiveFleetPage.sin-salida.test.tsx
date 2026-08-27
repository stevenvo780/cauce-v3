import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { LoadingState, PACIENCIA_MS } from '../../components/ui';
import { server } from '../../mocks/server';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * **LA VISTA QUE NO TENÍA SALIDA.**
 *
 * 
 * máquina del gateway: tras tres HTTP 500 en `/v3/auth/session`, `/live` se quedó **180 s** en
 * «Leyendo la actividad de la flota…» con un panel blanco y nada más. Sin error, sin botón, sin
 * límite. Y la portada, ante el mismo fallo, sí ofrecía «Reintentar»: dos vistas de la misma
 * consola se comportaban distinto ante el mismo servidor.
 *
 * La rama de salida ya estaba escrita en esta página —`if (activity.error && !snapshot) return
 * <ErrorState onRetry={activity.reload} />`— y era **inalcanzable**, porque sin vencimiento en el
 * cliente HTTP la lectura nunca falla: se queda en vuelo para siempre.
 *
 * Esta prueba entra por la puerta de arriba (la página entera, con su cliente real y su servidor
 * simulado colgado) y exige lo único que importaba: que la pantalla termine ofreciendo una salida.
 */

/** Una lectura que no vuelve nunca, como el gateway del día de la medición. */
function actividadColgada(): void {
  server.use(http.get('http://localhost/v3/console/activity', () => new Promise(() => undefined)));
}

/** La página con un tope de espera corto: el mecanismo es el mismo, la espera no. */
function pintarLive(topeMs: number) {
  const api = new CauceApi('http://localhost', undefined, undefined, topeMs);
  return render(<ApiProvider api={api}><LiveFleetPage /></ApiProvider>);
}

describe('/live cuando el gateway no contesta', () => {
  it('deja de quedarse en el cartel de carga para siempre: vence, lo dice y ofrece reintentar', async () => {
    actividadColgada();
    pintarLive(120);

    // El punto de partida es el defecto medido: el rótulo de carga, y nada más.
    expect(await screen.findByText(/Leyendo la actividad de la flota/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();

    // Y el desenlace es el que la portada ya daba: un error que se lee y un botón que se pulsa.
    const aviso = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(aviso).toHaveTextContent(/no contestó en/i);
    expect(aviso).toHaveTextContent(/\/v3\/console\/activity/);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    // Nada de jerga del navegador en la cara del operador.
    expect(aviso.textContent ?? '').not.toMatch(/abort/i);
  });

  it('el cartel de carga avisa de que va lento en vez de girar mudo', () => {
    vi.useFakeTimers();
    try {
      render(<LoadingState label="Leyendo la actividad de la flota…" />);
      expect(screen.queryByText(/tardando más de lo normal/i)).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(PACIENCIA_MS + 10); });

      const aviso = screen.getByText(/tardando más de lo normal/i);
      expect(aviso).toHaveTextContent(/se corta sola a los 30 s/);
      expect(aviso).toHaveTextContent(/vas a poder reintentar/);
      // El rótulo original NO se pierde: se le añade la explicación, no se le reemplaza.
      expect(screen.getByText('Leyendo la actividad de la flota…')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONTROL NEGATIVO — sin llegar a la paciencia, el cartel no promete nada', () => {
    vi.useFakeTimers();
    try {
      render(<LoadingState />);
      act(() => { vi.advanceTimersByTime(PACIENCIA_MS - 100); });
      expect(screen.queryByText(/tardando más de lo normal/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mientras el reintento va en camino lo dice, para que el botón no parezca muerto', async () => {
    /*
     * Medido en Chrome: al pulsar «Reintentar» con otra lectura ya en vuelo, la nueva se encola y
     * la pantalla no cambia hasta que la anterior vence — hasta 30 s. Se recupera, pero medio
     * minuto sin señal es indistinguible de un botón que no hace nada.
     */
    actividadColgada();
    pintarLive(120);

    const aviso = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(aviso).not.toHaveTextContent(/Hay una lectura en curso/);

    // Se pulsa el botón. Arranca otra lectura que tampoco va a volver: eso es lo que hay que decir.
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() => expect(aviso).toHaveTextContent(/Hay una lectura en curso/));
    expect(aviso).toHaveTextContent(/se corta a los 30 s/);
    // Y el botón sigue siendo pulsable: deshabilitarlo lo dejaría inerte casi siempre, porque con
    // el refresco automático de esta vista casi siempre hay una lectura en vuelo.
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeEnabled();
  });

  it('una lectura sana no ve ni el vencimiento ni el aviso: sigue pintando la flota', async () => {
    // CONTROL NEGATIVO del corte: con el servidor contestando, la página llega a su estado normal.
    pintarLive(4000);
    expect(await screen.findByRole('heading', { level: 1, name: 'La flota ahora' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
