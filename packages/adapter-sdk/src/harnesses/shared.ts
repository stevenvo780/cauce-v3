export { HarnessAdapter } from "./shared/adapter.js";
export {
  abortadoPorApagado,
  elTestigoDiceQueNoEmpezo,
  esDiagnosticoDeArranque,
  esSesionNativaInexistente,
  executionError,
  nuncaEmpezoElTurno,
  sanitizeProcessOutput,
  sinMarcaDeArranque,
} from "./shared/errors.js";
export {
  capabilities,
  DELEGATION_MECHANICS_HEADER,
  IDENTITY_BEGIN,
  IDENTITY_END,
  PRIMARY_DUTY_HEADER,
  protocolPrompt,
  textoFijoDelSobre,
  textoNativoDelSobre,
} from "./shared/prompt.js";
export type {
  HarnessAdapterOptions,
  HarnessExecuteRequest,
  HarnessRequestContext,
  HarnessSessionReservation,
  RuntimeProfileMeasurement,
  SessionLane,
} from "../contracts/harness.js";
