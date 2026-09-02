import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState, type ComponentType } from 'react';

/** The one key the choice is stored under, and the one list of names it can hold. `public/tema.js`
    repeats both to beat the first paint; `tema-bootstrap.test.ts` reads these and parses that. */
export const CLAVE_TEMA = 'cauce.tema';
export const TEMAS = ['sistema', 'claro', 'oscuro'] as const;

export type Tema = (typeof TEMAS)[number];

const OPCIONES: readonly {
  id: Tema;
  rotulo: string;
  icono: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}[] = [
  { id: 'sistema', rotulo: 'Sistema', icono: Monitor },
  { id: 'claro', rotulo: 'Claro', icono: Sun },
  { id: 'oscuro', rotulo: 'Oscuro', icono: Moon },
];

/** `sistema` has no value on purpose: it REMOVES the attribute and lets the media query decide. */
const ATRIBUTO: Partial<Record<Tema, string>> = { claro: 'light', oscuro: 'dark' };

function esTema(valor: unknown): valor is Tema {
  return TEMAS.some((tema) => tema === valor);
}

/* A private window throws on every `localStorage` access instead of returning null, so reading and
   writing the preference can never be the reason the console fails to paint. */
function leerTema(): Tema {
  try {
    const guardado = window.localStorage.getItem(CLAVE_TEMA);
    return esTema(guardado) ? guardado : 'sistema';
  } catch {
    return 'sistema';
  }
}

function guardarTema(tema: Tema): void {
  try {
    window.localStorage.setItem(CLAVE_TEMA, tema);
  } catch {
    /* sin almacenamiento: la elección vale para esta pestaña */
  }
}

function aplicarTema(tema: Tema): void {
  const atributo = ATRIBUTO[tema];
  if (atributo) document.documentElement.setAttribute('data-theme', atributo);
  else document.documentElement.removeAttribute('data-theme');
}

export function ThemeControl() {
  const [tema, setTema] = useState<Tema>(leerTema);

  useEffect(() => { aplicarTema(tema); }, [tema]);

  const elegir = useCallback((elegido: Tema) => {
    setTema(elegido);
    guardarTema(elegido);
  }, []);

  return (
    <div className="theme-control" role="group" aria-label="Tema de la consola">
      {OPCIONES.map(({ id, rotulo, icono: Icono }) => (
        <button
          key={id}
          type="button"
          className="theme-option"
          aria-pressed={tema === id}
          // The label is hidden on a phone, so the name has to travel on the button itself.
          aria-label={rotulo}
          title={`Tema ${id}`}
          onClick={() => { elegir(id); }}
        >
          <Icono size={14} aria-hidden={true} />
          <span>{rotulo}</span>
        </button>
      ))}
    </div>
  );
}
