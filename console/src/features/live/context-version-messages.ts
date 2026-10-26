import { ApiError } from '../../api/client/core';

export interface ApplicationNotice { readonly message: string; readonly pending: boolean }

const UNREADABLE_VERSION_MESSAGE = 'La versión actual no se puede leer. Restaura una versión anterior desde el historial.';

/** Server application codes. `pending` = the version will be adopted without operator action. */
const APPLICATION: Record<string, ApplicationNotice> = {
  context_runtime_unsupported: { pending: false, message: 'El agente no puede acreditar que usa esta versión: su adaptador no anuncia contexto versionado con testigo de consumo de sus turnos (adaptador antiguo: actualiza su paquete; Muse sin terminal compartida, Grok en terminal compartida u OpenClaw por API no tienen testigo). Cuando lo anuncie, se reevaluará sola y la adopción se comprobará en su próximo turno.' },
  context_runtime_offline: { pending: true, message: 'El agente está desconectado: la versión se aplicará cuando vuelva.' },
  context_runtime_verification_failed: { pending: true, message: 'Aún no se pudo comprobar que el agente use esta versión: se reintentará y la adoptará en su próximo turno.' },
  context_runtime_attempts_exhausted: { pending: false, message: 'Se agotaron los reintentos sin comprobar que el agente use esta versión: revisa que esté en línea y pulsa «Aplicar al agente».' },
  context_version_unreadable: { pending: false, message: UNREADABLE_VERSION_MESSAGE },
  native_context_governed_path: { pending: false, message: 'El agente intentó cambiar archivos gobernados desde su espacio; puede editar context/notes/ y sus documentos nativos reconocidos que ya estén versionados. Nada de esa edición se guardó.' },
  native_context_secret_detected: { pending: false, message: 'La edición del agente en su espacio se rechazó porque el contenido parece un secreto.' },
  native_context_too_large: { pending: false, message: 'La edición del agente en su espacio se rechazó porque supera el tamaño máximo del contexto.' },
  native_context_harness_limit: { pending: false, message: 'La edición del agente en su espacio se rechazó porque supera el límite de documento de su harness.' },
  native_context_unsafe_text: { pending: false, message: 'La edición del agente en su espacio se rechazó porque el texto no es válido.' },
  native_context_invalid_files: { pending: false, message: 'La edición del agente en su espacio se rechazó porque los archivos no son válidos.' },
};

export function applicationNotice(code: string): ApplicationNotice {
  return APPLICATION[code] ?? { pending: false, message: 'No se pudo aplicar la versión al agente. Reintenta; si persiste, revisa el estado del agente.' };
}

const SYNCHRONIZATION: Record<string, string> = {
  context_git_unavailable: 'El servicio de sincronización del contexto no está configurado.',
  context_git_repository_not_private: 'El repositorio de contextos no cumple las condiciones de privacidad o estructura exigidas. El administrador debe revisar su configuración.',
  context_git_authentication_failed: 'El repositorio remoto rechazó la autenticación. El administrador debe revisar su acceso.',
  context_git_network_failed: 'No se pudo conectar con el repositorio remoto. Revisa la conexión y reintenta.',
  context_git_timeout: 'El repositorio de contextos tardó demasiado en responder. Reintenta la sincronización.',
  context_git_non_fast_forward: 'El historial remoto tiene cambios incompatibles. El administrador debe revisar la divergencia antes de reintentar.',
  context_git_commit_failed: 'No se pudo registrar el contexto en Git. El administrador debe revisar el repositorio.',
  context_push_failed: 'No se pudo enviar el contexto al repositorio remoto. Revisa su disponibilidad y reintenta.',
};

export function synchronizationMessage(code: string): string {
  if (code === 'context_version_unreadable') return UNREADABLE_VERSION_MESSAGE;
  return `${SYNCHRONIZATION[code] ?? 'No se pudo confirmar la sincronización con el repositorio remoto. Reintenta; si persiste, consulta al administrador.'} Los cambios siguen guardados y pendientes de sincronización.`;
}

