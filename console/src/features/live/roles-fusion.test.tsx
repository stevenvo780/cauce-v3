import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { renderWithApi } from '../../test/render';
import { MedidorDeRol } from './MedidorDeRol';
import { RolesFold } from './RolesFold';

function RolesFoldConfigurado({ onAbrirPerfil }: { onAbrirPerfil: (key: string) => void }) {
  const api = useApi();
  return <RolesFold configuracion={useResource('cfg', () => api.getConfiguration())} onAbrirPerfil={onAbrirPerfil} />;
}

/**
 * The four capabilities the "Agent roles" screen contributed that no other site had.
 */

it('el medidor del campo enseña las DOS unidades y bloquea el rol que dejaría SORDO al alias', () => {
  const sordo = 'a'.repeat(1100) + '\u{1F389}'.repeat(100);
  renderWithApi(<MedidorDeRol texto={sordo} />);

  expect(screen.getByText(/1200 puntos de código · 1300 unidades UTF-16 \/ 1200/)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/SORDO/);
});

it('el medidor avisa del tramo que de verdad viaja cuando el texto pasa de 1200', () => {
  renderWithApi(<MedidorDeRol texto={'a'.repeat(1300)} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/self_role de cada entrega recortan ahí/);
});

it('el medidor no molesta al rol que cabe', () => {
  renderWithApi(<MedidorDeRol texto="Orquestador de la flota." />);
  expect(screen.getByText(/24 puntos de código · 24 unidades UTF-16 \/ 1200/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('el catálogo cuenta los roles, nombra a sus portadores y delata a los bots sin rol', async () => {
  const abiertos: string[] = [];
  const user = userEvent.setup();
  renderWithApi(<RolesFoldConfigurado onAbrirPerfil={(key) => { abiertos.push(key); }} />);

  await waitFor(() => {
    expect(screen.getByText(/1 texto de rol entre 3 bots registrados/)).toBeInTheDocument();
  });
  expect(screen.getByText(/Sin rol declarado \(2\)/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Miguel/iza' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pablo/midas' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Steven/kant' }));
  expect(abiertos).toEqual(['Steven/kant']);
});
