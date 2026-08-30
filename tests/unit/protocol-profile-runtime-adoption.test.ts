import { describe, expect, it } from 'vitest';
import {
  profileRuntimeAdoptionFor,
  type ProfileRuntimeContract,
  type ProfileRuntimeDocumentMeasurement,
} from '@cauce/protocol';

/**
 * profileRuntimeAdoptionFor solo emite evidencia cuando contract y measured encajan
 * exactamente: misma cantidad, mismas rutas, mismo sha256 por ruta, y ningún path sobrante.
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

  it('devuelve undefined cuando contract es undefined', () => {
    expect(profileRuntimeAdoptionFor(undefined, [DOC_A])).toBeUndefined();
  });

  it('devuelve undefined cuando measured es undefined', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), undefined)).toBeUndefined();
  });

  it('devuelve undefined cuando hay menos mediciones que documentos en el contract', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A])).toBeUndefined();
  });

  it('devuelve undefined cuando hay más mediciones que documentos en el contract', () => {
    const overflow: ProfileRuntimeDocumentMeasurement = { path: '/x', sha256: SHA_C };
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, DOC_B, overflow])).toBeUndefined();
  });

  it('devuelve undefined cuando el basename del path no coincide con document.name', () => {
    const contract = baseContract([
      { name: 'AGENTS.md', path: '/etc/foo/CLAUDE.md', sha: SHA_A },
    ]);
    expect(profileRuntimeAdoptionFor(contract, [DOC_A])).toBeUndefined();
  });

  it('devuelve undefined cuando el sha256 observado no coincide con document.sha', () => {
    const mismatchedSha: ProfileRuntimeDocumentMeasurement = {
      path: DOC_B.path,
      sha256: SHA_C,
    };
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, mismatchedSha])).toBeUndefined();
  });

  it('devuelve undefined cuando measured trae un path extra que no está en contract.documents', () => {
    expect(profileRuntimeAdoptionFor(baseContract(), [DOC_A, DOC_B, DOC_EXTRA])).toBeUndefined();
  });

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
