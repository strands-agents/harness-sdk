import { describe, expectTypeOf, it } from 'vitest'
import { TextBlock } from '../../types/messages.js'
import { MockMessageModel, TestModelProvider } from '../index.js'
import type { MockMessageContentBlock, MockMessageTurn, MockMessageTurnOptions, ModelEventGenerator } from '../index.js'

describe('testing exports', () => {
  it('accepts plain blocks, instances, options and event factories', () => {
    const block: MockMessageContentBlock = { type: 'textBlock', text: 'Hello' }
    const turn: MockMessageTurn = [block, new TextBlock('world')]
    const options: MockMessageTurnOptions = { stopReason: 'endTurn' }
    expectTypeOf(new MockMessageModel().addTurn(turn, options)).toEqualTypeOf<MockMessageModel>()
    const factory: ModelEventGenerator = async function* () {
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    }
    expectTypeOf(new TestModelProvider(factory)).toEqualTypeOf<TestModelProvider>()
    // @ts-expect-error Serialized ContentBlockData is not the discriminated input shape.
    new MockMessageModel().addTurn({ text: 'missing type' })
    // @ts-expect-error A factory must return an async generator, not a promise.
    new TestModelProvider(async () => [])
  })
})
