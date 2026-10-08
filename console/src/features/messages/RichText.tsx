import type { ReactNode } from 'react';
import { parseRichText } from './rich-text';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/gu;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-muted-bg px-1 py-px font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="grid min-w-0 gap-3 text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere]">
      {parseRichText(text).map((block, index) => {
        if (block.kind === 'code') {
          return (
            <pre key={index} className="m-0 overflow-x-auto rounded-lg border border-line bg-subtle p-3 font-mono text-[12.5px] leading-normal [overflow-wrap:normal]" data-lang={block.lang}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === 'heading') return <p key={index} className="m-0 font-semibold">{inline(block.text)}</p>;
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index} className={block.ordered ? 'm-0 grid list-decimal gap-1 pl-6' : 'm-0 grid list-disc gap-1 pl-5'}>
              {block.items.map((item, itemIndex) => <li key={itemIndex} className="whitespace-pre-wrap">{inline(item)}</li>)}
            </List>
          );
        }
        return <p key={index} className="m-0 whitespace-pre-wrap">{inline(block.text)}</p>;
      })}
    </div>
  );
}
