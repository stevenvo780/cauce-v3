const PATH_TAG = /<path\b[^>]*?\sd="([^"]*)"/g;
const RECT_TAG = /<rect\b([^>]*)>/g;
const SAFE_PATH = /^[MmHhVvLlZz0-9\s.,-]+$/;

function attr(tag: string, name: string): number | undefined {
  const match = new RegExp(`\\s${name}="(-?\\d+(?:\\.\\d+)?)"`).exec(tag);
  return match ? Number(match[1]) : undefined;
}

/**
 * Collapses a package SVG into one path-data string, keeping only <path> and <rect> geometry so
 * nothing else in the markup (scripts, handlers, styles, references) can ever reach the page.
 */
export function svgToPathData(svg: string): string | null {
  const parts: string[] = [];
  for (const match of svg.matchAll(PATH_TAG)) {
    if (!SAFE_PATH.test(match[1])) return null;
    parts.push(match[1]);
  }
  for (const match of svg.matchAll(RECT_TAG)) {
    const [x, y, w, h] = [attr(match[1], 'x') ?? 0, attr(match[1], 'y') ?? 0, attr(match[1], 'width'), attr(match[1], 'height')];
    if (w === undefined || h === undefined) return null;
    parts.push(`M${String(x)} ${String(y)}h${String(w)}v${String(h)}h${String(-w)}z`);
  }
  return parts.length > 0 ? parts.join('') : null;
}
