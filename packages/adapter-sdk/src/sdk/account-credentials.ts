/**
 * EL PUNTO DONDE EL ADAPTADOR RESUELVE LA CREDENCIAL VÍA EL SELECTOR.
 *
 * Hasta acá `credential_ref` era metadato que no consumía nadie: la credencial llegaba por un
 * bind-mount fijado al crear el contenedor, y cambiar de cuenta significaba recrear el
 * contenedor a mano. Esto convierte la respuesta del selector
 * (GET /v3/accounts/selection, ver services/gateway/src/app.ts) en el `env` con el que se
 * lanza el harness.
 *
 * ------------------------------------------------------------------------------------------
 * LA RESTRICCIÓN QUE MANDA SOBRE TODO EL DISEÑO: `~/.claude` ES UN MOUNT COMPARTIDO
 * ------------------------------------------------------------------------------------------
 * `/datos/agents/shared/.claude` está montado en 6 de los 15 alias de la flota. Para ESOS seis es
 * FÍSICAMENTE IMPOSIBLE que dos usen cuentas Claude distintas: comparten el directorio de sesión,
 * así que apuntar a otra cuenta en uno se lo cambiaría a los otros cinco en caliente, en mitad de
 * sus ejecuciones. Los otros 9 alias ya tienen directorio propio y pueden rotar sin tocar a nadie.
 *
 * La base NO puede saber cuál es cuál: un bind-mount no es una fila. Sólo el host lo sabe. Por eso
 * la rotación es OPT-IN EXPLÍCITO DEL PROCESO ADAPTADOR, vía `CAUCE_ACCOUNT_ROTATION=enabled`:
 *
 *   - Variable ausente (o cualquier otro valor) => se devuelve `{}`: CERO variables de entorno
 *     añadidas, o sea EXACTAMENTE el comportamiento de hoy, donde el CLI resuelve la credencial
 *     que ya está logueada dentro del contenedor. Los 6 alias del mount compartido siguen andando
 *     igual que siempre porque no se les setea la variable. Fallar hacia "no rotes" es la única
 *     dirección segura: la otra le cambia la cuenta a cinco agentes ajenos.
 *   - `CAUCE_ACCOUNT_ROTATION=enabled` => se aplica la selección. Se pone en los 9 alias con
 *     directorio propio.
 *
 * Esto no es una convención inventada acá: la migración 010 ya describe este mismo estado como el
 * de partida — "Attempt 1 of a delivery runs with no environment override at all, so the CLI
 * resolves whichever credential is already logged in inside its container".
 *
 * CAMINO DE MIGRACIÓN de los 6 compartidos (no requiere código, es de despliegue):
 *   1. Dar a cada alias su propio directorio de estado, copiando el compartido:
 *      `cp -a /datos/agents/shared/.claude /datos/agents/<alias>/.claude`.
 *   2. Cambiar su bind-mount al directorio propio y recrear el contenedor (docker restart NO
 *      alcanza: el mount se fija al crear).
 *   3. Registrar la cuenta y su binding en la consola (provider_account + techo + binding).
 *   4. Recién ahí, setear `CAUCE_ACCOUNT_ROTATION=enabled` en ese alias.
 * El paso 4 es el último a propósito: mientras el mount siga compartido, encender la rotación es
 * lo que rompe a los otros cinco.
 */

import type { HarnessId } from "./types.js";

/** Forma de la respuesta del selector que a este módulo le importa. Se declara acá, en vez de
 *  importar el tipo del store, porque el adaptador NO depende de `@cauce/store`: corre en el
 *  contenedor del agente y habla con el gateway por HTTP. */
export interface SelectedAccount {
  readonly account_id: string;
  readonly provider: string;
  readonly credential_ref_kind: "env_path" | "file" | "secret_manager";
  readonly credential_ref: string;
}

export type CredentialRefusal =
  /** El proceso no tiene `CAUCE_ACCOUNT_ROTATION=enabled`: mount compartido o alias no migrado. */
  | "rotation_disabled"
  /** El selector no devolvió cuenta (todas pausadas/agotadas/deshabilitadas). */
  | "no_account_selected"
  /** El harness no tiene una variable conocida para redirigir su directorio de credenciales. */
  | "harness_not_rotatable"
  /** `env_path` cuyo locator no existe en el entorno del adaptador: el host no tiene el material. */
  | "locator_not_present"
  /** `secret_manager`: dereferenciarlo exigiría que el adaptador hable con un vault. */
  | "secret_manager_unsupported";

