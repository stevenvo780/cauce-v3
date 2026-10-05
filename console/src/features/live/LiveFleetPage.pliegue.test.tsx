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
  it('mantiene el mapa visible sin disclosure antes de la tabla', async () => {
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const mapa = document.querySelector('section.live-mapa');
    expect(mapa).not.toBeNull();
    expect(mapa?.querySelector('summary')).toBeNull();
    expect(mapa?.textContent).toContain('Actividad');
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

    expect(document.querySelector('section.live-mapa h2')?.textContent).toMatch(/actividad/i);
    expect(document.querySelector('details.live-leyenda h2')?.textContent).toMatch(/leyenda y referencia/i);
  });
});
