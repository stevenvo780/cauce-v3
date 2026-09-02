import { screen } from '@testing-library/react';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * What is above the fleet table, and whether the two sections that became `details` still exist for
 * anyone reading the page by its headings instead of by its pixels.
 */
beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

describe('lo que hay por encima de la tabla de flota', () => {
  it('el mapa llega PLEGADO: abierto son 889px de dibujo entre la cinta y la tabla', async () => {
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const mapa = document.querySelector('details.live-mapa');
    expect(mapa).not.toBeNull();
    expect(mapa).not.toHaveAttribute('open');
  });

  it('la leyenda también, y su contenido sigue en el documento para quien lo busque', async () => {
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const leyenda = document.querySelector('details.live-leyenda');
    expect(leyenda).not.toBeNull();
    expect(leyenda).not.toHaveAttribute('open');
    expect(leyenda?.textContent).toContain('Roles declarados');
  });
});

describe('plegar una sección no la borra del esquema de encabezados', () => {
  it('el mapa y la leyenda titulan con encabezados de verdad, no con texto que lo aparenta', async () => {
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    expect(screen.getByRole('heading', { name: /quién le habla a quién, ahora/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /leyenda y referencia/i })).toBeInTheDocument();
  });
});
