import { describe, expect, it, vi } from 'vitest'

vi.mock('@aws-sdk/client-sagemaker-runtime', () => {
  throw new Error("Cannot find package '@aws-sdk/client-sagemaker-runtime'")
})

import { SageMakerDecisionModel } from '../sagemaker-decision-model.js'

describe('SageMakerDecisionModel without @aws-sdk/client-sagemaker-runtime', () => {
  it('rejects with install guidance and the import failure as cause', async () => {
    const decision = new SageMakerDecisionModel({ endpointName: 'my-decider-endpoint' })

    const error = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/npm install '@aws-sdk\/client-sagemaker-runtime'/)
    expect((error as Error).cause).toBeInstanceOf(Error)
  })
})
