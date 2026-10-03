import type { MessageAuthor, MessageView } from '../../api/types';

/** Only the server projection establishes human authorship; message text and origin do not. */
export function humanAuthor(message: MessageView): MessageAuthor | undefined {
  const author = message.author;
  if (author?.kind !== 'human' || !/^human:[a-f0-9]{64}$/u.test(author.subject_id)
      || (author.display_name !== null && (typeof author.display_name !== 'string'
        || author.display_name.trim().length === 0 || author.display_name.length > 240))) return undefined;
  return author;
}
