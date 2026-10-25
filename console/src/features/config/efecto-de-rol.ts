/** What a seeded role policy is for. Unknown ids stay visible and do not invent permissions. */

export interface EfectoDeRol {
  nombre: string;
  efecto: string;
}

/**
 * Sentences follow the seeded rows: operator administers; agent and agent_notify converse without
 * control; adapter does not notify; context_broker is route-only. The columns remain the authority.
 */
const EFECTOS: Record<string, EfectoDeRol> = {
  operator: {
    nombre: 'Operador',
    efecto: 'Para quien administra la flota, persona o agente. Puede enviar, leer, cambiar la configuración y avisar.',
  },
  agent: {
    nombre: 'Agente',
    efecto: 'Para un agente que conversa. Puede enviar, leer y avisar. No administra.',
  },
  adapter: {
    nombre: 'Adaptador',
    efecto: 'Para el programa que entrega los mensajes, no para una persona. Puede enviar y leer. No avisa ni administra.',
  },
  agent_notify: {
    nombre: 'Agente que avisa',
    efecto: 'Para un agente que debe poder escribirle a una persona sin que se lo pidan. No administra. No es una cuenta de persona.',
  },
  context_broker: {
    nombre: 'Bróker de contexto',
    efecto: 'Para el agente de sistema que publica el contexto de la empresa. Solo envía. No es una persona.',
  },
  observer: {
    nombre: 'Observador',
    efecto: 'Para quien mira sin hablar. No envía ni administra.',
  },
};

export function efectoDeRol(rol: string): EfectoDeRol {
  if (Object.hasOwn(EFECTOS, rol)) return EFECTOS[rol];
  return {
    nombre: 'Rol de la flota',
    efecto: 'No hay ficha para este identificador. Lo que puede hacer son las columnas de esta fila. Se asigna en la membresía, en «Espacios y salas».',
  };
}

export function nombreDeRol(role: string): string {
  return Object.hasOwn(EFECTOS, role) ? EFECTOS[role].nombre : `Rol personalizado: ${role}`;
}

export const GUIA_DE_ROLES =
  'El rol se elige en la membresía del agente, en «Espacios y salas». Operador administra. Agente conversa. '
  + 'Adaptador entrega mensajes. «Agente que avisa» escribe a una persona sin que se lo pidan. '
  + '«Bróker de contexto» solo publica el contexto de la empresa y no es una persona.';
