// Types for ./certs.mjs.

export interface SelfSignedOptions {
  directory?: string;
  common_name?: string;
  days?: number;
  /** Directory mode; the key and certificate become 0644 alongside it. */
  mode?: number;
}

export interface SelfSignedCert {
  directory: string;
  key_path: string;
  cert_path: string;
  key: Buffer;
  cert: Buffer;
}

export declare function createSelfSignedCert(options?: SelfSignedOptions): SelfSignedCert;
