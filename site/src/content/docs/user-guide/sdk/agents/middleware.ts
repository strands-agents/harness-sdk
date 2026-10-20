import { Agent, InvokeModelStage, ExecuteToolStage } from '@strands-agents/sdk'
import { ModelThrottledError, BedrockModel } from '@strands-agents/sdk'
import { ToolResultBlock, TextBlock } from '@strands-agents/sdk'
import type { InvokeModelResult } from '@strands-agents/sdk'

async function registerWrapScope() {
  // --8<-- [start:register_wrap]
  const agent = new Agent()

  agent.addMiddleware(InvokeModelStage, async function* (context, next) {
    const start = Date.now()
    const result = yield* next(context)
    console.log(`model call took ${Date.now() - start}ms`)
    return result
  })
  // --8<-- [end:register_wrap]
}

async function registerInputScope() {
  // --8<-- [start:register_input]
  const agent = new Agent()

  agent.addMiddleware(InvokeModelStage.Input, (context) => ({
    ...context,
    systemPrompt: 'Be concise.',
  }))
  // --8<-- [end:register_input]
}

async function registerOutputScope() {
  // --8<-- [start:register_output]
  const agent = new Agent()

  agent.addMiddleware(InvokeModelStage.Output, (result) => {
    console.log(`model stopped with reason ${result.result.stopReason}`)
    return result
  })
  // --8<-- [end:register_output]
}

async function retryScope() {
  // --8<-- [start:retry]
  const agent = new Agent()

  agent.addMiddleware(InvokeModelStage, async function* (context, next) {
    for (let attempt = 0; ; attempt++) {
      try {
        return yield* next(context)
      } catch (error) {
        if (!(error instanceof ModelThrottledError) || attempt >= 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
      }
    }
  })
  // --8<-- [end:retry]
}

async function cacheScope() {
  // --8<-- [start:cache]
  const agent = new Agent()
  const responseCache = new Map<string, InvokeModelResult>()

  agent.addMiddleware(InvokeModelStage, async function* (context, next) {
    const key = JSON.stringify(context.messages)
    const cached = responseCache.get(key)
    if (cached) return cached

    const result = yield* next(context)
    responseCache.set(key, result)
    return result
  })
  // --8<-- [end:cache]
}

async function modelRoutingScope() {
  // --8<-- [start:model_routing]
  const agent = new Agent()
  const largeContextModel = new BedrockModel({
    modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  })

  agent.addMiddleware(InvokeModelStage.Input, (context) =>
    (context.projectedInputTokens ?? 0) > 50_000
      ? { ...context, model: largeContextModel }
      : context
  )
  // --8<-- [end:model_routing]
}

async function toolGateScope() {
  // --8<-- [start:tool_gate]
  const agent = new Agent()

  agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
    const { response } = context.interrupt<string>({
      name: 'approve_tool',
      reason: `Run ${context.toolUse.name}?`,
    })

    if (response !== 'approved') {
      return {
        result: new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'error',
          content: [new TextBlock('Denied by reviewer')],
        }),
      }
    }
    return yield* next(context)
  })
  // --8<-- [end:tool_gate]
}

// Suppress unused function warnings
void registerWrapScope
void registerInputScope
void registerOutputScope
void retryScope
void cacheScope
void modelRoutingScope
void toolGateScope
