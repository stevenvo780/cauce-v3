import type { ProviderAuthProbeReason, ProviderAuthReason } from '../../api/client/provider-auth-client';

/** Spanish text for each bounded identity-probe reason the gateway relays (ops/cli/fleet_provider_identity.py). */
const PROBE_MESSAGES: Record<ProviderAuthProbeReason, string> = {
  PROBE_TIMEOUT: 'El proveedor tardó más de lo permitido en responder la prueba de identidad. Reintenta la verificación; si se repite, el modelo está lento o saturado.',
  PROBE_EXIT: 'El programa del proveedor terminó con error durante la prueba de identidad. Reintenta; si se repite, revisa el registro del ordenador.',
  PROBE_BAD_JSON: 'El proveedor respondió la prueba de identidad con un formato inesperado. Comprueba que la versión instalada sea la aprobada y reintenta.',
  PROBE_NONCE_MISMATCH: 'El modelo respondió, pero no devolvió la frase de control de la prueba. Reintenta la verificación.',
  PROBE_OUTPUT_LIMIT: 'La respuesta del proveedor superó el tamaño permitido para la prueba de identidad. Reintenta la verificación.',
  PROBE_UNAVAILABLE: 'No se pudo ejecutar la prueba de identidad en el ordenador: el programa o el perfil del proveedor no están disponibles. Revisa la preparación del agente y reintenta.',
  PROBE_IDENTITY_MISMATCH: 'La cuenta conectada no es la esperada. Cierra la sesión del proveedor e inicia con la cuenta autorizada.',
  PROBE_IDENTITY_UNAVAILABLE: 'El proveedor no mostró qué cuenta quedó conectada. Vuelve a iniciar sesión y completa todo el flujo antes de verificar.',
  PROBE_PROFILE_UNUSABLE: 'La sesión del proveedor está caducada, en pausa o deshabilitada. Vuelve a iniciar sesión.',
  PROBE_VERSION_MISMATCH: 'La versión del programa del proveedor en el agente no es la aprobada. Pulsa Preparar para actualizar el agente y vuelve a iniciar sesión.',
  PROBE_CONFIG_SCOPE: 'La configuración del agente no coincide con la cuenta o el modelo aprobados. Pulsa Preparar para regenerarla y vuelve a iniciar sesión.',
  PROBE_CONTAINER_EXEC_FAILED: 'No se pudo ejecutar la prueba dentro del contenedor del agente. Revisa que el contenedor esté en marcha y reintenta.',
};

export function probeFailureMessage(reason: ProviderAuthReason | undefined): string | undefined {
  return reason !== undefined && Object.hasOwn(PROBE_MESSAGES, reason) ? PROBE_MESSAGES[reason as ProviderAuthProbeReason] : undefined;
}
