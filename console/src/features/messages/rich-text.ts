type RichBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const HEADING = /^#{1,4}\s+(.*)$/u;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/u;

/**
 * A small, deliberately partial reading of agent text: fenced code, headings, bullet and numbered
 * lists and paragraphs. Everything stays text; nothing is ever interpreted as HTML. An unclosed
 * fence (a truncated preview) keeps the rest as code instead of guessing where it ended.
 */
export function parseRichText(source: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ...list });
    list = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) { code.push(lines[index]); index += 1; }
      blocks.push({ kind: 'code', text: code.join('\n'), ...(fence[1] ? { lang: fence[1] } : {}) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? undefined : NUMBERED.exec(line);
    const entry = bullet ?? numbered;
    if (entry) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list?.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(entry[1]);
      continue;
    }
    if (list && /^\s{2,}\S/u.test(line)) {
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    flushList();
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', text: heading[1] });
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
