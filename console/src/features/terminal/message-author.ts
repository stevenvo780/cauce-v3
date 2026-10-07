import { ClientDelegationLabelSchema, ClientProvenanceWireSchema } from '@cauce/protocol/client-provenance';
import type { MessageAuthor, MessageClientOrigin, MessageView } from '../../api/types';

/** Only the server projection establishes human authorship; message text and origin do not. */
export function humanAuthor(message: MessageView): MessageAuthor | undefined {
  const author = message.author;
  if (author?.kind !== 'human' || !/^human:[a-f0-9]{64}$/u.test(author.subject_id)
      || (author.display_name !== null && (typeof author.display_name !== 'string'
        || author.display_name.trim().length === 0 || author.display_name.length > 240))) return undefined;
  return author;
}

function validatedClientOrigin(value: unknown): MessageClientOrigin | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const origin = value as Record<string, unknown>;
  if (Object.keys(origin).length !== 2 || !Object.hasOwn(origin, 'client')
      || !Object.hasOwn(origin, 'delegation_label')) return null;
  const client = ClientProvenanceWireSchema.safeParse(origin.client);
  const label = ClientDelegationLabelSchema.nullable().safeParse(origin.delegation_label);
  if (!client.success || !label.success || (client.data.kind === 'unknown' && label.data !== null)) return null;
  return { client: client.data, delegation_label: label.data };
}

interface MessageAuthorPresentation {
  readonly label: string;
  readonly title: string;
  readonly clientDeclarationNotice?: string;
}

export function messageAuthorPresentation(message: MessageView): MessageAuthorPresentation {
  const author = humanAuthor(message);
  if (!author) {
    return {
      label: message.actor_alias ?? 'Emisor sin dato',
      title: 'Identidad técnica; autor humano no registrado',
    };
  }

  const clientOrigin = validatedClientOrigin(message.client_origin);
  const technicalIdentity = `identidad técnica: ${message.actor_alias ?? 'sin dato'}`;

  if (!clientOrigin) {
    return {
      label: author.display_name ?? 'Persona autenticada',
      title: `Persona autenticada · ${technicalIdentity}`,
    };
  }

  const accountName = author.display_name ?? 'persona autenticada';
  if (clientOrigin.delegation_label !== null) {
    return {
      label: clientOrigin.delegation_label,
      title: `Cliente declarado por ${accountName} · instancia no verificada · ${technicalIdentity}`,
      clientDeclarationNotice: `Cliente declarado por ${accountName}; instancia no verificada`,
    };
  }

  if (clientOrigin.client.kind === 'oauth_client') {
    return {
      label: 'Cliente MCP',
      title: `Cliente MCP · cuenta: ${accountName} · instancia no verificada · ${technicalIdentity}`,
    };
  }

  return {
    label: 'Cliente MCP no identificado',
    title: `Cliente MCP no identificado · cuenta: ${accountName} · instancia no verificada · ${technicalIdentity}`,
  };
}
