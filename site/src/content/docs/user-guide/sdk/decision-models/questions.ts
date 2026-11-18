import { LLMDecisionModel, Message, TextBlock } from '@strands-agents/sdk'

async function conversationExample() {
  // --8<-- [start:conversation]
  const conversation = [
    new Message({ role: 'user', content: [new TextBlock('Where is my order 1182?')] }),
    new Message({ role: 'assistant', content: [new TextBlock('It shipped yesterday.')] }),
    new Message({
      role: 'user',
      content: [new TextBlock("I've asked three times. Cancel it.")],
    }),
  ]

  const decisions = new LLMDecisionModel()
  const result = await decisions.ask(conversation, {
    sentiment: {
      question: 'How does the customer feel?',
      choices: ['positive', 'neutral', 'negative'],
    },
  })
  console.log(result.answers.sentiment)

  // Typical output:
  // negative
  // --8<-- [end:conversation]
}
