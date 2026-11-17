import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'

import { resolveModel } from '../src/models.js'

afterEach(() => vi.unstubAllEnvs())

function clearProxy(): void {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    vi.stubEnv(key, undefined)
  }
}

it('routes through the lowercase proxy and honors NO_PROXY with the real HTTP handler', async () => {
  clearProxy()
  const proxied: string[] = []
  const proxy = createServer((request, response) => {
    proxied.push(request.url!)
    response.end('proxy')
  }).listen(0, '127.0.0.1')
  const direct = createServer((_request, response) => response.end('direct')).listen(0, '127.0.0.1')
  await Promise.all([once(proxy, 'listening'), once(direct, 'listening')])
  let handler: NodeHttpHandler | undefined
  try {
    const proxyPort = (proxy.address() as { port: number }).port
    const directPort = (direct.address() as { port: number }).port
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`)
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    const model = (await resolveModel('bedrock/test')) as BedrockModel
    handler = Reflect.get(model, '_client').config.requestHandler as NodeHttpHandler
    expect(handler).toBeInstanceOf(NodeHttpHandler)
    for (const [hostname, port, expected] of [
      ['example.invalid', 80, 'proxy'],
      ['127.0.0.1', directPort, 'direct'],
    ] as const) {
      const { response } = await handler.handle({
        protocol: 'http:',
        hostname,
        port,
        method: 'GET',
        path: '/check',
        headers: {},
      })
      const chunks: Buffer[] = []
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).toString()).toBe(expected)
    }
    expect(proxied).toEqual(['http://example.invalid/check'])
  } finally {
    handler?.destroy()
    proxy.closeAllConnections()
    direct.closeAllConnections()
    await Promise.all([
      new Promise<void>((done) => proxy.close(() => done())),
      new Promise<void>((done) => direct.close(() => done())),
    ])
  }
})

it('preserves the default transport without a proxy and refuses unsupported proxy runtimes', async () => {
  clearProxy()
  expect(Reflect.get(await resolveModel('bedrock/test'), '_client').config.requestHandler).not.toBeInstanceOf(
    NodeHttpHandler
  )
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1')
  try {
    for (const version of ['22.20.0', '23.0.0', '24.4.0']) {
      Object.defineProperty(process.versions, 'node', { value: version })
      await expect(resolveModel('bedrock/test')).rejects.toThrow('Bedrock proxy support requires Node')
    }
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor)
  }
})
