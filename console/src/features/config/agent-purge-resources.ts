export type PurgeResources =
  | { kind: 'native'; host: string | undefined; directory: string | undefined }
  | { kind: 'container'; container: string }
  | { kind: 'none' };

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

/** The snapshot stores `host:<host_id>` as container_name for native agents; that is not a container. */
export function purgeResources(agent: Record<string, unknown> | undefined): PurgeResources {
  const name = text(agent?.container_name);
  const mode = text(agent?.runtime_mode);
  if (mode === 'native' || name?.startsWith('host:')) {
    const hostId = text(agent?.host_id) ?? name?.slice('host:'.length);
    return { kind: 'native', host: hostId, directory: text(agent?.state_directory) ?? text(agent?.runtime_key) };
  }
  return name ? { kind: 'container', container: name } : { kind: 'none' };
}
