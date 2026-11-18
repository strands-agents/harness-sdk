import { describe, it, expect, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { isPublicHost } from '../address-guard.js'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

function mockLookup(...addresses: string[]): void {
  vi.mocked(lookup).mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never
  )
}

describe('isPublicHost', () => {
  it.each([
    ['0.0.0.0', false],
    ['10.0.0.5', false],
    ['100.64.0.1', false],
    ['127.0.0.1', false],
    ['127.255.255.254', false],
    ['169.254.169.254', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.0.0.192', false],
    ['192.168.1.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:a00:5', false],
    ['fc00::1', false],
    ['fd00:ec2::254', false],
    ['fe80::1', false],
    ['fe80::1%eth0', false],
    ['fec0::1', false],
    ['ff02::1', false],
    ['8.8.8.8', true],
    ['172.15.255.255', true],
    ['172.32.0.1', true],
    ['198.18.0.1', true],
    ['::ffff:8.8.8.8', true],
    ['2606:4700:4700::1111', true],
  ])('resolving to %s is public: %s', async (address, expected) => {
    mockLookup(address)

    await expect(isPublicHost('host.example')).resolves.toBe(expected)
  })

  it('is not public when any resolved address is not public', async () => {
    mockLookup('8.8.8.8', '10.0.0.5')

    await expect(isPublicHost('host.example')).resolves.toBe(false)
  })

  it('resolves every address of the host, without the brackets of an IPv6 literal', async () => {
    mockLookup('::1')

    await isPublicHost('[::1]')

    expect(lookup).toHaveBeenLastCalledWith('::1', { all: true })
  })

  it('rejects when the host cannot be resolved', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'))

    await expect(isPublicHost('unknown.example')).rejects.toThrow('ENOTFOUND')
  })
})
