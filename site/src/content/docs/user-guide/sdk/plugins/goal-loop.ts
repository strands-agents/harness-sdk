import { Agent, Message } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk'
import {
  GoalLoop,
  ValidationOutcome,
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_OUTCOME_SCHEMA,
} from '@strands-agents/sdk/vended-plugins/goal'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

// =====================
// Getting Started
// =====================

{
  // --8<-- [start:getting_started]
  const concise = new GoalLoop({
    goal: 'At most 3 sentences, accessible to a 10-year-old, ' + 'no jargon.',
    maxAttempts: 3,
  })

  const agent = new Agent({ plugins: [concise] })
  await agent.invoke('Explain how rainbows form.')
  console.log(concise.lastResult(agent))

  // Typical output:
  // { passed: true, stopReason: 'satisfied', attempts: [...] }
  // --8<-- [end:getting_started]

  void agent
}

// =====================
// Inspecting Results
// =====================

{
  const plugin = new GoalLoop({
    goal: 'Be concise.',
    maxAttempts: 3,
  })
  const agent = new Agent({ plugins: [plugin] })

  // --8<-- [start:inspecting_results]
  const result = plugin.lastResult(agent)
  if (result && !result.passed) {
    console.log(`Stopped after ${result.attempts.length} attempts`)
    console.log(`Reason: ${result.stopReason}`)
    for (const attempt of result.attempts) {
      console.log(`  #${attempt.attempt}: ${attempt.feedback}`)
    }
  }
  // --8<-- [end:inspecting_results]
}

// =====================
// Word Count Validator
// =====================

{
  // --8<-- [start:word_count_validator]
  function wordCountValidator(response: Message) {
    const text = response.content
      .flatMap((b) => (b.type === 'textBlock' ? [b.text] : []))
      .join(' ')
    const words = text.trim().split(/\s+/).length
    if (words <= 50) return true
    return { passed: false, feedback: `Too long (${words} words). Cap at 50.` }
  }

  const plugin = new GoalLoop({
    goal: wordCountValidator,
    maxAttempts: 5,
    timeout: 30_000,
  })
  // --8<-- [end:word_count_validator]

  void plugin
}

// =====================
// Async Validator
// =====================

{
  // --8<-- [start:async_validator]
  const plugin = new GoalLoop({
    goal: async () => {
      try {
        await execAsync('npm test')
        return true
      } catch (err) {
        const e = err as {
          stdout?: string
          stderr?: string
        }
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-4000)
        return {
          passed: false,
          feedback: `Tests failed.\n${out}`,
        }
      }
    },
    maxAttempts: 10,
  })
  // --8<-- [end:async_validator]

  void plugin
}

// =====================
// Preserve Context False
// =====================

{
  const testsPass = async () => true

  // --8<-- [start:preserve_context_false]
  const plugin = new GoalLoop({
    goal: testsPass,
    maxAttempts: 10,
    preserveContext: false,
  })
  // --8<-- [end:preserve_context_false]

  void plugin
}

// =====================
// Judge Config
// =====================

{
  // --8<-- [start:judge_config]
  const plugin = new GoalLoop({
    goal: 'Response must cite at least two sources.',
    maxAttempts: 3,
    judge: {
      model: new BedrockModel({
        modelId: 'us.amazon.nova-lite-v1:0',
      }),
    },
  })
  // --8<-- [end:judge_config]

  void plugin
}

// =====================
// Custom Resume Prompt
// =====================

{
  // --8<-- [start:custom_resume_prompt]
  const plugin = new GoalLoop({
    goal: '...',
    maxAttempts: 3,
    resumePromptTemplate: (feedback) => {
      if (!feedback) {
        return "That didn't pass. Start over from scratch " + 'with a different approach.'
      }
      return (
        `Validation failed:\n${feedback}\n\n` +
        'Do NOT edit your previous response. Start over ' +
        'from scratch and take a completely different approach.'
      )
    },
  })
  // --8<-- [end:custom_resume_prompt]

  void plugin
}

// =====================
// Custom Judge
// =====================

{
  // --8<-- [start:custom_judge]
  const plugin = new GoalLoop({
    goal: async (_response, agent): Promise<ValidationOutcome> => {
      const judge = new Agent({
        printer: false,
        systemPrompt: JUDGE_SYSTEM_PROMPT,
      })
      const result = await judge.invoke(buildJudgePrompt('Be concise.', agent.messages), {
        structuredOutputSchema: JUDGE_OUTCOME_SCHEMA,
      })
      return (
        (result.structuredOutput as ValidationOutcome) ?? {
          passed: false,
          feedback: 'Judge produced no structured outcome.',
        }
      )
    },
    maxAttempts: 3,
  })
  // --8<-- [end:custom_judge]

  void plugin
}
