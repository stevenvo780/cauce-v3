import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Download, FileText, Image, LoaderCircle, Music2, RotateCw, Video, X } from 'lucide-react';
import { cauceApi, type CauceApi } from '../../api/client';
import { messageMediaKind, safeAttachmentName, type AttachmentSummary, type MessageMediaKind } from './message-attachment-list';

interface MediaResource {
  blob: Blob;
  url: string;
}

export type MediaUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

export interface ReplyMediaSource {
  deliveryId: string;
  attempt: number;
}

function detectedKind(blob: Blob, fallback: MessageMediaKind): MessageMediaKind {
  return blob.type ? messageMediaKind(blob.type) : fallback === 'image' ? 'document' : fallback;
}

function revoke(resource: MediaResource | undefined, urls: MediaUrlApi): void {
  if (resource) urls.revokeObjectURL(resource.url);
}

export function MessageMedia({
  messageId,
  attachment,
  replySource,
  api = cauceApi,
  urls = URL,
}: {
  messageId?: string | null;
  attachment: AttachmentSummary;
  replySource?: ReplyMediaSource;
  api?: CauceApi;
  urls?: MediaUrlApi;
}) {
  const [resource, setResource] = useState<MediaResource>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const liveResource = useRef<MediaResource | undefined>(undefined);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);
  const kind = resource ? detectedKind(resource.blob, attachment.mediaKind) : attachment.mediaKind;

  const clearResource = useCallback(() => {
    controller.current?.abort();
    controller.current = undefined;
    revoke(liveResource.current, urls);
    liveResource.current = undefined;
    setResource(undefined);
    setLoading(false);
    setError(false);
    setExpanded(false);
  }, [urls]);

  useEffect(() => {
    clearResource();
    return clearResource;
  }, [api, attachment.attachmentIndex, clearResource, messageId, replySource?.deliveryId, replySource?.attempt]);

  useEffect(() => {
    if (expanded) {
      dialogWasOpen.current = true;
      closeButton.current?.focus();
    } else if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      returnFocus.current?.focus();
    }
  }, [expanded]);

  const openImage = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpanded(true);
  };

  const closeImage = () => {
    setExpanded(false);
    returnFocus.current?.focus();
  };

  const load = async (): Promise<MediaResource | undefined> => {
    if (resource) return resource;
    if (!messageId || loading) return undefined;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setLoading(true);
    setError(false);
    try {
      const blob = await (replySource
        ? api.getMessageReplyAttachment(messageId, replySource.deliveryId, replySource.attempt, attachment.attachmentIndex, { signal: abort.signal })
        : api.getMessageAttachment(messageId, attachment.attachmentIndex, { signal: abort.signal }));
      if (abort.signal.aborted) return undefined;
      const next = { blob, url: urls.createObjectURL(blob) };
      liveResource.current = next;
      setResource(next);
      return next;
    } catch {
      if (!abort.signal.aborted) setError(true);
      return undefined;
    } finally {
      if (controller.current === abort) {
        controller.current = undefined;
        setLoading(false);
      }
    }
  };

  const download = async () => {
    const loaded = await load();
    if (!loaded || loaded !== liveResource.current) return;
    const link = document.createElement('a');
    const downloadUrl = urls.createObjectURL(loaded.blob);
    link.href = downloadUrl;
    link.download = safeAttachmentName(attachment.name);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => { urls.revokeObjectURL(downloadUrl); }, 0);
  };

  const activatePreview = async () => {
    const loaded = await load();
    if (!loaded || loaded !== liveResource.current) return;
    const actualKind = detectedKind(loaded.blob, attachment.mediaKind);
    if (actualKind === 'image') openImage();
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeImage();
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const icon = attachment.mediaKind === 'image' ? <Image size={18} aria-hidden="true" />
    : attachment.mediaKind === 'audio' ? <Music2 size={18} aria-hidden="true" />
      : attachment.mediaKind === 'video' ? <Video size={18} aria-hidden="true" />
        : <FileText size={18} aria-hidden="true" />;
  const playable = kind === 'audio' || kind === 'video';
  const canPreviewImage = kind === 'image';

  return <li className="chat-message-file">
    <div className="chat-message-file-heading">
      {icon}
      <span className="chat-message-file-label"><strong>{attachment.name}</strong><small>
        {attachment.size === undefined ? 'Tamaño no disponible' : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(attachment.size / 1_000)} kB`}
      </small></span>
    </div>
    {resource && playable ? kind === 'audio'
      ? <audio controls preload="none" src={resource.url} aria-label={`Audio: ${attachment.name}`} />
      : <video controls playsInline preload="metadata" src={resource.url} aria-label={`Video: ${attachment.name}`} /> : null}
    {resource && canPreviewImage ? <button type="button" className="chat-message-image-preview"
      aria-label={`Ampliar imagen: ${attachment.name}`} onClick={openImage}>
      <img src={resource.url} alt={`Vista previa: ${attachment.name}`} loading="lazy" />
    </button> : null}
    <div className="chat-message-file-actions">
      {((!resource && attachment.mediaKind !== 'document') || canPreviewImage)
        ? <button type="button" className="chat-message-file-action" disabled={!messageId || loading}
          onClick={() => { void activatePreview(); }}>
          {loading ? <LoaderCircle size={16} aria-hidden="true" /> : null}
          {canPreviewImage ? 'Vista previa' : attachment.mediaKind === 'image' ? 'Vista previa' : 'Cargar reproductor'}
        </button> : null}
      <button type="button" className="chat-message-file-action" disabled={!messageId || loading}
        onClick={() => { void download(); }}>
        {loading ? <LoaderCircle size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
        Descargar
      </button>
      {error ? <button type="button" className="chat-message-file-action" disabled={!messageId || loading}
        onClick={() => { void (attachment.mediaKind === 'image' ? activatePreview() : download()); }}>
        <RotateCw size={16} aria-hidden="true" /> Reintentar
      </button> : null}
      {loading ? <span role="status">Cargando archivo…</span> : null}
      {error ? <span role="status">No se pudo cargar el archivo.</span> : null}
    </div>
    {expanded && resource && canPreviewImage ? <div className="chat-media-backdrop" onClick={closeImage}>
      <div className="chat-media-dialog" role="dialog" aria-modal="true" aria-label={`Vista previa: ${attachment.name}`}
        onClick={(event) => { event.stopPropagation(); }} onKeyDown={onDialogKeyDown} tabIndex={-1}>
        <button type="button" ref={closeButton} className="chat-media-close" aria-label="Cerrar vista previa"
          onClick={closeImage}><X size={20} aria-hidden="true" /></button>
        <img src={resource.url} alt={attachment.name} />
      </div>
    </div> : null}
  </li>;
}
