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

const FILE_ACTION = 'inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-xs text-fg hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60';

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

  const icon = attachment.mediaKind === 'image' ? <Image size={16} aria-hidden="true" />
    : attachment.mediaKind === 'audio' ? <Music2 size={16} aria-hidden="true" />
      : attachment.mediaKind === 'video' ? <Video size={16} aria-hidden="true" />
        : <FileText size={16} aria-hidden="true" />;
  const playable = kind === 'audio' || kind === 'video';
  const canPreviewImage = kind === 'image';

  return <li className="grid w-full max-w-sm min-w-0 gap-2 rounded-xl border border-line bg-surface p-2.5 text-left">
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted-bg text-muted">{icon}</span>
      <span className="grid min-w-0"><strong className="text-[13px] font-medium [overflow-wrap:anywhere]">{attachment.name}</strong><small className="text-[11px] text-muted">
        {attachment.size === undefined ? 'Tamaño no disponible' : `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(attachment.size / 1_000)} kB`}
      </small></span>
    </div>
    {resource && playable ? kind === 'audio'
      ? <audio className="block w-full" controls preload="none" src={resource.url} aria-label={`Audio: ${attachment.name}`} />
      : <video className="block max-h-72 w-full rounded-lg bg-subtle object-contain" controls playsInline preload="metadata" src={resource.url} aria-label={`Video: ${attachment.name}`} /> : null}
    {resource && canPreviewImage ? <button type="button" className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-lg border-0 bg-transparent p-0"
      aria-label={`Ampliar imagen: ${attachment.name}`} onClick={openImage}>
      <img className="block max-h-48 max-w-[min(100%,16rem)] object-contain" src={resource.url} alt={`Vista previa: ${attachment.name}`} loading="lazy" />
    </button> : null}
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {((!resource && attachment.mediaKind !== 'document') || canPreviewImage)
        ? <button type="button" className={FILE_ACTION} disabled={!messageId || loading}
          onClick={() => { void activatePreview(); }}>
          {loading ? <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> : null}
          {canPreviewImage ? 'Vista previa' : attachment.mediaKind === 'image' ? 'Vista previa' : 'Cargar reproductor'}
        </button> : null}
      <button type="button" className={FILE_ACTION} disabled={!messageId || loading}
        onClick={() => { void download(); }}>
        {loading ? <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> : <Download size={14} aria-hidden="true" />}
        Descargar
      </button>
      {error ? <button type="button" className={FILE_ACTION} disabled={!messageId || loading}
        onClick={() => { void (attachment.mediaKind === 'image' ? activatePreview() : download()); }}>
        <RotateCw size={14} aria-hidden="true" /> Reintentar
      </button> : null}
      {loading ? <span className="text-[11px] text-muted" role="status">Cargando archivo…</span> : null}
      {error ? <span className="text-[11px] text-danger-ink" role="status">No se pudo cargar el archivo.</span> : null}
    </div>
    {expanded && resource && canPreviewImage ? <div className="fixed inset-0 z-[1000] grid place-items-center bg-scrim p-4" onClick={closeImage}>
      <div className="relative grid max-h-full w-[min(100%,70rem)] place-items-center outline-none" role="dialog" aria-modal="true" aria-label={`Vista previa: ${attachment.name}`}
        onClick={(event) => { event.stopPropagation(); }} onKeyDown={onDialogKeyDown} tabIndex={-1}>
        <button type="button" ref={closeButton} aria-label="Cerrar vista previa" onClick={closeImage}
          className="absolute top-2 right-2 z-10 grid size-10 cursor-pointer place-items-center rounded-full border border-line bg-surface text-fg shadow-pop"><X size={18} aria-hidden="true" /></button>
        <img className="block max-h-[calc(100dvh-2rem)] max-w-full rounded-lg object-contain" src={resource.url} alt={attachment.name} />
      </div>
    </div> : null}
  </li>;
}
