import type { ConfigMutation } from '@cauce/protocol';
import type { CompanyAuthority, CompanyAuthorityScope, CompanyRole } from '../company-authority.js';
import type { DatabaseClient } from '../db.js';

/** `invalid_input` keeps malformed operator text out of opaque PostgreSQL CHECK failures. */
export type ConfigurationErrorCode = 'forbidden' | 'conflict' | 'not_found' | 'invalid_input';

export class ConfigurationError extends Error {
  constructor(
    readonly code: ConfigurationErrorCode, message: string,
    readonly dependencies: readonly ConfigurationDependency[] = [],
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export type ConfigurationAuthorityResolver = (client: DatabaseClient) => Promise<CompanyAuthority>;

export interface ConfigurationChangeResult {
  applied: boolean;
  dry_run: boolean;
  revision: number;
  /** Revision whose inverse was executed. Null proves this was a normal configuration change. */
  rolled_back_revision_id: number | null;
  summary: string;
  mutation: ConfigMutation;
  inverse_mutation: ConfigMutation;
  mutation_sha256?: string;
}

export type ConfigurationLeafMutation = Exclude<ConfigMutation, { resource: 'batch' }>;
export type ConfigurationAction = 'create' | 'update' | 'delete' | 'retire' | 'restore' | 'set';
export type ConfigurationCapabilityResource = ConfigurationLeafMutation['resource'] | 'agent_profile' | 'fleet_host';

export interface ConfigurationResourceCapability {
  readonly resource: ConfigurationCapabilityResource;
  readonly actions: readonly ConfigurationAction[];
  readonly scope: CompanyAuthorityScope;
  readonly tenant_id?: string;
}

export interface ConfigurationCapabilities {
  readonly actor: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly can_control: boolean;
    readonly role: CompanyRole;
    readonly scope: CompanyAuthorityScope;
    readonly company_id: string;
    readonly platform_override: boolean;
  };
  readonly resources: readonly ConfigurationResourceCapability[];
}

export interface ConfigurationDependency {
  readonly type: string;
  readonly identity: Readonly<Record<string, string>>;
  readonly blocking: boolean;
}

export interface ConfigurationDependencyPreview {
  readonly revision: number;
  readonly resource: ConfigurationLeafMutation['resource'];
  readonly identity: Readonly<Record<string, string>>;
  readonly dependencies: readonly ConfigurationDependency[];
  readonly can_delete: boolean;
}
