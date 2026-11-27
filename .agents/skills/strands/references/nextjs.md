# Use Strands in Next.js

## Install

```bash
npm install @strands-agents/sdk
```

In an existing Next.js project, configure the deployment to use Node.js 22 or later.
The default model provider is Amazon Bedrock. Configure AWS credentials or select
another supported model provider.

## Add an App Router handler

Create `app/api/agent/route.ts`:

```typescript
import { Agent } from '@strands-agents/sdk'

export const runtime = 'nodejs'

function createAgent(): Agent {
  return new Agent({
    systemPrompt: 'You are a helpful assistant.',
    printer: false,
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as { prompt?: unknown }
  const prompt = body.prompt

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json(
      { error: 'prompt must be a non-empty string' },
      { status: 400 },
    )
  }

  const agent = createAgent()
  const result = await agent.invoke(prompt, {
    cancelSignal: req.signal,
  })
  const response = result.lastMessage.content
    .flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
    .join('')

  return Response.json({
    response,
    stopReason: result.stopReason,
  })
}
```

`runtime = 'nodejs'` is required because the SDK does not target the Edge runtime.
Configure the deployment to use Node.js 22 or later.

Do not place an `Agent` at module scope. Next.js can process concurrent requests in
one server process, while each agent permits only one active invocation and owns
mutable message history.

For persistent conversations, restore session state into a new agent for each request
or serialize access to a conversation-specific agent. Do not rely on serverless module
state.

## Stream generated text

Replace the earlier JSON route handler with this complete streaming handler:

```typescript
import { Agent } from '@strands-agents/sdk'

export const runtime = 'nodejs'

function createAgent(): Agent {
  return new Agent({
    systemPrompt: 'You are a helpful assistant.',
    printer: false,
  })
}

export async function POST(req: Request) {
  const body = (await req.json()) as { prompt?: unknown }
  const prompt = body.prompt

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json(
      { error: 'prompt must be a non-empty string' },
      { status: 400 },
    )
  }

  const agent = createAgent()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of agent.stream(prompt, {
          cancelSignal: req.signal,
        })) {
          if (
            event.type === 'modelStreamUpdateEvent' &&
            event.event.type === 'modelContentBlockDeltaEvent' &&
            event.event.delta.type === 'textDelta'
          ) {
            const data = JSON.stringify({ text: event.event.delta.text })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          }
        }
      } catch (error) {
        controller.error(error)
        return
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
```

Passing `req.signal` cancels the Strands invocation when the request lifecycle ends.
This response uses ordinary server-sent events, not the Vercel AI SDK UI data-stream
protocol. Clients such as `useChat` need an adapter.
