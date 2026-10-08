import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { renderWithApi } from '../../test/render';
import { AgentContextPanel, type ContextSection } from './AgentContextPanel';

const TAB_NAME: Record<ContextSection, RegExp> = {
  perfil: /^Perfil/u, ficheros: /^Ficheros/u, directiva: /^Directiva/u, historial: /^Historial/u, git: /^Git/u,
};

/** Renders the canonical context page of Steven/kant on one of its sections. */
export async function abrirContexto(section: ContextSection = 'perfil', alias = 'kant') {
  const user = userEvent.setup();
  const view = renderWithApi(<AgentContextPanel tenantId="Steven" alias={alias} />);
  await selectSection(user, section);
  return { user, cajon: view.container, ...view };
}

/**
 * Moves to a section. The panel remounts once when the access snapshot resolves and names the
 * human identity, so a click that lands before that is retried until the tab is selected.
 */
export async function selectSection(user: ReturnType<typeof userEvent.setup>, section: ContextSection) {
  await waitFor(async () => {
    const tab = await screen.findByRole('tab', { name: TAB_NAME[section] });
    if (tab.getAttribute('aria-selected') !== 'true') await user.click(tab);
    expect(screen.getByRole('tab', { name: TAB_NAME[section] })).toHaveAttribute('aria-selected', 'true');
  });
}
