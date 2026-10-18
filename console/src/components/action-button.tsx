import { type MouseEvent, type ReactNode } from 'react';
import { useActionRun, type ActionRunOptions } from './action-run';
import { Button } from './kit';

export function ActionStatus({ doneText, errorText }: { doneText?: string; errorText?: string }) {
  if (errorText) return <span role="alert" className="text-xs text-danger-ink">{errorText}</span>;
  if (doneText) return <span role="status" className="text-xs text-ok-ink">{doneText}</span>;
  return null;
}

export function ActionButton({
  label, name, pendingLabel = 'Releyendo…', action, busy = false, disabled = false, size = 'md',
  variant = 'secondary', title, icon, className, type = 'button', announceError = true, done,
}: {
  label: string;
  /** Accessible name. Stays on the idle label so the control remains findable while the visible word changes. */
  name?: string;
  pendingLabel?: string;
  action: (event: MouseEvent<HTMLButtonElement>) => unknown;
  busy?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  title?: string;
  icon?: ReactNode;
  className?: string;
  type?: 'button' | 'submit';
  announceError?: ActionRunOptions['announceError'];
  done?: ActionRunOptions['done'];
}) {
  const feedback = useActionRun(action, { announceError, done });
  const showPending = feedback.phase === 'pending' || busy;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type={type}
        size={size}
        variant={variant}
        className={className}
        title={title ?? name}
        disabled={disabled || showPending}
        aria-label={name ?? label}
        {...(showPending ? { 'aria-busy': true } : {})}
        onClick={(event) => { void feedback.run(event); }}
      >
        {icon ? <span className={showPending ? 'inline-flex animate-spin' : 'inline-flex'}>{icon}</span> : null}
        {showPending ? pendingLabel : label}
      </Button>
      <ActionStatus doneText={feedback.doneText} errorText={feedback.errorText} />
    </span>
  );
}
