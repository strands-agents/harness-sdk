import type { BlockList } from 'node:net'

const NON_PUBLIC_NETWORKS = [
  '0.0.0.0/8', // unspecified / "this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // shared address space (carrier-grade NAT)
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // private
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, broadcast
  '::/128', // unspecified
  '::1/128', // loopback
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
]

type Lookup = typeof import('node:dns/promises').lookup

let guard: Promise<{ lookup: Lookup; nonPublic: BlockList }> | undefined

/**
 * Whether every address `hostname` resolves to is public. Rejects when `hostname`
 * cannot be resolved, including on runtimes without `node:dns` and `node:net`.
 *
 * @internal
 */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const { lookup, nonPublic } = await (guard ??= _loadGuard())
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true })
  // IPv4-mapped IPv6 addresses are matched against the IPv4 networks.
  return addresses.every(({ address, family }) => !nonPublic.check(address, family === 6 ? 'ipv6' : 'ipv4'))
}

async function _loadGuard(): Promise<{ lookup: Lookup; nonPublic: BlockList }> {
  try {
    // Specifiers are held in variables so browser bundlers do not try to resolve them.
    const [dns, net] = ['node:dns/promises', 'node:net']
    const [{ lookup }, { BlockList }]: [typeof import('node:dns/promises'), typeof import('node:net')] =
      await Promise.all([import(/* @vite-ignore */ dns), import(/* @vite-ignore */ net)])
    const nonPublic = new BlockList()
    for (const network of NON_PUBLIC_NETWORKS) {
      const [address, prefix] = network.split('/')
      nonPublic.addSubnet(address!, Number(prefix), network.includes(':') ? 'ipv6' : 'ipv4')
    }
    return { lookup, nonPublic }
  } catch (error) {
    throw new Error('host addresses can only be checked on Node.js', { cause: error })
  }
}
