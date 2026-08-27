/**
 * Resolución de credenciales de cuenta para el arnés basada en la selección del gateway.
 * Si `CAUCE_ACCOUNT_ROTATION=enabled` está activo, inyecta las variables de entorno correspondientes.
 */

import type { HarnessId } from "./types.js";

/** Forma de la respuesta del selector de cuentas. */
export interface SelectedAccount {
  readonly account_id: string;
  readonly provider: string;
  readonly credential_ref_kind: "env_path" | "file" | "secret_manager";
  readonly credential_ref: string;
}

export type CredentialRefusal =
  /** El proceso no tiene `CAUCE_ACCOUNT_ROTATION=enabled`. */
  | "rotation_disabled"
  /** El selector no devolvió cuenta disponible. */
  | "no_account_selected"
  /** El harness no soporta rotación de credenciales. */
  | "harness_not_rotatable"
  /** Variable de entorno referenciada ausente en el entorno del adaptador. */
  | "locator_not_present"
  /** Tipo de referencia `secret_manager` no soportado localmente. */
  | "secret_manager_unsupported";

export interface CredentialResolution {
  /** Variables a añadir al `env` del harness. */
  readonly env: Readonly<Record<string, string>>;
  /** `null` cuando se aplicó la selección; si no, código del motivo de rechazo. */
  readonly refused: CredentialRefusal | null;
  /** Identificador de la cuenta aplicada, para auditoría. */
  readonly account_id: string | null;
}

const ROTATION_ENABLED = "enabled";
const ROTATION_FLAG = "CAUCE_ACCOUNT_ROTATION";

/**
 * Mapeo de variables de entorno de configuración por arnés.
 */
const HARNESS_CREDENTIAL_ENV: Partial<Record<HarnessId, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "OPENCODE_CONFIG_DIR",
  openclaw: "OPENCLAW_HOME",
};

/**
 * Traduce la cuenta seleccionada a las variables de entorno requeridas por el arnés.
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
      const value = environment[selected.credential_ref];
      if (value === undefined || value.length === 0) return refuse("locator_not_present");
      path = value;
      break;
    }
    case "file":
      path = selected.credential_ref;
      break;
    case "secret_manager":
      return refuse("secret_manager_unsupported");
  }

  return { env: { [variable]: path }, refused: null, account_id: selected.account_id };
}
