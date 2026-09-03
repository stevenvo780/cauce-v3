import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CauceApi } from '../../../api/client';
import { ApiProvider } from '../../../api/context';
import { server } from '../../../mocks/server';
import { CapasPendientes } from './CapasPendientes';

/**
 * The footer must never paint a declared `$HOME`/container as the location: `docs/directiva-ficheros-del-agente.md`
 * documents those columns as lying, and `/home/dev` fits almost every alias.
 */

const RUTA = '*/v3/console/tenants/Miguel/agents/iza/documents';

function mapa(cuerpo: Record<string, unknown>) {
  let llamadas = 0;
  server.use(http.get(RUTA, () => {
    llamadas += 1;
    return HttpResponse.json({ tenant_id: 'Miguel', alias: 'iza', items: [], ...cuerpo });
  }));
  return { llamadas: () => llamadas };
}

async function pintar(ubicacion: { contenedor?: string; home?: string }) {
  const user = userEvent.setup();
  render(
    <ApiProvider api={new CauceApi('http://localhost')}>
      <CapasPendientes ubicacion={{ tenantId: 'Miguel', alias: 'iza', ...ubicacion }} alias="iza" />
    </ApiProvider>,
  );
  const resumen = screen.getByText(/lo que todavía no se puede desde aquí/i);
  const pliegue = resumen.closest('details') as HTMLElement;
  return { user, resumen, pliegue, donde: () => within(pliegue).getByText(/mientras tanto la configuración/i) };
}

describe('CapasPendientes', () => {
  it('asks for the documents map only once the fold is opened', async () => {
    const red = mapa({ facts_source: 'measured', harness: 'claude', home: '/home/claw' });
    const { user, resumen, pliegue } = await pintar({ home: '/home/dev' });
    expect(pliegue).not.toHaveAttribute('open');
    expect(red.llamadas()).toBe(0);

    await user.click(resumen);
    await waitFor(() => { expect(red.llamadas()).toBe(1); });
  });

  it('shows the bare value when the measurement confirms what was declared', async () => {
    mapa({ facts_source: 'measured', harness: 'claude', home: '/home/dev' });
    const { user, resumen, donde } = await pintar({ home: '/home/dev' });
    await user.click(resumen);

    await waitFor(() => { expect(within(donde()).getByText('/home/dev')).toBeInTheDocument(); });
    expect(donde()).not.toHaveTextContent(/declarado/);
    expect(within(donde()).getByText('claude')).toBeInTheDocument();
  });

  it('shows both, with those words, when declared and measured differ', async () => {
    mapa({ facts_source: 'measured', harness: 'claude', home: '/home/claw' });
    const { user, resumen, donde } = await pintar({ home: '/home/dev', contenedor: 'ws-humanizar' });
    await user.click(resumen);

    await waitFor(() => { expect(within(donde()).getByText('/home/claw')).toBeInTheDocument(); });
    expect(donde()).toHaveTextContent(/\$HOME: declarado \/home\/dev · medido \/home\/claw/);
    expect(donde()).toHaveTextContent(/Contenedor: declarado ws-humanizar · medido desconocido/);
  });

  it('says unknown, and never promotes the declared value, when nothing was measured', async () => {
    mapa({ facts_source: 'registry', harness: 'claude', home: '/home/dev' });
    const { user, resumen, donde } = await pintar({});
    await user.click(resumen);

    await waitFor(() => { expect(donde()).not.toHaveTextContent(/midiendo/); });
    expect(donde()).toHaveTextContent(/\$HOME: desconocido/);
    expect(donde()).toHaveTextContent(/Contenedor: desconocido/);
    expect(donde()).not.toHaveTextContent('/home/dev');
  });
});
