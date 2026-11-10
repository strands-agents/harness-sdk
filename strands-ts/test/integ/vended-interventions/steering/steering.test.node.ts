import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, tool } from '$/sdk/index.js'
import { guide, proceed, type Guide, type Proceed } from '$/sdk/interventions/actions.js'
import { SteeringHandler, ToolLedgerProvider } from '$/sdk/vended-interventions/steering/index.js'
import type { BeforeToolCallEvent } from '$/sdk/hooks/events.js'
import { bedrock } from '../../__fixtures__/model-providers.js'

const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email to a recipient',
  inputSchema: z.object({ recipient: z.string(), message: z.string() }),
  callback: async ({ recipient, message }) => `Email sent to ${recipient}: ${message}`,
})

const sendNotification = tool({
  name: 'send_notification',
  description: 'Send a notification to a recipient',
  inputSchema: z.object({ recipient: z.string(), message: z.string() }),
  callback: async ({ recipient, message }) => `Notification sent to ${recipient}: ${message}`,
})

describe.skipIf(bedrock.skip)('Steering integration', () => {
  const createModel = () => bedrock.createModel({ maxTokens: 1024 })

  it('redirects send_email to send_notification via Guide', async () => {
    class RedirectEmailHandler extends SteeringHandler {
      override readonly name = 'redirect-email'
      override async beforeToolCall(event: BeforeToolCallEvent): Promise<Guide | Proceed> {
        if (event.toolUse.name === 'send_email') {
          return guide('Use send_notification instead of send_email for better delivery.')
        }
        return proceed()
      }
    }

    const agent = new Agent({
      model: createModel(),
      tools: [sendEmail, sendNotification],
      interventions: [new RedirectEmailHandler()],
      systemPrompt:
        'You are a helpful assistant. When a tool call is cancelled with guidance, follow the guidance and use the suggested alternative tool.',
      printer: false,
    })

    const result = await agent.invoke('Send an email to john@example.com saying hello')

    const toolMetrics = result.metrics?.toolMetrics ?? {}

    if (toolMetrics.send_email) {
      expect(toolMetrics.send_email.callCount).toBeGreaterThanOrEqual(1)
      expect(toolMetrics.send_email.successCount).toBe(0)
    }

    expect(toolMetrics.send_notification).toBeDefined()
    expect(toolMetrics.send_notification!.callCount).toBeGreaterThanOrEqual(1)
    expect(toolMetrics.send_notification!.successCount).toBeGreaterThanOrEqual(1)
  })

  it('ToolLedgerProvider captures tool calls during a real invocation', async () => {
    const ledger = new ToolLedgerProvider()

    class LedgerCheckingHandler extends SteeringHandler {
      override readonly name = 'ledger-check'

      override async beforeToolCall(event: BeforeToolCallEvent): Promise<Proceed> {
        const calls = (ledger.context.calls ?? []) as Array<Record<string, unknown>>
        const current = calls.find((c) => c.name === event.toolUse.name)
        expect(current).toBeDefined()
        expect(current?.args).toEqual(event.toolUse.input)
        expect(current?.status).toBe('pending')
        return proceed()
      }
    }

    const handler = new LedgerCheckingHandler({ contextProviders: [ledger] })

    const agent = new Agent({
      model: createModel(),
      tools: [sendNotification],
      interventions: [handler],
      printer: false,
    })

    await agent.invoke('Send a notification to alice saying test message')

    const calls = (ledger.context.calls ?? []) as Array<Record<string, unknown>>
    expect(calls.length).toBeGreaterThanOrEqual(1)

    const last = calls[calls.length - 1]!
    expect(last.name).toBe('send_notification')
    const args = last.args as Record<string, string>
    expect(args.recipient).toBe('alice')
    expect(args.message).toContain('test message')
    expect(last.status).toBe('success')
    expect(last.endTime).toBeTypeOf('string')
    expect(last.error).toBeNull()
  })
})
