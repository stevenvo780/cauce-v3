import { render } from '@testing-library/react';
import { AgentAvatar } from './AgentAvatar';

it('conserva los grafemas completos y la identidad visual al cambiar de estado', () => {
  const { container, rerender } = render(<AgentAvatar alias="👩🏽‍💻Ágora" tenantId="Equipo" state="unknown" />);
  const avatar = container.querySelector('.chat-avatar');
  expect(avatar).toHaveTextContent('👩🏽‍💻Á');
  expect(avatar).toHaveAttribute('aria-hidden', 'true');
  expect(avatar).not.toHaveAttribute('data-working');
  const color = avatar?.getAttribute('data-color');
  expect(color).toMatch(/^[0-4]$/);
  rerender(<AgentAvatar alias="👩🏽‍💻Ágora" tenantId="Equipo" state="online" working />);
  expect(avatar).toHaveAttribute('data-color', color);
  expect(avatar).toHaveAttribute('data-working', 'true');
  rerender(<AgentAvatar alias="👩🏽‍💻Ágora" tenantId="Equipo" state="expired" working={false} />);
  expect(avatar).toHaveAttribute('data-working', 'false');
  expect(avatar).toHaveAttribute('data-state', 'expired');
});
