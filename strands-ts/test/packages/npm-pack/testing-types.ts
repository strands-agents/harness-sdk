import { MockMessageModel, TestModelProvider } from '@strands-agents/sdk/testing'
import type {
  MockMessageContentBlock,
  MockMessageTurn,
  MockMessageTurnOptions,
  ModelEventGenerator,
} from '@strands-agents/sdk/testing'

const block: MockMessageContentBlock = { type: 'textBlock', text: 'offline' }
const turn: MockMessageTurn = [block]
const options: MockMessageTurnOptions = {
  stopReason: 'endTurn',
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
}
const model = new MockMessageModel().addTurn(turn, options)
const factory: ModelEventGenerator = () => model.stream([])
new TestModelProvider(factory).setEventGenerator(factory)
const callCount: number = model.callCount
void callCount
// @ts-expect-error Serialized blocks require a discriminator before use in this API.
model.addTurn({ text: 'missing type' })
// @ts-expect-error A factory must yield model events through an async generator.
new TestModelProvider(async () => [])
