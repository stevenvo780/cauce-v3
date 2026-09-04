import type { TelegramBotCommand } from '../types.js';

/** Command menu advertised with `setMyCommands` scoped to private chats. */
export const OPERATOR_BOT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'ayuda', description: 'Lista los comandos de operador' },
  { command: 'estado', description: 'Estado de un alias o de la flota visible' },
  { command: 'trabados', description: 'Aliases que reclamaron y no avanzan' },
  { command: 'colas', description: 'Entregas pendientes, retry y muertas' },
  { command: 'replay', description: 'Reinyecta una entrega muerta o fallida' },
  { command: 'cancelar', description: 'Cancela una entrega en vuelo' },
  { command: 'nudge', description: 'Publica un wake durable a un alias' },
  { command: 'forzar_salida', description: 'Reenvia un reply ambiguo a Telegram' }
];
