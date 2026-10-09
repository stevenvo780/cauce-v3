import type { Ref } from 'react';
import { cn } from '../../cn';
import { HUD_BUTTON, HUD_TEXT } from './hud-style';

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
        HUD_BUTTON, HUD_TEXT, 'absolute top-0 left-0 z-20 h-8 px-2.5 whitespace-nowrap transition-opacity duration-150 pointer-coarse:h-11',
        name ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {name ? `Hablar con ${name}` : ''}
      {coarse ? null : <kbd className="border border-[#0e0f17] bg-[#1a1c2c] px-1 font-mono text-[10px] text-[#ffcd75]">E</kbd>}
    </button>
  );
}
