import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { LoadingState, PACIENCIA_MS } from '../../components/ui';
import { server } from '../../mocks/server';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * Verification of timeout and error handling in LiveFleetPage: checks that slow or hanging
 * readings reach the retry state.
 */

function actividadColgada(): void {
  server.use(http.get('http://localhost/v3/console/activity', () => new Promise(() => undefined)));
}

function pintarLive(topeMs: number) {
  const api = new CauceApi('http://localhost', undefined, undefined, topeMs);
  return render(<ApiProvider api={api}><LiveFleetPage /></ApiProvider>);
}

describe('/live cuando el gateway no contesta', () => {
  it('stops getting stuck on the loading banner forever: it times out, says so, and offers retry', async () => {
    actividadColgada();
    pintarLive(120);

    // The starting point is the measured default: the loading label, and nothing else.
    expect(await screen.findByText(/Leyendo la actividad de la flota/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reintentar/i })).not.toBeInTheDocument();

    // And the ending is what the landing page already had: an error that is read and a button
    // that is pressed.
    const aviso = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(aviso).toHaveTextContent(/no contestó en/i);
    expect(aviso).toHaveTextContent(/\/v3\/console\/activity/);
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    // No browser jargon in front of the operator.
    expect(aviso.textContent).not.toMatch(/abort/i);
  });

  it('the loading banner warns it is slow instead of spinning silently', () => {
    vi.useFakeTimers();
    try {
      render(<LoadingState label="Leyendo la actividad de la flota…" />);
      expect(screen.queryByText(/tardando más de lo normal/i)).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(PACIENCIA_MS + 10); });

      const aviso = screen.getByText(/tardando más de lo normal/i);
      expect(aviso).toHaveTextContent(/se corta sola a los 30 s/);
      expect(aviso).toHaveTextContent(/vas a poder reintentar/);
      // The original label is NOT lost: the explanation is added, not replaced.
      expect(screen.getByText('Leyendo la actividad de la flota…')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('NEGATIVE CONTROL — without reaching the patience threshold, the banner promises nothing', () => {
    vi.useFakeTimers();
    try {
      render(<LoadingState />);
      act(() => { vi.advanceTimersByTime(PACIENCIA_MS - 100); });
      expect(screen.queryByText(/tardando más de lo normal/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('while the retry is in flight it says so, so the button does not look dead', async () => {
    actividadColgada();
    pintarLive(120);

    const aviso = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(aviso).not.toHaveTextContent(/Hay una lectura en curso/);

    // The button is pressed. Another reading starts that also will not come back: that is what
    // must be said.
    fireEvent.click(screen.getByRole('button', { name: /reintentar/i }));

    await waitFor(() => { expect(aviso).toHaveTextContent(/Hay una lectura en curso/); });
    expect(aviso).toHaveTextContent(/se corta a los 30 s/);
    // And the button stays pressable: disabling it would leave it inert almost always, because
    // with this view's auto-refresh there is almost always a reading in flight.
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeEnabled();
  });

  it('a healthy reading does not see either the timeout or the warning: it keeps painting the fleet', async () => {
    // NEGATIVE CONTROL of the cut: with the server responding, the page reaches its normal state.
    pintarLive(4000);
    expect(await screen.findByRole('heading', { level: 1, name: 'La flota ahora' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
