import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado } from './role-brief';

/**
 * How much of the declared role REACHES the agent: 1200 of the 4000 the field admits, measured in
 * the two units that do not match — code points in the store, UTF-16 in the deployed adapter —.
 */
export function MedidorDeRol({ texto }: { texto: string }) {
  const recortado = texto.trim();
  const puntos = Array.from(recortado).length;
  const utf16 = recortado.length;
  const pasado = puntos > ROLE_BRIEF_MAX || utf16 > ROLE_BRIEF_MAX;
  const bloqueo = bloqueoPorRuntimeDesplegado(texto);
  return (
    <>
      <span className={`perfil-tramo${pasado ? ' perfil-tramo-fuera' : ''}`}>
        Le llega al agente: {puntos} puntos de código · {utf16} unidades UTF-16 / {ROLE_BRIEF_MAX}
      </span>
      {bloqueo ? (
        <p className="perfil-aviso perfil-aviso-error" role="alert">{bloqueo}</p>
      ) : pasado ? (
        <p className="perfil-aviso perfil-aviso-error" role="alert">
          Pasado de {ROLE_BRIEF_MAX}: la proyección a role_brief y el self_role de cada entrega
          recortan ahí, así que lo que sigue se guarda y el agente no lo lee.
        </p>
      ) : null}
    </>
  );
}
