import { ChevronDown } from 'lucide-react';
import { cn } from '../../cn';
import { HUD_BUTTON, HUD_PANEL, HUD_TEXT, relativeTime } from './hud-style';
import { PixelGlyph } from './PixelGlyph';
import { feedRows, type FeedEntry } from './feed';

const STATUS: Readonly<Record<FeedEntry['status'], { label: string; color: string }>> = {
  sent: { label: 'en camino', color: '#ffcd75' },
  arrived: { label: 'llegó', color: '#41a6f6' },
  collected: { label: 'recogido', color: '#38b764' },
  handed: { label: 'en mano', color: '#a884f3' },
};

/** Recent deliveries between agents: capsules through the tubes between buildings, paper by hand inside one. */
export function TubeFeed({ feed, names, open, now, onToggle, onPick }: {
  feed: readonly FeedEntry[];
  names: ReadonlyMap<string, string>;
  open: boolean;
  now: number;
  onToggle: () => void;
  onPick: (id: string) => void;
}) {
  const name = (id: string) => names.get(id) ?? id.slice(id.indexOf('/') + 1);
  const moving = feed.filter((entry) => entry.status === 'sent' || entry.status === 'arrived').length;
  return (
    <section aria-label="Tubos" className={cn(HUD_PANEL, 'pointer-events-auto flex w-[min(17rem,calc(100vw-1rem))] flex-col')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title="Entregas entre agentes (T)"
        className={cn(HUD_BUTTON, HUD_TEXT, 'h-9 w-full justify-start border-0 px-2 shadow-none')}
      >
        <PixelGlyph kind="tube" accent="#ffcd75" size={16} />
        Tubos
        {moving > 0 ? <span className="bg-[#ffcd75] px-1 text-[#1a1c2c]" aria-label={`, ${String(moving)} en camino`}>{moving}</span> : null}
        <ChevronDown size={12} aria-hidden="true" className={cn('ml-auto transition-transform', open ? 'rotate-180' : null)} />
      </button>
      {open ? (
        feed.length === 0 ? (
          <p className="m-0 border-t-2 border-[#333c57] px-2 py-2 text-[11px] leading-snug text-[#94b0c2]">
            Todavía no viajó ningún tubo. Cuando un agente le pase trabajo a otro edificio, la cápsula sale de su estación y la vas a ver cruzar el campus.
          </p>
        ) : (
          <ol aria-live="polite" className="m-0 max-h-56 list-none overflow-y-auto border-t-2 border-[#333c57] p-1">
            {feedRows(feed).map(({ entry, count }) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => { onPick(entry.to); }}
                  className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1.5 py-1 text-left text-[11px] text-[#f4f4f4] hover:bg-[#333c57] focus-visible:outline-2 focus-visible:outline-[#ffcd75]"
                >
                  <span aria-hidden="true" className="size-2 shrink-0 border border-[#0e0f17]" style={{ backgroundColor: STATUS[entry.status].color }} />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {name(entry.from)} <span aria-hidden="true" className="text-[#94b0c2]">{entry.by === 'tube' ? '⇢' : '→'}</span>
                    <span className="sr-only">{entry.by === 'tube' ? ' por tubo a ' : ' en mano a '}</span> {name(entry.to)}
                    {count > 1 ? <span className="text-[#ffcd75]"> ×{count}</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-[#94b0c2]">{STATUS[entry.status].label} · {relativeTime(entry.at, now)}</span>
                </button>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </section>
  );
}
