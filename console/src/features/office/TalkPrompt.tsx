import type { Ref } from 'react';
import { cn } from '../../cn';

/** «Hablar con …» floating over the agent the operator stands next to; the canvas loop positions it. */
export function TalkPrompt({ buttonRef, name, coarse, onTalk }: {
  buttonRef: Ref<HTMLButtonElement>;
  name: string | null;
  coarse: boolean;
  onTalk: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onTalk}
      tabIndex={name ? 0 : -1}
      aria-hidden={name ? undefined : true}
      className={cn(
        'absolute top-0 left-0 z-10 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-1.5 pl-2.5 text-xs font-medium whitespace-nowrap text-fg shadow-pop transition-opacity duration-150 hover:bg-subtle pointer-coarse:min-h-11 pointer-coarse:px-4 pointer-coarse:text-sm',
        name ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {name ? `Hablar con ${name}` : ''}
      {coarse ? null : <kbd className="rounded border border-line bg-subtle px-1 font-sans text-[10px] text-muted">E</kbd>}
    </button>
  );
}
