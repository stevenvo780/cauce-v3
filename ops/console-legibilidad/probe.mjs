// Fuente de la funcion que se inyecta en la pagina con Runtime.evaluate (CDP).
// Es una cadena a proposito: es el vehiculo de medicion del navegador, no codigo de la app.
export const PROBE = `function () {
  const parseColor = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[ ,\\/]+/).filter(Boolean).map((v) => v.endsWith('%') ? parseFloat(v) / 100 : Number(v));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b, a };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /*
   * Fondo efectivo. Los degradados (\`.panel\`, \`.button.primary\`, la fila activa…) NO aparecen en
   * \`backgroundColor\`: si se ignoran, el fondo medido es el del ancestro y el numero sale falso.
   * Aca se compone de AFUERA hacia ADENTRO y, cuando una capa es un degradado, se abren tantas
   * variantes como paradas de color tenga; al final se conserva la mas clara y la mas oscura y se
   * puntua el PEOR caso. Un falso positivo sube el umbral y ciega al resto de la medicion.
   */
  const bgCandidatos = (el) => {
    const cadena = [];
    let n = el;
    while (n && n.nodeType === 1) { cadena.push(n); n = n.parentElement; }
    cadena.reverse();
    let cands = [{ r: 255, g: 255, b: 255, a: 1 }];
    for (const node of cadena) {
      const cs = getComputedStyle(node);
      const capas = [];
      const bc = parseColor(cs.backgroundColor);
      if (bc && bc.a > 0) capas.push(bc);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none') {
        const stops = (bi.match(/rgba?\\([^)]*\\)/g) || []).map(parseColor).filter(Boolean).filter((c) => c.a > 0);
        if (stops.length) capas.push(stops);
      }
      for (const capa of capas) {
        const alternativas = Array.isArray(capa) ? capa : [capa];
        const next = [];
        for (const base of cands) for (const alt of alternativas) next.push(over(alt, base));
        cands = next;
      }
      if (cands.length > 2) {
        cands.sort((a, b) => lum(a) - lum(b));
        cands = [cands[0], cands[cands.length - 1]];
      }
    }
    return cands;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // La opacidad de un ANCESTRO no aparece en el 'color' calculado del hijo: sin esto, un bloque
  // atenuado al 45% se mide como si estuviera a plena tinta. Era un punto ciego de la sonda.
  const opacidadHeredada = (el) => {
    let o = 1, n = el;
    while (n && n.nodeType === 1) { o *= Number(getComputedStyle(n).opacity); n = n.parentElement; }
    return o;
  };
  const ownText = (el) => {
    let t = '';
    for (const nn of el.childNodes) if (nn.nodeType === 3) t += nn.textContent;
    return t.trim();
  };
  const clsOf = (el) => (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || '')).slice(0, 70);

  // --- contraste ---
  const sub = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.classList && el.classList.contains('sr-only')) continue;
    const txt = ownText(el);
    if (!txt) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const fgRaw = parseColor(cs.color);
    if (!fgRaw) continue;
    const cands = bgCandidatos(el);
    const op = opacidadHeredada(el);
    const fgOp = { r: fgRaw.r, g: fgRaw.g, b: fgRaw.b, a: fgRaw.a * op };
    let peor = null;
    for (const bg of cands) {
      const fg = fgOp.a < 1 ? over(fgOp, bg) : fgOp;
      const cr = ratio(fg, bg);
      if (peor === null || cr < peor.cr) peor = { cr, bg };
    }
    const px = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3.0 : 4.5;
    if (peor.cr + 0.005 < need) {
      sub.push({
        tag: el.tagName.toLowerCase(), cls: clsOf(el), text: txt.slice(0, 45),
        color: cs.color,
        bg: 'rgb(' + Math.round(peor.bg.r) + ',' + Math.round(peor.bg.g) + ',' + Math.round(peor.bg.b) + ')',
        px: Math.round(px * 100) / 100, ratio: Math.round(peor.cr * 100) / 100, need,
        opacidad: Math.round(op * 100) / 100,
        inerte: !!el.closest('[aria-disabled="true"], :disabled, .nav-inerte'),
      });
    }
  }

  // --- desbordes ---
  const vw = document.documentElement.clientWidth;
  const doc = {
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    desborda: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
  const dentroDeScroller = (el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      n = n.parentElement;
    }
    return false;
  };
  const fueraDePantalla = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !dentroDeScroller(el)) {
      fueraDePantalla.push({
        tag: el.tagName.toLowerCase(), cls: clsOf(el),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  const paneles = [];
  for (const el of document.querySelectorAll('.panel, .ultimate-terminal-shell, .state-card')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const h2 = el.querySelector('h2, h3');
    paneles.push({
      cls: clsOf(el), titulo: h2 ? h2.textContent.trim().slice(0, 40) : '',
      width: Math.round(r.width), right: Math.round(r.right),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      desborda: el.scrollWidth > el.clientWidth + 1 || r.right > vw + 1,
    });
  }

  // --- texto recortado por ellipsis ---
  const truncado = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.classList && el.classList.contains('sr-only')) continue;
    const cs = getComputedStyle(el);
    // Solo cuenta el recorte DECLARADO con elipsis: un \`overflow: hidden\` cualquiera lo dispara
    // tambien un pseudo-elemento decorativo (\`.metric::after\`), y eso no es texto cortado.
    if (cs.textOverflow !== 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const t = (el.textContent || '').trim();
    if (!t) continue;
    truncado.push({ tag: el.tagName.toLowerCase(), cls: clsOf(el), text: t.slice(0, 45), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }

  // --- menu ---
  const navUl = document.querySelector('.sidebar nav ul');
  let nav = null;
  if (navUl) {
    const items = [...navUl.querySelectorAll('a')].map((a) => {
      const r = a.getBoundingClientRect();
      const sp = a.querySelector('span');
      const sr = sp ? sp.getBoundingClientRect() : null;
      return {
        label: (sp ? sp.textContent : a.textContent).trim().slice(0, 30),
        aW: Math.round(r.width * 10) / 10, aL: Math.round(r.left), aR: Math.round(r.right),
        spanW: sr ? Math.round(sr.width * 10) / 10 : null,
        spanScroll: sp ? sp.scrollWidth : null,
        spanClient: sp ? sp.clientWidth : null,
        spanVisible: sp ? getComputedStyle(sp).display !== 'none' : false,
        pisa: sr ? Math.round((sr.width - r.width) * 10) / 10 : null,
      };
    });
    nav = {
      scrollWidth: navUl.scrollWidth, clientWidth: navUl.clientWidth,
      arrastrable: navUl.scrollWidth > navUl.clientWidth + 1,
      items,
      pisados: items.filter((i) => i.spanVisible && i.pisa > 0.5).length,
      recortados: items.filter((i) => i.spanVisible && i.spanScroll > i.spanClient + 1).length,
    };
  }

  return {
    url: location.pathname, vw, doc,
    subAA: sub, subAACount: sub.length,
    fueraDePantalla, panelesDesbordados: paneles.filter((p) => p.desborda), paneles,
    truncado, nav,
  };
}`;
