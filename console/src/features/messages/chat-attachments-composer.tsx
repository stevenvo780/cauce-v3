import { ChevronDown, CircleOff, LockKeyhole, Paperclip, Send } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type SyntheticEvent } from 'react';
import type { JobLane } from '../../api/types';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES, validateAttachmentSelection } from './chat-attachments';
import { ChatSelectedMedia } from './chat-selected-media';
import { ChatVoiceRecorder } from './chat-voice-recorder';

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
}

export function ChatAttachmentsComposer({
  agentId, agentAlias, canPublish, route, roomChoiceRequired, roomId, roomUnavailable,
  lane, text, files, sending, confirming, notice, onSubmit, onTextChange, onRoomChange, onFilesChange,
}: ChatAttachmentsComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend = canPublish && route.allowed && Boolean(roomId) && !roomUnavailable;
  const editingBlocked = sending && !confirming;

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

  return (
    <form className="messenger-composer" data-dragging-files={draggingFiles || undefined}
      onSubmit={handleSubmit} onDragOver={handleDragOver} onDragLeave={() => { setDraggingFiles(false); }} onDrop={handleDrop}>
      <label className="sr-only" htmlFor={`messenger-input-${agentId}`}>Mensaje para {agentAlias}</label>
      {roomChoiceRequired ? <label className="messenger-room-select">Room de origen
        <span className="room-select-wrap">
          <select value={roomId} disabled={sending} onChange={(event) => { onRoomChange(event.target.value); }}>
            <option value="" disabled>Elegí la sala de origen</option>
            {roomUnavailable ? <option value={roomId} disabled>{roomId} · no disponible</option> : null}
            {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </label> : null}
      {roomUnavailable ? <p className="composer-blocked" role="alert">La sala elegida ya no está disponible. Elegí otra sala antes de enviar; el borrador se conserva.</p>
        : route.allowed && !roomId ? <p className="composer-blocked" role="note">Elegí una sala de origen antes de enviar.</p> : null}
      {lane === 'batch' ? <p className="messenger-room-fixed">Envío en segundo plano · cambiá el carril en Más.</p> : null}
      <div className="composer-input-row">
        <input ref={fileInput} className="composer-file-input" type="file" multiple tabIndex={-1}
          aria-hidden="true" onChange={handleFiles} disabled={!canSend || editingBlocked || recording} />
        <button className="button secondary composer-attach" type="button" aria-label="Adjuntar archivos"
          title="Adjuntar archivos" disabled={!canSend || editingBlocked || recording || files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          onClick={() => { fileInput.current?.click(); }}
          onPointerDown={(event) => {
            if (event.button === 0 && document.activeElement?.matches('.messenger-composer textarea')) event.preventDefault();
          }}><Paperclip size={18} aria-hidden="true" /></button>
        <ChatVoiceRecorder disabled={!canSend || editingBlocked || files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          availableBytes={MAX_ATTACHMENTS_TOTAL_BYTES - files.reduce((total, file) => total + file.size, 0)}
          onFile={(file) => { appendFiles([file]); }} onRecordingChange={recordingChanged} />
        <textarea id={`messenger-input-${agentId}`} value={text} onChange={(event) => { onTextChange(event.target.value); }}
          onKeyDown={handleKeyDown} onPaste={handlePaste} rows={1} maxLength={8_000} placeholder="Escribí un mensaje…"
          disabled={!canSend || editingBlocked} />
        <div className="composer-footer">
          <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
          <button className="button primary" type="submit" disabled={!canSend || sending || recording || (!text.trim() && files.length === 0)}
            onPointerDown={(event) => {
              if (event.button === 0 && document.activeElement?.matches('.messenger-composer textarea')) event.preventDefault();
            }}>
            <Send size={15} aria-hidden="true" /><span>{sending ? confirming || notice?.tone === 'success' ? 'Confirmando…' : 'Enviando…' : 'Enviar'}</span>
          </button>
        </div>
      </div>
      {files.length ? <ul className="composer-attachments" aria-label="Archivos adjuntos">
        {files.map((file, index) => <ChatSelectedMedia key={`${file.name}:${String(file.size)}:${String(file.lastModified)}:${String(index)}`}
          file={file} disabled={editingBlocked || recording}
          onRemove={() => { onFilesChange(files.filter((_, currentIndex) => currentIndex !== index)); setAttachmentError(undefined); }} />)}
      </ul> : null}
      {attachmentError ? <p className="composer-blocked" role="alert">{attachmentError}</p> : null}
      {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere el permiso message.publish.</p> : null}
      {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
      {notice && notice.tone !== 'success'
        ? <p className={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>
        : null}
    </form>
  );
}
