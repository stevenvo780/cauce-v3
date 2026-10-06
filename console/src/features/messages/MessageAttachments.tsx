import { useEffect, useState } from 'react';
import type { CauceApi } from '../../api/client';
import { useApi } from '../../api/context';
import { messageAttachmentList } from './message-attachment-list';
import { MessageMedia, type MediaUrlApi, type ReplyMediaSource } from './message-media';

export function MessageAttachments({
  messageId,
  files,
  replySource,
  api: apiOverride,
  urls = URL,
}: {
  messageId?: string | null;
  files?: unknown;
  replySource?: ReplyMediaSource;
  api?: CauceApi;
  urls?: MediaUrlApi;
}) {
  const contextApi = useApi();
  const api = apiOverride ?? contextApi;
  const [authGeneration, setAuthGeneration] = useState(0);
  useEffect(() => api.onAuthGenerationChange(() => { setAuthGeneration((value) => value + 1); }), [api]);

  const summaries = messageAttachmentList(files);
  if (summaries.length === 0) return null;
  return <ul className="m-0 grid min-w-0 list-none gap-1.5 p-0" aria-label="Archivos del mensaje">
    {summaries.map((attachment) => <MessageMedia
      key={`${messageId ?? ''}-${String(attachment.attachmentIndex)}-${String(authGeneration)}`}
      messageId={messageId} attachment={attachment} replySource={replySource} api={api} urls={urls}
    />)}
  </ul>;
}
