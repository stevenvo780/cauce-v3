import { BlockList, isIP } from 'node:net';

const DEFAULT_TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128';

export function configuredTrustedProxy(cidrs = process.env.CAUCE_TRUSTED_PROXY_CIDRS ?? DEFAULT_TRUSTED_PROXY_CIDRS):
  (address: string, hop: number) => boolean {
  const trusted = new BlockList();
  if (cidrs.trim() !== '') for (const cidr of cidrs.split(',')) {
    const match = /^([^/]+)\/(\d{1,3})$/u.exec(cidr.trim());
    const address = match?.[1] ?? '';
    const version = isIP(address);
    const prefix = Number(match?.[2]);
    if (version === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
      throw new Error('CAUCE_TRUSTED_PROXY_CIDRS must be a comma-separated list of IPv4 or IPv6 CIDRs');
    }
    trusted.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
  }
  return (address, hop) => {
    const version = isIP(address);
    return hop === 0 && version !== 0 && trusted.check(address, version === 4 ? 'ipv4' : 'ipv6');
  };
}
