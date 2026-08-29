import { describe, expect, it } from 'vitest';
import {
  profileRuntimeAdoptionFor,
  type ProfileRuntimeContract,
  type ProfileRuntimeDocumentMeasurement,
} from '@cauce/protocol';

/**
 * `profileRuntimeAdoptionFor` solo emite evidencia cuando contract y measured encajan
 * exactamente: misma cantidad, mismas rutas, mismo sha256 por ruta, y ningún path sobrante.
 * Cualquier rama de salida con `undefined` representa "el adaptador no pudo demostrar
 * la adopción". Estos tests cubren cada una.
 */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

const DOC_A: ProfileRuntimeDocumentMeasurement = {
  path: '/etc/cauce/CLAUDE.md',
  sha256: SHA_A,
};

const DOC_B: ProfileRuntimeDocumentMeasurement = {
  path: '/var/cauce/AGENTS.md',
  sha256: SHA_B,
};

const DOC_EXTRA: ProfileRuntimeDocumentMeasurement = {
  path: '/srv/cauce/README.md',
  sha256: SHA_D,
};

function baseContract(
  documents: ProfileRuntimeContract['documents'] = [
    { name: 'CLAUDE.md', path: DOC_A.path, sha: SHA_A },
    { name: 'AGENTS.md', path: DOC_B.path, sha: SHA_B },
  ],
): ProfileRuntimeContract {
  return {
    revision: 7,
    generation: 'gen-1',
    documents,
  };
}

describe('profileRuntimeAdoptionFor', () => {
  /** Camino feliz: dos documentos y dos mediciones con path y sha exactos → evidence completa. */
  it('emite la evidencia cuando contract y measured encajan exactamente (camino feliz)', () => {
    const contract = baseContract();
    const evidence = profileRuntimeAdoptionFor(contract, [DOC_A, DOC_B]);

    expect(evidence).toEqual({
      evidence: 'adapter_delivery',
      revision: 7,
      generation: 'gen-1',
      documents: [
        { name: 'CLAUDE.md', path: DOC_A.path, sha: SHA_A },
        { name: 'AGENTS.md', path: DOC_B.path, sha: SHA_B },
      ],
    });
  });

  /** Primera guarda: contract undefined, measured válido → undefined sin tocar measured. */
  it('devuelve undefined cuando contract es undefined', () => {
    expect(profileRuntimeAdoptionFor(undefined, [DOC_A])).toBeUndefined();
  });

  /** Segunda guarda: measured undefined, contract válido (dos documentos) → undefined. */
  it('devuelve undefined cuando measured es undefined', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), undefined)).toBeUndefined();
  });

  /** Tercera guarda: contract con 2 documentos y measured con 1 → undefined por longitud. */
  it('devuelve undefined cuando hay menos mediciones que documentos en el contract', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A])).toBeUndefined();
  });

  /** Tercera guarda, otro lado: contract con 2 documentos y measured con 3 → undefined por longitud. */
  it('devuelve undefined cuando hay más mediciones que documentos en el contract', () => {
    const overflow: ProfileRuntimeDocumentMeasurement = { path: '/x', sha256: SHA_C };
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, DOC_B, overflow])).toBeUndefined();
  });

  /**
   * El basename derivado del path tiene que coincidir con `document.name`. Una ruta como
   * `/etc/foo/CLAUDE.md` cuyo `name` sea `AGENTS.md` rompe esa invariante y la función
   * rechaza el contrato sin mirar sha256.
   */
  it('devuelve undefined cuando el basename del path no coincide con document.name', () => {
    const contract = baseContract([
      { name: 'AGENTS.md', path: '/etc/foo/CLAUDE.md', sha: SHA_A },
    ]);
    expect(profileRuntimeAdoptionFor(contract, [DOC_A])).toBeUndefined();
  });

  /**
   * El sha de la medición contra la misma ruta no coincide: no es prueba de adopción
   * aunque el resto encaje. El bucle recorre el primer doc, hace su `observed.delete`, y al
   * llegar al segundo detecta el sha incorrecto.
   */
  it('devuelve undefined cuando el sha256 observado no coincide con document.sha', () => {
    const mismatchedSha: ProfileRuntimeDocumentMeasurement = {
      path: DOC_B.path,
      sha256: SHA_C,
    };
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, mismatchedSha])).toBeUndefined();
  });

  /**
   * measured trae una entrada más de las que contract lista — el contrato del runtime la
   * rechaza y devuelve undefined. Esta rama cubre el caso "más mediciones que documentos",
   * simétrico al test de "menos mediciones".
   */
  it('devuelve undefined cuando measured trae un path extra que no está en contract.documents', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, DOC_B, DOC_EXTRA])).toBeUndefined();
  });

  /**
   * El bucle `for (const document of contract.documents)` recorre la lista; si está vacía
   * directamente no entra. Esto ejercita la rama del bucle sin iteraciones: con ambas listas
   * vacías, longitudes coinciden (0===0), no se entra al `for`, `observed` se construye
   * vacío, y la función emite evidencia con `documents: []`.
   */
  it('emite evidencia vacía cuando contract y measured están vacíos (rama sin iteraciones)', () => {
    const evidence = profileRuntimeAdoptionFor(
      { revision: 1, generation: 'gen-empty', documents: [] },
      [],
    );
    expect(evidence).toEqual({
      evidence: 'adapter_delivery',
      revision: 1,
      generation: 'gen-empty',
      documents: [],
    });
  });
});
