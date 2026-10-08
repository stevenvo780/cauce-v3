import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

export type AgentMenuAction = 'Editar registro' | 'Operar agente' | 'Retirar agente' | 'Perfil y contexto';

/** Opens an agent's kebab menu and picks one of its actions. */
export async function agentAction(user: UserEvent, ref: string, action: AgentMenuAction) {
  await user.click(await screen.findByRole('button', { name: `Acciones de ${ref}` }));
  await user.click(await screen.findByRole('menuitem', { name: action === 'Perfil y contexto' ? `${action} de ${ref}` : action }));
}

export async function openAgentMenu(user: UserEvent, ref: string) {
  await user.click(await screen.findByRole('button', { name: `Acciones de ${ref}` }));
}

export async function openPrepareAgent(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Más formas de añadir' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Preparar agente' }));
}
