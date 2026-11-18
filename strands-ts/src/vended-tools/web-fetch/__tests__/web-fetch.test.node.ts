import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeWebFetch } from '../web-fetch.js'
import * as addressGuard from '../address-guard.js'

vi.mock('../address-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof addressGuard>()
  return { isPublicHost: vi.fn(actual.isPublicHost) }
})

describe('webFetch against a loopback server', () => {
  let server: Server
  let port: number
  let requests: string[]

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url!)
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end()
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('secret')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as AddressInfo).port
  })

  beforeEach(() => {
    requests = []
  })

  afterAll(() => {
    server.close()
  })

  it.each(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '2130706433', '[::ffff:127.0.0.1]'])(
    'refuses http://%s without sending a request',
    async (host) => {
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: `http://${host}:${port}/secret` })).rejects.toThrow(
        /fetch refused/
      )
      expect(requests).toStrictEqual([])
    }
  )

  it('refuses a redirect to a loopback address without requesting it', async () => {
    const { isPublicHost } = await vi.importActual<typeof addressGuard>('../address-guard.js')
    vi.mocked(addressGuard.isPublicHost).mockImplementation(async (hostname) =>
      hostname === 'localhost' ? true : isPublicHost(hostname)
    )

    await expect(
      makeWebFetch({ mode: 'markdown' }).invoke({ url: `http://localhost:${port}/redirect` })
    ).rejects.toThrow(`url=<http://127.0.0.1:${port}/secret> | fetch refused`)
    expect(requests).toStrictEqual(['/redirect'])
  })

  it('fetches a loopback URL through a redirect when allowPrivateAddresses is set', async () => {
    const result = await makeWebFetch({ mode: 'markdown', allowPrivateAddresses: true }).invoke({
      url: `http://127.0.0.1:${port}/redirect`,
    })

    expect(result).toBe('secret')
    expect(requests).toStrictEqual(['/redirect', '/secret'])
  })
})
