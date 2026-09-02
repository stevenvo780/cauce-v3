/* Anti-flash bootstrap: a forced theme has to reach <html> before the first paint, so this runs
   ahead of the bundle. It is a same-origin file and not an inline block because the console ships
   `script-src 'self'`, which never executes inline script. Key and names mirror
   src/components/ThemeControl.tsx; src/tema-bootstrap.test.ts parses this file so they cannot drift. */
(function () {
  var ATRIBUTO = { sistema: '', claro: 'light', oscuro: 'dark' };
  try {
    var elegido = window.localStorage.getItem('cauce.tema');
    var forzado = Object.prototype.hasOwnProperty.call(ATRIBUTO, elegido) ? ATRIBUTO[elegido] : '';
    if (!forzado) return;
    document.documentElement.setAttribute('data-theme', forzado);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      metas[i].media = metas[i].media.indexOf(forzado) === -1 ? 'not all' : 'all';
    }
  } catch (error) {
    /* ventana privada: manda la preferencia del sistema */
  }
})();
