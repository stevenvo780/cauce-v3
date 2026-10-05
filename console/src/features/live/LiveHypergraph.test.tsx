import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockActivity, topology } from '../../mocks/data';
import { buildLiveViews } from './agent-state';
import { LiveHypergraph } from './LiveHypergraph';

describe('LiveHypergraph viewport', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('distingue relaciones ACL de conexiones activas al mostrar la capa Permisos', () => {
    render(<LiveHypergraph topology={topology} views={[]} edges={[]} layer="permisos" />);

    expect(document.querySelector('.lhg-summary')).toHaveTextContent(/relaciones ACL/u);
    expect(screen.queryByText(/conexiones activas/u)).not.toBeInTheDocument();
  });

  it('encuadra tras medir el canvas y conserva el zoom manual al refrescar actividad', async () => {
    const originalBounds: (this: HTMLElement) => DOMRect = Reflect.get(HTMLElement.prototype, 'getBoundingClientRect');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function bounds(this: HTMLElement) {
      if (this.classList.contains('lhg-viewport') || this.classList.contains('react-flow')) {
        return new DOMRect(0, 0, 390, 320);
      }
      if (this.classList.contains('react-flow__node')) {
        return new DOMRect(0, 0, Number.parseFloat(this.style.width), Number.parseFloat(this.style.height));
      }
      return Reflect.apply(originalBounds, this, []);
    });
    const activity = mockActivity();
    const projected = buildLiveViews(activity, {}, Date.now());
    const user = userEvent.setup();
    const rendered = render(
      <div style={{ width: 390, height: 320 }}>
        <LiveHypergraph topology={topology} views={projected.views} edges={projected.edges} />
      </div>,
    );
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) throw new Error('ReactFlow viewport should be mounted');

    await waitFor(() => { expect(viewport.style.transform).toContain('scale(1)'); });
    expect(screen.getByText('Arrastra o pellizca para explorar')).toBeInTheDocument();
    expect(viewport.style.transform).toBe('translate(0px,0px) scale(1)');
    const cards = [...document.querySelectorAll<HTMLElement>('.react-flow__node-fleet')];
    expect(cards.length).toBeGreaterThan(10);
    for (const card of cards) expect(card.style.width).toBe('128px');
    const fittedTransform = viewport.style.transform;
    await user.click(screen.getByRole('button', { name: 'Acercar mapa' }));
    await waitFor(() => { expect(viewport.style.transform).not.toBe(fittedTransform); });
    const operatorTransform = viewport.style.transform;

    rendered.rerender(
      <div style={{ width: 390, height: 320 }}>
        <LiveHypergraph topology={topology} views={projected.views} edges={[{ from: 'Steven/kant', to: 'Steven/zeus' }]} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Mapa interactivo de salas, agentes y conexiones')).toBeInTheDocument();
      expect(viewport.style.transform).toBe(operatorTransform);
    });
  });
});