const REQUEST_CODES: Partial<Record<string, string>> = {
  context_version_unreadable: UNREADABLE_VERSION_MESSAGE,
  context_version_conflict: 'Conflicto de versión: el contexto cambió mientras lo editabas. Relee las versiones y vuelve a intentarlo; tu borrador se conserva.',
  invalid_request: 'La solicitud de contexto no es válida. Revisa las rutas y el contenido.',
  context_invalid_files: 'Los archivos tienen una ruta, forma o duplicado no válido.',
  context_too_large: 'El contexto supera el tamaño máximo permitido.',
  context_secret_detected: 'El contenido parece contener una credencial o secreto y no se puede versionar.',
  context_unsafe_text: 'El texto contiene caracteres de control o invisibles no permitidos.',
  context_harness_limit: 'El contexto supera el límite de documento del harness del agente.',
  context_governed_path: 'Esa ruta está gobernada: desde el espacio se puede editar context/notes/ y los documentos nativos reconocidos que ya estén versionados.',
  profile_is_governed: 'El perfil del agente está gobernado: edítalo desde la consola. La ingesta de notas y documentos nativos no permite cambiar el perfil.',
  context_version_failed: 'No se pudo registrar la versión del contexto. Reintenta.',
  context_runtime_unavailable: 'El servicio que aplica el contexto al agente no está disponible. La versión quedó pendiente.',
  context_write_recovery_unproven: 'El agente todavía no confirma el resultado de esa escritura. Comprueba que esté conectado y vuelve a intentarlo.',
  context_write_writer_changed: 'El proceso que escribía en el agente cambió desde entonces y ya no puede acreditar esa escritura. Revisa sus ficheros antes de decidir.',
  context_write_snapshot_changed: 'El perfil o el agente cambiaron desde esa escritura; no se resolvió para no pisar ese cambio.',
  context_write_files_mixed: 'Los ficheros del agente no coinciden ni con el antes ni con el después de esa escritura; no se resolvió. Revisa sus ficheros.',
  context_write_recovery_unsupported: 'Los ficheros cambiaron, pero esa escritura no es del perfil y la consola no puede registrarla sola. Revisa sus ficheros.',
  context_write_not_recoverable: 'Esa escritura no llegó a enviarse al agente y la consola no puede cerrarla sola. Avisa a quien administra la plataforma.',
  context_write_expectation_changed: 'Lo que se esperaba del agente cambió mientras se resolvía; vuelve a intentarlo.',
  context_write_not_found: 'Esa escritura ya no está pendiente. Relee el estado.',
  context_write_recovery_unavailable: 'No se pudo comprobar esa escritura ahora. Vuelve a intentarlo en unos minutos.',
};

/** Why a pending write blocks the agent, in the words the panel shows. */
export function pendingWriteMessage(operation: string): string {
  const what = operation === 'profile' ? 'Hay una escritura del perfil sin confirmar' : 'Hay una escritura de ficheros del agente sin confirmar';
  return `${what}: no se supo si llegó a sus ficheros. Mientras siga así, el agente no recibe mensajes y no puede usar versiones nuevas. Al comprobarla, Cauce relee sus ficheros y la registra o la descarta; no escribe nada.`;
}

export function recoveredWriteMessage(resolution: string): string {
  return resolution === 'target'
    ? 'Comprobado: el agente tiene la escritura y quedó registrada. Ya recibe mensajes y usará la versión guardada en su próximo turno.'
    : 'Comprobado: la escritura no llegó a los ficheros del agente y se descartó. Ya recibe mensajes; guarda el perfil otra vez si quieres repetir el cambio.';
}

const BY_STATUS: Partial<Record<number, string>> = {
  400: 'La solicitud de contexto no es válida.',
  401: 'La sesión expiró. Vuelve a iniciar sesión.',
  403: 'No tienes permiso para esta operación de contexto.',
  404: 'No se encontró el contexto de este agente.',
  409: 'Conflicto de versión: el contexto cambió mientras lo editabas. Relee las versiones y vuelve a intentarlo.',
  413: 'El contexto supera el tamaño máximo permitido.',
  422: 'El contenido del contexto no es válido.',
  503: 'El servicio de contexto no está disponible por ahora. Reintenta en unos minutos.',
};

/** Maps a failed request by server code or status; the server's English message is never shown. */
export function contextRequestMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  return (cause.code === undefined ? undefined : REQUEST_CODES[cause.code]) ?? BY_STATUS[cause.status] ?? fallback;
}
