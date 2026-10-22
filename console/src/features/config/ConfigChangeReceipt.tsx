import { Notice, PREVIEW } from '../../components/kit';
import type { ConfigMutationNotice } from './use-config-mutation';

export function ConfigChangeReceipt({ preview, notice, label }: {
  preview?: string;
  notice?: ConfigMutationNotice;
  label: string;
}) {
  const technicalNotice = preview && notice?.tone === 'success' && notice.text.includes('Dry-run aceptado:')
    ? notice.text : undefined;
  const summary = technicalNotice
    ? `${technicalNotice.split('Dry-run aceptado:')[0]}Vista previa lista. Revisa los cambios antes de aplicar.`
    : notice?.text;

  return <>
    {notice ? <Notice tone={notice.tone === 'error' ? 'danger' : notice.tone === 'parcial' ? 'warn' : 'info'}
      role={notice.tone === 'error' ? 'alert' : 'status'}>{summary}</Notice> : null}
    {preview ? <details className="min-w-0 text-[13px]">
      <summary className="cursor-pointer font-medium text-muted">Detalles técnicos</summary>
      <div className="mt-2 grid min-w-0 gap-2">
        {technicalNotice ? <p className="m-0 wrap-anywhere text-xs text-muted">
          {technicalNotice.slice(technicalNotice.indexOf('Dry-run aceptado:'))}
        </p> : null}
        <pre className={`${PREVIEW} min-w-0 wrap-anywhere`} aria-label={label}>{preview}</pre>
      </div>
    </details> : null}
  </>;
}
