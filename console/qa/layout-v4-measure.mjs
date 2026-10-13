export function measureV4Layout() {
  const root = [...document.querySelectorAll('[role="dialog"]')].find(element => element.checkVisibility())
    ?? document.querySelector('main');
  if (!root) throw new Error('Visible content is required');
  const visible = element => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || element.closest('[hidden], [inert]')) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return false;
    }
    return true;
  };
  const paintedBox = (element, rect) => {
    const painted = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    for (let ancestor = element; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const box = ancestor.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        painted.left = Math.max(painted.left, box.left);
        painted.right = Math.min(painted.right, box.right);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        painted.top = Math.max(painted.top, box.top);
        painted.bottom = Math.min(painted.bottom, box.bottom);
      }
    }
    return painted;
  };
  const identify = element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.getAttribute('aria-label') ? `[aria-label="${element.getAttribute('aria-label')}"]` : ''}`;
  const describe = (element, text) => ({ selector: identify(element), text: text.trim().slice(0, 100) });
  const clipped = [];
  const fragments = [];
  const scrolls = [];
  const ellipses = [];
  const fields = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const element = node.parentElement;
    if (!node.textContent.trim() || !visible(element) || element.closest('svg, style, script, textarea, select, option')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const painted = paintedBox(element, rect);
      if (painted.right > painted.left && painted.bottom > painted.top) fragments.push({ element, node, rect: painted, ...describe(element, node.textContent) });
      let scrollX = false;
      let scrollY = false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        const outX = rect.left < box.left - 2 || rect.right > box.right + 2;
        const outY = rect.top < box.top - 2 || rect.bottom > box.bottom + 2;
        if ((outX && !scrollX && /hidden|clip/.test(style.overflowX))
          || (outY && !scrollY && /hidden|clip/.test(style.overflowY))) {
          const detail = { ...describe(element, node.textContent), ancestor: identify(ancestor) };
          if (style.textOverflow === 'ellipsis' && (ancestor.title || ancestor.getAttribute('aria-label'))) ellipses.push(detail);
          else clipped.push(detail);
          break;
        }
        scrollX ||= /auto|scroll/.test(style.overflowX);
        scrollY ||= /auto|scroll/.test(style.overflowY);
      }
    }
  }
  const overlaps = [];
  for (let i = 0; i < fragments.length; i += 1) {
    for (let j = i + 1; j < fragments.length; j += 1) {
      const a = fragments[i];
      const b = fragments[j];
      if (a.node === b.node) continue;
      const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (width > 2 && height > 2) overlaps.push({ first: describe(a.element, a.text), second: describe(b.element, b.text), width, height });
    }
  }
  const controls = [...root.querySelectorAll('input:not([type="hidden"]), select, textarea, button, a[href]')].filter(visible);
  for (const control of controls) {
    const box = paintedBox(control, control.getBoundingClientRect());
    for (const fragment of fragments) {
      if (control.contains(fragment.element) || fragment.element.contains(control)) continue;
      const width = Math.min(box.right, fragment.rect.right) - Math.max(box.left, fragment.rect.left);
      const height = Math.min(box.bottom, fragment.rect.bottom) - Math.max(box.top, fragment.rect.top);
      if (width > 2 && height > 2) overlaps.push({ first: describe(control, control.getAttribute('aria-label') ?? control.textContent),
        second: describe(fragment.element, fragment.text), width, height });
    }
    if (control.matches('input, textarea, select') && control.scrollWidth > control.clientWidth + 2) {
      fields.push({ selector: identify(control), hiddenWidth: control.scrollWidth - control.clientWidth, keyboard: !control.disabled });
    }
  }
  for (const element of [root, ...root.querySelectorAll('*')].filter(visible)) {
    const style = getComputedStyle(element);
    const hiddenWidth = Math.round(element.scrollWidth - element.clientWidth);
    const hiddenHeight = Math.round(element.scrollHeight - element.clientHeight);
    if ((hiddenWidth > 2 && /auto|scroll/.test(style.overflowX)) || (hiddenHeight > 2 && /auto|scroll/.test(style.overflowY))) {
      scrolls.push({ selector: identify(element), hiddenWidth, hiddenHeight,
        keyboard: element.tabIndex >= 0 || !!element.querySelector('button, a[href], input, select, textarea, [tabindex]') });
    }
  }
  const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  return {
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth),
    clipped: unique(clipped), overlaps: unique(overlaps), scrolls, ellipses: unique(ellipses), fields,
    theme: getComputedStyle(document.documentElement).colorScheme,
    contentHeight: Math.round(root.scrollHeight), textFragments: fragments.length, controls: controls.length,
  };
}

export function absoluteFailures(metrics, theme) {
  const failures = [];
  if (metrics.overflow > 0) failures.push(`Horizontal overflow: ${metrics.overflow}px`);
  if (metrics.clipped.length) failures.push(`Clipped text: ${metrics.clipped.length}`);
  if (metrics.overlaps.length) failures.push(`Content overlaps: ${metrics.overlaps.length}`);
  if (metrics.scrolls.some(scroll => scroll.hiddenWidth > 2 && !scroll.keyboard)) failures.push('Horizontal scroller without keyboard access');
  if (metrics.theme !== theme) failures.push(`Expected ${theme} theme, received ${metrics.theme}`);
  if (!metrics.textFragments) failures.push('No visible text was measured');
  return failures;
}
