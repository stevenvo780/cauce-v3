import type { ConfigAction } from '../../api/types';
import { canUseConfigForm } from './config-form-access';
import { configFormDefinition } from './config-form-model';
import type { ConfigWrites } from './use-config-writes';

const TEAM_NOT_ALLOWED = 'El servidor no acredita esta acción para tu cuenta sobre este equipo.';

/** Why `action` on a team cannot run right now (read-only account or server capabilities), or undefined when it can. */
export function teamBlock(ctx: ConfigWrites, action: ConfigAction, row?: Record<string, unknown>): string | undefined {
  if (ctx.soloLectura) return ctx.motivoDeSoloLectura;
  const definition = configFormDefinition('rooms');
  return definition && ctx.config.data && canUseConfigForm(ctx.config.data, definition, action, row) ? undefined : TEAM_NOT_ALLOWED;
}
