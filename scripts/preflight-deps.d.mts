export const REMEDIO: string;
export const MODULOS_NATIVOS: ReadonlyArray<{ nombre: string; prueba: (raiz: string) => unknown }>;
export function comprobarEntorno(opciones: { raiz: string }): string[];
