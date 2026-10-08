import { screen, within } from '@testing-library/react';
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
  await user.click(await screen.findByRole('button', { name: 'Añadir agente' }));
  await user.click(await screen.findByRole('radio', { name: /Solo preparar, sin desplegar/ }));
}

/** Opens the agent's sheet by clicking its tile. */
export async function openAgentSheet(user: UserEvent, ref: string) {
  await user.click(await screen.findByRole('button', { name: `Abrir agente ${ref}` }));
  return within(await screen.findByRole('dialog'));
}

/** Advances the «Añadir agente» wizard by `times` steps. */
export async function nextStep(user: UserEvent, times = 1) {
  for (let index = 0; index < times; index += 1) await user.click(screen.getByRole('button', { name: 'Siguiente' }));
}
