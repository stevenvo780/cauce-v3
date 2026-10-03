import { createHash } from 'node:crypto';
import type { PublishOptions } from '@cauce/store';
import type { Principal } from './auth.js';

/** Provenance is separate from the technical alias used by routing and permission checks. */
export function consoleHumanSubject(actor: Principal): string | undefined {
  if (actor.operator_id === undefined) return undefined;
  const identity = actor.operator_profile?.id ?? `${actor.channel}:${actor.operator_id}`;
  const subject = createHash('sha256')
    .update(JSON.stringify(['cauce-v3:human-author:v1', actor.tenant_id, identity]))
    .digest('hex');
  return `human:${subject}`;
}

export function consoleMessageAuthor(actor: Principal): PublishOptions['consoleAuthor'] {
  if (!actor.roles.includes('operator')) return undefined;
  const subject = consoleHumanSubject(actor);
  if (subject === undefined) return undefined;
  const label = actor.operator_profile?.display_name.trim();
  return {
    kind: 'human',
    subject_id: subject,
    display_name: label && label.length <= 240 ? label : null,
  };
}
