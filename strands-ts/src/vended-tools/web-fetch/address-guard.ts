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
  '64:ff9b:1::/48', // local-use NAT64
]

type Lookup = typeof import('node:dns/promises').lookup

let guard: Promise<{ lookup: Lookup; nonPublic: BlockList }> | undefined

/**
 * Whether `hostname` resolves to at least one address and every one of them is public.
 * Rejects when `hostname` cannot be resolved, including on runtimes without `node:dns`
 * and `node:net`.
 *
 * @internal
 */
export async function isPublicHost(hostname: string): Promise<boolean> {
  const { lookup, nonPublic } = await (guard ??= _loadGuard())
  const addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true })
  // IPv4-mapped IPv6 addresses are matched against the IPv4 networks.
  return (
    addresses.length > 0 &&
    addresses.every(({ address, family }) => !nonPublic.check(address, family === 6 ? 'ipv6' : 'ipv4'))
  )
}

async function _loadGuard(): Promise<{ lookup: Lookup; nonPublic: BlockList }> {
  try {
    const [{ lookup }, { BlockList }] = await Promise.all([
      _builtin<typeof import('node:dns/promises')>('node:dns/promises'),
      _builtin<typeof import('node:net')>('node:net'),
    ])
    const nonPublic = new BlockList()
    for (const network of NON_PUBLIC_NETWORKS) {
      const [address, prefix] = network.split('/')
      if (network.includes(':')) {
        nonPublic.addSubnet(address!, Number(prefix), 'ipv6')
      } else {
        nonPublic.addSubnet(address!, Number(prefix), 'ipv4')
        // The well-known NAT64 prefix carries an IPv4 address in its low 32 bits.
        nonPublic.addSubnet(`64:ff9b::${address}`, 96 + Number(prefix), 'ipv6')
      }
    }
    return { lookup, nonPublic }
  } catch (error) {
    throw new Error('host addresses can only be checked on Node.js', { cause: error })
  }
}

// The specifier is a variable so browser bundlers do not resolve it. Bundlers for Node.js cannot
// resolve it either, so a failed import falls back to `process.getBuiltinModule`.
async function _builtin<T>(id: string): Promise<T> {
  try {
    return await import(/* @vite-ignore */ id)
  } catch (error) {
    const module = globalThis.process?.getBuiltinModule?.(id)
    if (!module) throw error
    return module as T
  }
}
