import type { SpaceBackupFailure } from '../../api/client/space-backups-client';

export function backupFailureText(failure: SpaceBackupFailure): string {
  let action = 'Revisa esta causa en el ordenador del espacio y crea una copia nueva.';
  if (/isolation|resources?|mounts|sidecar|unsafe|private|owner|labels/iu.test(failure.message)) {
    action = 'Restablece la propiedad, los permisos y el aislamiento aprobados del contenedor antes de crear otra copia.';
  } else if (/release|image/iu.test(failure.message)) {
    action = 'Recupera la release acreditada de este contenedor antes de crear otra copia; no fuerces su validación.';
  } else if (/policy.*changed/iu.test(failure.message)) {
    action = 'Actualiza el estado del ordenador y solicita una copia con su política vigente.';
  } else if (/limit|deadline|timeout|exceeded/iu.test(failure.message)) {
    action = 'Revisa el tamaño del espacio y la capacidad del ordenador antes de crear otra copia.';
  }
  return `Causa: ${failure.type}: ${failure.message}. ${action}`;
}
