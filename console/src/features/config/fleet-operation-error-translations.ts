export const PRIMARY_MEMBERSHIP_CHECKBOX_ID = 'primary-membership-enabled';

export function isPrimaryMembershipError(message: string): boolean {
  return /primary membership must be enabled/iu.test(message)
    || /grupo principal.*debe quedar habilitado/iu.test(message);
}

export function primaryMembershipErrorText(roomId?: string): string {
  const group = roomId ? ` (${roomId})` : '';
  return `Para activar el agente su grupo principal${group} debe quedar habilitado. Marca "Habilitar membresía".`;
}

const TRANSLATIONS: readonly (readonly [RegExp, string])[] = [
  [/target tenant is not active/iu, 'El espacio de trabajo no está activo. Actívalo o elige otro espacio antes de preparar el agente.'],
  [/target harness is not enabled/iu, 'El arnés elegido no está habilitado. Elige un arnés habilitado o habilítalo en la configuración.'],
  [/physical runtime identity is immutable/iu, 'La clave física de ejecución no se puede cambiar. Conserva la clave actual o crea un agente nuevo.'],
  [/physical runtime identity is reserved/iu, 'Esa clave física ya está reservada por otro agente. Elige otra clave.'],
  [/membership room or routing role is unavailable/iu, 'Uno de los grupos incluidos o su rol de ruteo no está disponible. Revisa los grupos y el rol de cada membresía.'],
  [/fleet host belongs to another company/iu, 'La computadora elegida pertenece a otra empresa. Elige una computadora de esta empresa.'],
  [/fleet host must be registered in the target company first/iu, 'La computadora aún no está registrada en esta empresa. Regístrala en «Computadoras» antes de preparar el agente.'],
  [/fleet controller placement is not configured/iu, 'El controlador de flota no está configurado. Pide a un administrador que lo configure y vuelve a intentarlo.'],
  [/agent identity already exists/iu, 'Ya existe un agente con esa identidad en este espacio. Elige otro alias o edita el agente existente.'],
];

/** Spanish translation for a raw fleet preview/enqueue refusal, or undefined when unknown. */
export function translateFleetOperationError(message: string, primaryRoomId?: string): string | undefined {
  if (isPrimaryMembershipError(message)) return primaryMembershipErrorText(primaryRoomId);
  return TRANSLATIONS.find(([pattern]) => pattern.test(message))?.[1];
}

export function focusPrimaryMembershipCheckbox(): boolean {
  const element = document.getElementById(PRIMARY_MEMBERSHIP_CHECKBOX_ID)
    ?? document.querySelector<HTMLElement>('[data-primary-membership-checkbox="true"]');
  if (!element) return false;
  if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  return true;
}
