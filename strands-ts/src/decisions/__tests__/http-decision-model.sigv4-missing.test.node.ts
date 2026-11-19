import { describe, expect, it, vi } from 'vitest'

import { HttpDecisionModel } from '../http-decision-model.js'

const missing = vi.hoisted(() => ({ remaining: 1 }))

vi.mock('@smithy/signature-v4', async (importOriginal) => {
  if (missing.remaining-- > 0) throw new Error('Cannot find package')
  return importOriginal()
})

describe('HttpDecisionModel sigv4 without its optional packages', () => {
  it('names the missing package and how to install it, and loads it once it is installed', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ model: 'm', answers: { urgent: { type: 'noul', noul: 0.9 } } }), { status: 200 })
    ) as unknown as typeof globalThis.fetch
    const decision = new HttpDecisionModel({
      endpoint: 'https://abc123.lambda-url.us-east-1.on.aws/v1/systemone',
      auth: {
        type: 'sigv4',
        region: 'us-east-1',
        service: 'lambda',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      },
      fetch,
    })
    const questions = { urgent: { question: 'Is this urgent?', choices: 'boolean' } } as const

    await expect(decision.ask('state', questions)).rejects.toThrow(
      "requires the '@smithy/signature-v4' package | install it with: npm install '@smithy/signature-v4'"
    )
    expect(fetch).not.toHaveBeenCalled()

    await expect(decision.ask('state', questions)).resolves.toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
