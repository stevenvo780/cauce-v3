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
  const occlusions = [];
  const blockedAtEnd = [];
  const fields = [];
  const stickyAncestor = element => {
    for (let ancestor = element; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).position === 'sticky') return ancestor;
    }
    return null;
  };
  const opaque = element => {
    const color = getComputedStyle(element).backgroundColor;
    const alphaMatch = color.match(/\/\s*([\d.]+)(%)?/) ?? color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
    let alpha = color === 'transparent' ? 0 : alphaMatch ? Number(alphaMatch[1]) / (alphaMatch[2] ? 100 : 1) : 1;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) alpha *= Number(getComputedStyle(ancestor).opacity);
    return alpha >= 0.9;
  };
  const recordOverlap = (first, second, width, height) => {
    const a = stickyAncestor(first.element);
    const b = stickyAncestor(second.element);
    const detail = { first: describe(first.element, first.text), second: describe(second.element, second.text), width, height };
    let scroller;
    for (let ancestor = first.element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.contains(second.element) && /auto|scroll/.test(getComputedStyle(ancestor).overflowY)
        && ancestor.scrollHeight > ancestor.clientHeight + 2) { scroller = ancestor; break; }
    }
    const sticky = a ?? b;
    if (!!a !== !!b && scroller && opaque(sticky)) {
      occlusions.push(detail);
      if (getComputedStyle(sticky).bottom !== 'auto' && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) blockedAtEnd.push(detail);
    } else overlaps.push(detail);
  };
  const redundantAgentHeading = ancestor => {
    if (!ancestor.matches('h2') || !ancestor.closest('section[aria-label^="Perfil y contexto de "]')) return false;
    const subtitle = ancestor.nextElementSibling;
    const alias = ancestor.textContent.replace('Perfil y contexto de ', '').trim();
    if (!subtitle?.matches('p') || !subtitle.textContent.trim().endsWith(` / ${alias}`)) return false;
    return subtitle.scrollWidth <= subtitle.clientWidth + 2 && visible(subtitle);
  };
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
      const scrollersX = [];
      const scrollersY = [];
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        const outX = rect.left < box.left - 2 || rect.right > box.right + 2;
        const outY = rect.top < box.top - 2 || rect.bottom > box.bottom + 2;
        const reachableX = scrollersX.some(scroll => scroll.left < box.right && scroll.right > box.left);
        const reachableY = scrollersY.some(scroll => scroll.top < box.bottom && scroll.bottom > box.top);
        if ((outX && !reachableX && /hidden|clip/.test(style.overflowX))
          || (outY && !reachableY && /hidden|clip/.test(style.overflowY))) {
          const detail = { ...describe(element, node.textContent), ancestor: identify(ancestor) };
          if (style.textOverflow === 'ellipsis' && (ancestor.title || ancestor.getAttribute('aria-label') || redundantAgentHeading(ancestor))) ellipses.push(detail);
          else clipped.push(detail);
          break;
        }
        if (/auto|scroll/.test(style.overflowX)) scrollersX.push(box);
        if (/auto|scroll/.test(style.overflowY)) scrollersY.push(box);
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
      if (width > 2 && height > 2) recordOverlap(a, b, width, height);
    }
  }
  const controls = [...root.querySelectorAll('input:not([type="hidden"]), select, textarea, button, a[href]')].filter(visible);
  for (const control of controls) {
    const box = paintedBox(control, control.getBoundingClientRect());
    for (const fragment of fragments) {
      if (control.contains(fragment.element)) continue;
      const width = Math.min(box.right, fragment.rect.right) - Math.max(box.left, fragment.rect.left);
      const height = Math.min(box.bottom, fragment.rect.bottom) - Math.max(box.top, fragment.rect.top);
      if (width > 2 && height > 2) recordOverlap({ element: control, text: control.getAttribute('aria-label') ?? control.textContent }, fragment, width, height);
    }
    if (control.matches('input, textarea, select') && control.scrollWidth > control.clientWidth + 2) {
      fields.push({ selector: identify(control), hiddenWidth: control.scrollWidth - control.clientWidth, keyboard: !control.disabled });
    }
  }
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i];
    const b = controls[j];
    if (a.contains(b) || b.contains(a)) continue;
    const first = paintedBox(a, a.getBoundingClientRect());
    const second = paintedBox(b, b.getBoundingClientRect());
    const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
    const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
    if (width > 2 && height > 2) recordOverlap({ element: a, text: a.getAttribute('aria-label') ?? a.textContent },
      { element: b, text: b.getAttribute('aria-label') ?? b.textContent }, width, height);
  }
  for (const sticky of [...root.querySelectorAll('*')].filter(visible)) {
    const style = getComputedStyle(sticky);
    if (style.position !== 'sticky' || !opaque(sticky)) continue;
    const box = paintedBox(sticky, sticky.getBoundingClientRect());
    const targets = [...fragments, ...controls.map(element => ({ element, text: element.getAttribute('aria-label') ?? element.textContent,
      rect: paintedBox(element, element.getBoundingClientRect()) }))];
    for (const target of targets) {
      if (sticky.contains(target.element)) continue;
      const width = Math.min(box.right, target.rect.right) - Math.max(box.left, target.rect.left);
      const height = Math.min(box.bottom, target.rect.bottom) - Math.max(box.top, target.rect.top);
      if (width > 2 && height > 2) recordOverlap({ element: sticky, text: 'Sticky controls' }, target, width, height);
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
    clipped: unique(clipped), overlaps: unique(overlaps), occlusions: unique(occlusions), blockedAtEnd: unique(blockedAtEnd), scrolls, ellipses: unique(ellipses), fields,
    theme: getComputedStyle(document.documentElement).colorScheme,
    contentHeight: Math.round(root.scrollHeight), textFragments: fragments.length, controls: controls.length,
  };
}

export function absoluteFailures(metrics, theme) {
  const failures = [];
  if (metrics.overflow > 0) failures.push(`Horizontal overflow: ${metrics.overflow}px`);
  if (metrics.clipped.length) failures.push(`Clipped text: ${metrics.clipped.length}`);
  if (metrics.overlaps.length) failures.push(`Content overlaps: ${metrics.overlaps.length}`);
  if (metrics.blockedAtEnd?.length) failures.push(`Content unreachable under sticky controls at scroll end: ${metrics.blockedAtEnd.length}`);
  if (metrics.scrolls.some(scroll => scroll.hiddenWidth > 2 && !scroll.keyboard)) failures.push('Horizontal scroller without keyboard access');
  if (metrics.fields.some(field => field.hiddenWidth > 2 && !field.keyboard)) failures.push('Clipped field without keyboard access');
  if (metrics.theme !== theme) failures.push(`Expected ${theme} theme, received ${metrics.theme}`);
  if (!metrics.textFragments) failures.push('No visible text was measured');
  return failures;
}
