import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { LoadingState, PACIENCIA_MS } from '../../components/ui';
import { server } from '../../mocks/server';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * Verificación de manejo de timeout y estado de error en LiveFleetPage:
 * comprueba que ante lecturas lentas o colgadas se alcance el estado de reintento.
 */

function actividadColgada(): void {
  server.use(http.get('http://localhost/v3/console/activity', () => new Promise(() => undefined)));
}

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
    expect(aviso.textContent).not.toMatch(/abort/i);
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
    actividadColgada();
    pintarLive(120);

    const aviso = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(aviso).not.toHaveTextContent(/Hay una lectura en curso/);

    // Se pulsa el botón. Arranca otra lectura que tampoco va a volver: eso es lo que hay que decir.
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() => { expect(aviso).toHaveTextContent(/Hay una lectura en curso/); });
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
