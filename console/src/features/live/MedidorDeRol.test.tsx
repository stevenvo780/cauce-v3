import { screen } from '@testing-library/react';
import { renderWithApi } from '../../test/render';
import { MedidorDeRol } from './MedidorDeRol';

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