export interface CredentialResolution {
  /** Variables a añadir al `env` del harness. `{}` = no se cambia nada (comportamiento de hoy). */
  readonly env: Readonly<Record<string, string>>;
  /** `null` cuando se aplicó la selección; si no, por qué no se aplicó. */
  readonly refused: CredentialRefusal | null;
  /** Cuenta efectivamente aplicada, para el log de operación. Nunca lleva el valor del locator. */
  readonly account_id: string | null;
}

const ROTATION_ENABLED = "enabled";
const ROTATION_FLAG = "CAUCE_ACCOUNT_ROTATION";

/**
 * Variable con la que cada CLI acepta que le muevan el directorio de credenciales/estado.
 *
 * `hermes` y `fake` no están y no es un olvido: hermes resuelve su autenticación desde su
 * almacenamiento local (ver `SAFE_ENVIRONMENT` en process-runner.ts) y `fake` no tiene
 * credenciales. Un harness ausente del mapa se rechaza con `harness_not_rotatable` en vez de
 * inventarle una variable, porque adivinar acá significa lanzar el CLI apuntado a un directorio
 * que no entiende y perder la sesión del agente.
 *
 * NINGUNO de estos nombres matchea el regex `SECRET_ENVIRONMENT` de process-runner.ts, que
 * rechazaría la ejecución entera con SECRET_ENV_REJECTED. Es una condición dura sobre este mapa y
 * está cubierta por un test.
 */
const HARNESS_CREDENTIAL_ENV: Partial<Record<HarnessId, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
  openclaw: "OPENCLAW_HOME",
};

/**
 * Traduce la cuenta elegida a variables de entorno para el harness.
 *
 * Pura y sin red: recibe el entorno en vez de leer `process.env`, así que el test no depende del
 * proceso que lo corre. Todos los caminos de fallo devuelven `env: {}`, o sea el comportamiento de
 * hoy — nunca una ejecución rota.
 *
 * El VALOR del locator (un path) puede terminar en el `env` del hijo, que es el punto; lo que
 * jamás se devuelve ni se registra es el contenido del archivo al que apunta. `credential_ref` es
 * un LOCATOR, no un secreto: eso es lo que hace seguro prestarlo entre tenants (migración 010).
 */
export function resolveAccountCredentialEnv(
  harness: HarnessId,
  selected: SelectedAccount | null,
  environment: Readonly<Record<string, string | undefined>>,
): CredentialResolution {
  const refuse = (refused: CredentialRefusal): CredentialResolution =>
    ({ env: {}, refused, account_id: null });

  if (environment[ROTATION_FLAG] !== ROTATION_ENABLED) return refuse("rotation_disabled");
  if (selected === null) return refuse("no_account_selected");

  const variable = HARNESS_CREDENTIAL_ENV[harness];
  if (variable === undefined) return refuse("harness_not_rotatable");

  let path: string;
  switch (selected.credential_ref_kind) {
    case "env_path": {
      // El locator NOMBRA una variable del entorno del adaptador; el path está ahí, no en la base.
      // Ésta es la indirección que hace que una fila del pool nunca pueda ser una fuga: sin el
      // material montado en este host, el locator no dereferencia a nada.
      const value = environment[selected.credential_ref];
      if (value === undefined || value.length === 0) return refuse("locator_not_present");
      path = value;
      break;
    }
    case "file":
      // El CHECK `provider_accounts_credential_ref_shape` ya garantiza que es absoluto, sin `..`
      // y sin `//`. No se revalida acá para no tener dos definiciones de "path aceptable" que
      // puedan divergir; la base es la autoridad.
      path = selected.credential_ref;
      break;
    case "secret_manager":
      // Haría falta que el adaptador hablara con un vault. No se hace: mantener al adaptador
      // incapaz de dereferenciar secretos es una propiedad, no una limitación pendiente.
      return refuse("secret_manager_unsupported");
  }

  return { env: { [variable]: path }, refused: null, account_id: selected.account_id };
}
