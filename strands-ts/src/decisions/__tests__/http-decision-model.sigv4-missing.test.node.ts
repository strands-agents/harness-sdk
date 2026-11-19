import { describe, expect, it, vi } from 'vitest'

import { HttpDecisionModel } from '../http-decision-model.js'

vi.mock('@smithy/signature-v4', () => {
  throw new Error('Cannot find package')
})

describe('HttpDecisionModel sigv4 without its optional packages', () => {
  it('names the missing package and how to install it', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
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

    await expect(
      decision.ask('state', { urgent: { question: 'Is this urgent?', choices: 'boolean' } })
    ).rejects.toThrow(
      "requires the '@smithy/signature-v4' package | install it with: npm install '@smithy/signature-v4'"
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
