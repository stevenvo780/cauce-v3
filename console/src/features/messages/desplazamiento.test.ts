import { describe, expect, it, vi } from 'vitest';
import { estaPegadoAlFinal, irAlFinal, MARGEN_PEGADO } from './desplazamiento';

describe('cuándo un hilo está mirando el final', () => {
  it('está pegado cuando el fondo se ve entero', () => {
    expect(estaPegadoAlFinal({ scrollTop: 10_499, scrollHeight: 10_976, clientHeight: 477 })).toBe(true);
  });

  it('sigue pegado dentro del margen: unos píxeles no son «se fue a leer arriba»', () => {
    expect(estaPegadoAlFinal({
      scrollTop: 10_499 - MARGEN_PEGADO, scrollHeight: 10_976, clientHeight: 477,
    })).toBe(true);
  });

  /**
   * The case that matters: the operator scrolled up to read. From here on new messages CANNOT
   * drag them along, or the view moves the text from under their eyes every 2.5 seconds — which
   * is how often messages are re-read.
   */
  it('deja de estar pegado en cuanto el operador sube más que el margen', () => {
    expect(estaPegadoAlFinal({
      scrollTop: 10_499 - MARGEN_PEGADO - 1, scrollHeight: 10_976, clientHeight: 477,
    })).toBe(false);
    // And the case measured in production: just opened, all the way up, 10,976 px from the end.
    expect(estaPegadoAlFinal({ scrollTop: 0, scrollHeight: 10_976, clientHeight: 477 })).toBe(false);
  });

  it('un hilo que cabe entero está pegado: no hay «final» al que ir', () => {
    expect(estaPegadoAlFinal({ scrollTop: 0, scrollHeight: 300, clientHeight: 477 })).toBe(true);
  });
});

describe('irAlFinal', () => {
  it('usa scrollTo cuando existe, que es lo que hace el navegador', () => {
    const scrollTo = vi.fn();
    const caja = { scrollHeight: 10_976, scrollTop: 0, scrollTo } as unknown as HTMLElement;
    irAlFinal(caja);
    expect(scrollTo).toHaveBeenCalledWith({ top: 10_976, behavior: 'auto' });
  });

  it('cae a scrollTop donde no hay scrollTo, para no quedarse sin hacer nada', () => {
    const caja = { scrollHeight: 10_976, scrollTop: 0 } as unknown as HTMLElement;
    irAlFinal(caja);
    expect(caja.scrollTop).toBe(10_976);
  });

  it('el botón «ir al último» pide desplazamiento suave; el arranque, no', () => {
    const scrollTo = vi.fn();
    const caja = { scrollHeight: 500, scrollTop: 0, scrollTo } as unknown as HTMLElement;
    irAlFinal(caja, true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
  });
});
