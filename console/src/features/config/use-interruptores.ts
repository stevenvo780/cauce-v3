import { useRef, useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { textoRecarga, type ConfigChangeOutcome, type EstadoRecarga } from './config-change';
import type { Interruptor } from './interruptores';

/**
 * **El comportamiento de un interruptor: pinta al instante y REVIERTE SOLO si el servidor lo
 * rechaza.**
 *
 * Es la parte que hay que probar de este carril. Un interruptor optimista sin marcha atrás es peor
 * que un botón: el botón que falla al menos deja la fila como estaba, mientras que el interruptor
 * que se queda encendido después de un 409 le está diciendo al operador que un permiso está
 * concedido cuando la base dice que no. Esa mentira no la desmiente nada hasta que alguien recarga
 * la página, y para entonces ya tomó una decisión sobre ella.
 *
 * La regla, sin excepciones:
 *  - mientras la escritura vuela, se pinta lo que el operador pidió y el control queda `aria-busy`;
 *  - si el servidor responde bien Y la relectura llegó, se descarta el valor optimista: manda el
 *    snapshot fresco, que es lo que la base tiene de verdad (y que puede no ser lo que se pidió, si
 *    otro operador escribió en el medio);
 *  - si el servidor responde bien pero la relectura NO llegó, se mantiene lo pedido y se dice con
 *    todas las letras que la tabla puede estar vencida;
 *  - si el servidor RECHAZA, se descarta el valor optimista —o sea, el interruptor vuelve solo a lo
 *    que el snapshot dice— y sale el motivo **del servidor**, no uno inventado acá, con un botón
 *    para reintentar exactamente la misma mutación.
 */

export interface FalloDeInterruptor {
  interruptor: Interruptor;
  /** El motivo tal como lo contó el servidor. Nunca un «no se pudo» genérico. */
  motivo: string;
  /** La revisión bajo la cual este fallo es lo último que pasó. */
  revision: number | undefined;
}

export interface ConfirmacionDeInterruptor {
  interruptor: Interruptor;
  texto: string;
}

export interface AvisoDeInterruptor {
  coleccion: string;
  text: string;
  tone: 'success' | 'parcial';
  revision: number | undefined;
}

export interface ControlDeInterruptores {
  /** Lo que la celda tiene que pintar: el valor optimista si hay uno, si no el del servidor. */
  valorPintado: (interruptor: Interruptor) => boolean;
  enVuelo: (clave: string) => boolean;
  fallo: (clave: string) => FalloDeInterruptor | undefined;
  avisoDe: (coleccion: string) => { text: string; tone: 'success' | 'parcial' } | undefined;
  confirmacion: ConfirmacionDeInterruptor | undefined;
  /** Un clic en el interruptor. Confirma sólo si el interruptor lo exige. */
  pulsar: (interruptor: Interruptor) => void;
  confirmar: () => void;
  cancelar: () => void;
  reintentar: (clave: string) => void;
  /** Al cambiar de pestaña: los carteles valen para la pantalla que los produjo. */
  limpiar: () => void;
}

/**
 * La revisión que el snapshot tiene DESPUÉS de una escritura: la releída si la relectura llegó, y
 * si no, la que había. Igual criterio que `ConfigPage`, para que un cartel no sobreviva al dato que
 * lo desmiente.
 */
function revisionTrasEscribir(recarga: EstadoRecarga | undefined, actual: number | undefined): number | undefined {
  if (recarga?.releido) return recarga.revision;
  return actual;
}

function sinClave<T>(mapa: Record<string, T>, clave: string): Record<string, T> {
  if (!Object.hasOwn(mapa, clave)) return mapa;
  const next: Record<string, T> = {};
  for (const [k, v] of Object.entries(mapa)) {
    if (k !== clave) next[k] = v;
  }
  return next;
}

export function useInterruptores(
  escribir: (mutation: ConfigMutation) => Promise<ConfigChangeOutcome>,
  revisionActual: number | undefined,
): ControlDeInterruptores {
  const [optimista, setOptimista] = useState<Record<string, boolean>>({});
  const [volando, setVolando] = useState<Record<string, true>>({});
  const [fallos, setFallos] = useState<Record<string, FalloDeInterruptor>>({});
  const [confirmacion, setConfirmacion] = useState<ConfirmacionDeInterruptor>();
  const [aviso, setAviso] = useState<AvisoDeInterruptor>();

  // Patrón «última referencia»: los manejadores se pasan al DOM y no deben congelar ni la revisión
  // esperada ni el `change` de la página. Sin esto, el segundo clic mandaría la revisión del primero.
  const ultimo = useRef({ escribir, revisionActual });
  ultimo.current = { escribir, revisionActual };

  async function aplicar(interruptor: Interruptor) {
    const { clave } = interruptor;
    const pedido = !interruptor.valor;
    setFallos((actual) => sinClave(actual, clave));
    setAviso(undefined);
    setOptimista((actual) => ({ ...actual, [clave]: pedido }));
    setVolando((actual) => ({ ...actual, [clave]: true }));
    let desenlace: ConfigChangeOutcome;
    try {
      desenlace = await ultimo.current.escribir(interruptor.mutation);
    } catch (error) {
      // `change()` no tira, pero si alguna vez lo hiciera, un interruptor encendido para siempre
      // sobre una escritura que reventó es exactamente la mentira que este módulo existe para
      // impedir. Se revierte igual.
      desenlace = {
        ok: false, conflict: false,
        message: error instanceof Error ? error.message : 'Cambio rechazado: UNKNOWN',
      };
    }
    setVolando((actual) => sinClave(actual, clave));
    const revision = revisionTrasEscribir(desenlace.recarga, ultimo.current.revisionActual);

    if (!desenlace.ok) {
      // ⬅️ LA REVERSIÓN. Quitar el valor optimista devuelve la celda a lo que el snapshot dice, que
      // es lo que la base tiene. Sin esta línea el interruptor se queda pintado en un estado que
      // nadie guardó.
      setOptimista((actual) => sinClave(actual, clave));
      setFallos((actual) => ({
        ...actual,
        [clave]: { interruptor, revision, motivo: desenlace.message + textoRecarga(desenlace.recarga) },
      }));
      return;
    }

    if (desenlace.recarga && !desenlace.recarga.releido) {
      // Se guardó, pero no se pudo comprobar releyendo. Se mantiene lo pedido —el servidor dijo que
      // lo aplicó— y se avisa de que el resto de la tabla puede estar vencido.
      setAviso({
        coleccion: interruptor.coleccion, tone: 'parcial', revision,
        text: `${interruptor.descripcion}: el servidor lo aplicó en la revisión `
          + `${String(desenlace.result.revision ?? 'UNKNOWN')}.${textoRecarga(desenlace.recarga)}`,
      });
      return;
    }

    setOptimista((actual) => sinClave(actual, clave));
    setAviso({
      coleccion: interruptor.coleccion, tone: 'success', revision,
      text: `${interruptor.descripcion}: aplicado en la revisión `
        + `${String(desenlace.result.revision ?? 'UNKNOWN')} (${desenlace.result.summary ?? 'sin resumen del servidor'}).`
        + textoRecarga(desenlace.recarga),
    });
  }

  return {
    valorPintado: (interruptor) => (Object.hasOwn(optimista, interruptor.clave)
      ? optimista[interruptor.clave]
      : interruptor.valor),
    enVuelo: (clave) => Object.hasOwn(volando, clave),
    // Un cartel vale para el estado que lo produjo: si el snapshot se movió debajo —otro operador,
    // «Actualizar», otra escritura— deja de mostrarse en vez de seguir afirmándose.
    fallo: (clave) => {
      const registrado = Object.hasOwn(fallos, clave) ? fallos[clave] : undefined;
      return registrado && registrado.revision === revisionActual ? registrado : undefined;
    },
    avisoDe: (coleccion) => (aviso?.coleccion === coleccion && aviso.revision === revisionActual
      ? { text: aviso.text, tone: aviso.tone }
      : undefined),
    confirmacion,
    pulsar: (interruptor) => {
      if (interruptor.confirmar !== undefined) {
        setAviso(undefined);
        setConfirmacion({ interruptor, texto: interruptor.confirmar });
        return;
      }
      void aplicar(interruptor);
    },
    confirmar: () => {
      const pedida = confirmacion;
      setConfirmacion(undefined);
      if (pedida) void aplicar(pedida.interruptor);
    },
    cancelar: () => { setConfirmacion(undefined); },
    reintentar: (clave) => {
      const registrado = Object.hasOwn(fallos, clave) ? fallos[clave] : undefined;
      if (registrado) void aplicar(registrado.interruptor);
    },
    limpiar: () => {
      setConfirmacion(undefined);
      setFallos({});
      setAviso(undefined);
    },
  };
}
