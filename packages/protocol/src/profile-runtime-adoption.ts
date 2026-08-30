import type {
  ProfileRuntimeAdoptionEvidence,
  ProfileRuntimeContract,
} from './schemas.js';

export interface ProfileRuntimeDocumentMeasurement {
  readonly path: string;
  readonly sha256: string;
}

/** Builds adoption evidence only from an exact contract/document measurement match. */
export function profileRuntimeAdoptionFor(
  contract: ProfileRuntimeContract | undefined,
  measured: readonly ProfileRuntimeDocumentMeasurement[] | undefined,
): ProfileRuntimeAdoptionEvidence | undefined {
  if (contract === undefined
    || contract.documents.length !== measured?.length) return undefined;
  const observed = new Map(measured.map((document) => [document.path, document.sha256]));
  for (const document of contract.documents) {
    if (document.path.slice(document.path.lastIndexOf('/') + 1) !== document.name
      || observed.get(document.path) !== document.sha) return undefined;
    observed.delete(document.path);
  }
  if (observed.size !== 0) return undefined;
  return {
    evidence: 'adapter_delivery',
    revision: contract.revision,
    generation: contract.generation,
    documents: contract.documents,
  };
}
