import { ArrowUp, CircleOff, LoaderCircle, LockKeyhole, Paperclip } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent, type RefObject, type SyntheticEvent } from 'react';
import type { JobLane } from '../../api/types';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES, validateAttachmentSelection } from './chat-attachments';
import { ChatSelectedMedia } from './chat-selected-media';
import { ChatVoiceRecorder, ICON_BUTTON } from './chat-voice-recorder';

interface ChatAttachmentsComposerProps {
  agentId: string;
  agentAlias: string;
  canPublish: boolean;
  route: { allowed: boolean; reason: string; sourceRoomIds: string[] };
  roomChoiceRequired: boolean;
  roomId: string;
  roomUnavailable: boolean;
  lane: JobLane;
  text: string;
  files: File[];
  sending: boolean;
  confirming: boolean;
  notice?: { tone: 'success' | 'error' | 'parcial'; text: string };
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onTextChange: (text: string) => void;
  onRoomChange: (roomId: string) => void;
  onFilesChange: (files: File[]) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export function ChatAttachmentsComposer({
  agentId, agentAlias, canPublish, route, roomChoiceRequired, roomId, roomUnavailable,
  lane, text, files, sending, confirming, notice, onSubmit, onTextChange, onRoomChange, onFilesChange, inputRef,
}: ChatAttachmentsComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend = canPublish && route.allowed && Boolean(roomId) && !roomUnavailable;
  const editingBlocked = sending && !confirming;

  useLayoutEffect(() => {
    const box = textarea.current;
    if (!box) return;
    box.style.height = 'auto';
    if (box.scrollHeight) box.style.height = `${String(box.scrollHeight)}px`;
  }, [text]);

  function recordingChanged(active: boolean) {
    // Completion clears the guard before the recorder emits its file in the same callback.
    recordingRef.current = active;
    setRecording(active);
  }

  function canAppendFiles(): boolean {
    return canSend && !editingBlocked && !recordingRef.current;
  }

  function canSubmit(): boolean {
    return canSend && !sending && !recordingRef.current && (Boolean(text.trim()) || files.length > 0);
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit()) onSubmit(event);
  }

