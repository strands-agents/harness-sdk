# Use Strands in Express

## Install

```bash
npm install @strands-agents/sdk express
npm install --save-dev @types/express
```

The TypeScript SDK requires Node.js 22 or later. The default model provider is Amazon
Bedrock. Configure AWS credentials or select another supported model provider.

## Add a request endpoint

Create an agent for each concurrent request. An `Agent` owns mutable messages and
throws `ConcurrentInvocationError` when a second invocation overlaps it.

```typescript
import express, { type Request, type Response } from 'express'
import { Agent } from '@strands-agents/sdk'

const app = express()
app.use(express.json())

function createAgent(): Agent {
  return new Agent({
    systemPrompt: 'You are a helpful assistant.',
    printer: false,
  })
}

function disconnectSignal(res: Response) {
  const controller = new AbortController()
  const abort = () => {
    if (!res.writableEnded) controller.abort()
  }

  res.once('close', abort)

  return {
    signal: controller.signal,
    cleanup() {
      res.off('close', abort)
    },
  }
}

app.post('/ask', async (req, res) => {
  const prompt = req.body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt must be a non-empty string' })
    return
  }

  const connection = disconnectSignal(res)

  try {
    const agent = createAgent()
    const result = await agent.invoke(prompt, {
      cancelSignal: connection.signal,
    })
    const response = result.lastMessage.content
      .flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
      .join('')

    res.json({ response, stopReason: result.stopReason })
  } catch (error) {
    if (!connection.signal.aborted) {
      res.status(500).json({ error: String(error) })
    }
  } finally {
    connection.cleanup()
  }
})

app.listen(3000)
```

Express does not provide a standard `req.signal`. Connect an `AbortController` to the
request lifecycle and pass its signal to `invoke` or `stream`.

For a multi-turn conversation, keep one agent per conversation and serialize its
requests. Do not use one global agent for concurrent traffic.

## Stream generated text

```typescript
import express, { type Request, type Response } from 'express'
import { Agent } from '@strands-agents/sdk'

const app = express()
app.use(express.json())

function createAgent(): Agent {
  return new Agent({
    systemPrompt: 'You are a helpful assistant.',
    printer: false,
  })
}

function disconnectSignal(res: Response) {
  const controller = new AbortController()
  const abort = () => {
    if (!res.writableEnded) controller.abort()
  }

  res.once('close', abort)

  return {
    signal: controller.signal,
    cleanup() {
      res.off('close', abort)
    },
  }
}

app.post('/ask/stream', async (req, res) => {
  const prompt = req.body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt must be a non-empty string' })
    return
  }

  const connection = disconnectSignal(res)
  const agent = createAgent()

  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
  })
  res.flushHeaders()

  try {
    for await (const event of agent.stream(prompt, {
      cancelSignal: connection.signal,
    })) {
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        const data = JSON.stringify({ text: event.event.delta.text })
        res.write(`data: ${data}\n\n`)
      }
    }

    if (!connection.signal.aborted) res.end()
  } catch (error) {
    if (!connection.signal.aborted) {
      const data = JSON.stringify({ message: String(error) })
      res.write(`event: error\ndata: ${data}\n\n`)
      res.end()
    }
  } finally {
    connection.cleanup()
  }
})

app.listen(3000)
```

If the client needs tool and lifecycle events too, serialize the complete event
instead of filtering for text deltas.
