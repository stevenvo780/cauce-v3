import type { ConfigMutation } from '@cauce/protocol';

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

export interface ConfigurationChangeResult {
  applied: boolean;
  dry_run: boolean;
  revision: number;
  /** Revision whose inverse was executed. Null proves this was a normal configuration change. */
  rolled_back_revision_id: number | null;
  summary: string;
  mutation: ConfigMutation;
  inverse_mutation: ConfigMutation;
}

export type ConfigurationLeafMutation = Exclude<ConfigMutation, { resource: 'batch' }>;
export type ConfigurationAction = 'create' | 'update' | 'delete' | 'retire' | 'restore';

export interface ConfigurationResourceCapability {
  readonly resource: ConfigurationLeafMutation['resource'] | 'agent_profile';
  readonly actions: readonly ConfigurationAction[];
  readonly scope: 'hub' | 'tenant' | 'outgoing_acl' | 'none';
  readonly tenant_id?: string;
}

export interface ConfigurationCapabilities {
  readonly actor: {
    readonly tenant_id: string;
    readonly alias: string;
    readonly is_hub: boolean;
    readonly can_control: boolean;
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