  function appendFiles(selected: readonly File[]) {
    if (!selected.length || !canAppendFiles()) return;
    try {
      const next = [...files, ...selected];
      validateAttachmentSelection(next);
      onFilesChange(next);
      setAttachmentError(undefined);
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : 'No se pudieron adjuntar esos archivos.');
    }
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    appendFiles(selected);
  }

  function clipboardFiles(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
    const fromFiles = Array.from(event.clipboardData.files);
    if (fromFiles.length) return fromFiles;
    return Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const selected = clipboardFiles(event);
    if (!selected.length) return;
    event.preventDefault();
    appendFiles(selected);
  }

  function carriesFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const allowed = canAppendFiles();
    event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    setDraggingFiles(allowed);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    setDraggingFiles(false);
    if (!carriesFiles(event)) return;
    event.preventDefault();
    appendFiles(Array.from(event.dataTransfer.files));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit()) event.currentTarget.form?.requestSubmit();
  }

  const sendLabel = sending ? confirming || notice?.tone === 'success' ? 'Confirmando…' : 'Enviando…' : 'Enviar';
  const keepFocus = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button === 0 && document.activeElement === textarea.current) event.preventDefault();
  };
  const blocked = !canPublish ? 'Requiere el permiso message.publish.' : !route.allowed ? route.reason : undefined;
  return (
    <form data-chat-composer data-dragging-files={draggingFiles || undefined} onSubmit={handleSubmit} onDragOver={handleDragOver}
      onDragLeave={() => { setDraggingFiles(false); }} onDrop={handleDrop}
      className="group/composer mx-auto grid w-full max-w-3xl gap-2 px-3 pt-1 pb-3 min-[761px]:px-4 min-[761px]:pb-4">
      <label className="sr-only" htmlFor={`messenger-input-${agentId}`}>Mensaje para {agentAlias}</label>
      {roomChoiceRequired ? (
        <label className="flex items-center gap-2 px-1 text-xs text-muted">Room de origen
          <select value={roomId} disabled={sending} onChange={(event) => { onRoomChange(event.target.value); }}
            className="m-0 h-7 w-auto min-w-36 rounded-md border border-line bg-surface py-0 pr-7 pl-2 text-xs text-fg">
            <option value="" disabled>Elegí la sala de origen</option>
            {roomUnavailable ? <option value={roomId} disabled>{roomId} · no disponible</option> : null}
            {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
          </select>
        </label>
      ) : null}
      {roomUnavailable ? <p className="m-0 px-1 text-xs text-danger-ink" role="alert">La sala elegida ya no está disponible. Elegí otra sala antes de enviar; el borrador se conserva.</p>
        : route.allowed && !roomId ? <p className="m-0 px-1 text-xs text-muted" role="note">Elegí una sala de origen antes de enviar.</p> : null}
      {blocked ? (
        <p className="m-0 flex items-center gap-1.5 px-1 text-xs text-danger-ink">
          {canPublish ? <CircleOff size={13} aria-hidden="true" /> : <LockKeyhole size={13} aria-hidden="true" />}{blocked}
        </p>
      ) : null}
      <div className="rounded-[26px] border border-line bg-surface shadow-card transition-colors focus-within:border-line-strong group-data-[dragging-files]/composer:border-brand group-data-[dragging-files]/composer:ring-2 group-data-[dragging-files]/composer:ring-brand/30">
        {files.length ? (
          <ul aria-label="Archivos adjuntos" className="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0">
            {files.map((file, index) => <ChatSelectedMedia key={`${file.name}:${String(file.size)}:${String(file.lastModified)}:${String(index)}`}
              file={file} disabled={editingBlocked || recording}
              onRemove={() => { onFilesChange(files.filter((_, currentIndex) => currentIndex !== index)); setAttachmentError(undefined); }} />)}
          </ul>
        ) : null}
        <textarea ref={(node) => { textarea.current = node; if (inputRef) inputRef.current = node; }} id={`messenger-input-${agentId}`} value={text} onChange={(event) => { onTextChange(event.target.value); }}
          onKeyDown={handleKeyDown} onPaste={handlePaste} rows={1} maxLength={8_000}
          placeholder={canSend ? `Escribile a ${agentAlias}…` : 'No podés escribir en esta conversación'} disabled={!canSend}
          className="block max-h-[40dvh] min-h-12 w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 text-fg shadow-none outline-none placeholder:text-muted focus:shadow-none disabled:cursor-not-allowed max-[760px]:text-base" />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileInput} className="hidden" type="file" multiple tabIndex={-1}
            aria-hidden="true" onChange={handleFiles} disabled={!canSend || editingBlocked || recording} />
          <button type="button" aria-label="Adjuntar archivos" title="Adjuntar archivos" onPointerDown={keepFocus}
            disabled={!canSend || editingBlocked || recording || files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            onClick={() => { fileInput.current?.click(); }} className={ICON_BUTTON}>
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <ChatVoiceRecorder disabled={!canSend || editingBlocked || files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            availableBytes={MAX_ATTACHMENTS_TOTAL_BYTES - files.reduce((total, file) => total + file.size, 0)}
            onFile={(file) => { appendFiles([file]); }} onRecordingChange={recordingChanged} />
          {lane === 'batch' ? <span className="ml-1 rounded-full bg-muted-bg px-2 py-0.5 text-[11px] text-muted" title="Cambiá el carril en Más">Batch</span> : null}
          <button type="submit" aria-label={sendLabel} title={sendLabel} onPointerDown={keepFocus}
            disabled={!canSend || sending || recording || (!text.trim() && files.length === 0)}
            className="ml-auto grid size-9 cursor-pointer place-items-center rounded-full border-0 bg-fg text-canvas transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:bg-muted-bg disabled:text-muted disabled:opacity-100 touch-manipulation">
            {sending ? <LoaderCircle size={18} aria-hidden="true" className="animate-spin" /> : <ArrowUp size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {attachmentError ? <p className="m-0 px-1 text-xs text-danger-ink" role="alert">{attachmentError}</p> : null}
      {notice && notice.tone !== 'success'
        ? <p className={notice.tone === 'error' ? 'm-0 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger-ink' : 'm-0 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-ink'}
          role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>
        : null}
      <p className="m-0 text-center text-[11px] text-muted max-[760px]:hidden">Enter para enviar · Shift + Enter para una línea nueva</p>
    </form>
  );
}
