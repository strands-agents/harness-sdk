When your agent’s response needs to meet a quality bar before returning, `GoalLoop` handles the retry loop. It validates the response after each invocation, feeds feedback back as a user message on failure, and re-invokes the agent. This continues until validation passes, a max attempt count is reached, or a timeout elapses.

## The Problem

A single-pass agent response often misses the mark: too verbose, wrong format, incomplete reasoning, or failing a test suite. You could wrap the agent call in a manual retry loop, but that means reimplementing timeout logic, attempt tracking, feedback injection, and state management every time.

GoalLoop handles all of that as a plugin. Define what “done” means, attach it to your agent, and the retry loop runs automatically inside the existing hook lifecycle.

## How It Works

> **Diagram:** The GoalLoop retry cycle. Your prompt goes to the agent, which produces a response. GoalLoop passes the response to the validator, either the built-in judge agent or your own function. If the validator fails the response and budget remains, its feedback goes back to the agent as a new user message and the agent responds again. The loop ends when the validator passes, or when the attempt limit or timeout runs out; either way, the last response is returned. The timeout is checked when each attempt finishes, before validation, so a late response is returned without being validated.

1.  The agent processes the prompt and produces a response.
2.  GoalLoop extracts the last assistant message and runs the validator.
3.  If the validator passes, the loop terminates with a “satisfied” result.
4.  If the validator fails and budget remains, GoalLoop injects feedback as a new user message and re-invokes the agent.
5.  If the attempt limit or timeout is exhausted, the loop terminates without retrying.

## Getting Started

Pass a natural-language goal string. GoalLoop builds an internal judge agent (using the host agent’s `aux_model``auxModel`) that grades each response against the goal and returns structured feedback on failure.

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_plugins.goal import GoalLoop

concise = GoalLoop(
    goal="At most 3 sentences, accessible to a 10-year-old, "
         "no jargon.",
    max_attempts=3,
)

agent = Agent(plugins=[concise])
result = agent("Explain how rainbows form.")
print(concise.last_result(agent))

# Typical output:
# GoalResult(passed=True, stop_reason='satisfied', attempts=[...])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

const concise = new GoalLoop({
  goal: 'At most 3 sentences, accessible to a 10-year-old, ' + 'no jargon.',
  maxAttempts: 3,
})

const agent = new Agent({ plugins: [concise] })
await agent.invoke('Explain how rainbows form.')
console.log(concise.lastResult(agent))

// Typical output:
// { passed: true, stopReason: 'satisfied', attempts: [...] }
```
(( /tab "TypeScript" ))

## Programmatic Validators

For checks that don’t need a language model (word count, schema conformance, test suite exit codes), pass a function as `goal`. This skips the judge agent entirely.

A validator receives the last assistant message and the host agent. It returns:

-   `true` / `false` (shorthand: pass or fail with no feedback)
-   A dict/object with `passed` and optional `feedback`
-   A `ValidationOutcome` instance

(( tab "Python" ))
```python
from strands.vended_plugins.goal import GoalLoop

def word_count_validator(response, agent):
    text = " ".join(
        block["text"]
        for block in response["content"]
        if "text" in block
    )
    words = len(text.split())
    if words <= 50:
        return True
    return {
        "passed": False,
        "feedback": f"Too long ({words} words). Cap at 50.",
    }

plugin = GoalLoop(
    goal=word_count_validator,
    max_attempts=5,
    timeout=30.0,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Message } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

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
```
(( /tab "TypeScript" ))

Async validators work too. Run a test suite, call an external API, or await any I/O inside the validator:

(( tab "Python" ))
```python
import asyncio
from strands.vended_plugins.goal import GoalLoop

async def tests_pass(response, agent):
    proc = await asyncio.create_subprocess_exec(
        "pytest", "--tb=short",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode == 0:
        return True
    output = (stdout.decode() + stderr.decode())[-4000:]
    return {
        "passed": False,
        "feedback": f"pytest exited {proc.returncode}.\n{output}",
    }

plugin = GoalLoop(goal=tests_pass, max_attempts=10)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

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
```
(( /tab "TypeScript" ))

## Configuration Reference

(( tab "Python" ))
| Parameter | Default | Description |
| --- | --- | --- |
| `goal` | *(required)* | Natural-language string (judged by internal agent) or callable validator |
| `max_attempts` | `inf` | Maximum attempts before stopping |
| `timeout` | `inf` | Wall-clock budget in **seconds** for the entire run |
| `judge` | `None` | `JudgeConfig` with optional `model` and `system_prompt` for the NL judge |
| `preserve_context` | `True` | Keep conversation history across retries |
| `resume_prompt_template` | *(built-in)* | `Callable[[str | None], str | list[ContentBlock]]` that builds the retry message |
| `name` | `"strands:goal-loop"` | Plugin name (must be unique per agent) |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Parameter | Default | Description |
| --- | --- | --- |
| `goal` | *(required)* | Natural-language string (judged by internal agent) or `Validator` function |
| `maxAttempts` | `Infinity` | Maximum attempts before stopping |
| `timeout` | `Infinity` | Wall-clock budget in **milliseconds** for the entire run |
| `judge` | `undefined` | `JudgeConfig` with optional `model` and `systemPrompt` for the NL judge |
| `preserveContext` | `true` | Keep conversation history across retries |
| `resumePromptTemplate` | *(built-in)* | `(feedback: string | undefined) => string | ContentBlock[]` that builds the retry message |
| `name` | `"strands:goal-loop"` | Plugin name (must be unique per agent) |
(( /tab "TypeScript" ))

When both the attempt limit and timeout are left unbounded (the defaults), the plugin warns at construction time. Set at least one bound in production to prevent runaway loops.

## Advanced Usage

### Inspecting Results

After an invocation completes, retrieve the result from the plugin to get the full attempt history:

(( tab "Python" ))
```python
result = plugin.last_result(agent)
if result and not result.passed:
    print(f"Stopped after {len(result.attempts)} attempts")
    print(f"Reason: {result.stop_reason}")
    for attempt in result.attempts:
        print(f"  #{attempt.attempt}: {attempt.feedback}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const result = plugin.lastResult(agent)
if (result && !result.passed) {
  console.log(`Stopped after ${result.attempts.length} attempts`)
  console.log(`Reason: ${result.stopReason}`)
  for (const attempt of result.attempts) {
    console.log(`  #${attempt.attempt}: ${attempt.feedback}`)
  }
}
```
(( /tab "TypeScript" ))

The result is `None``undefined` before the first completed run and while a run is in-flight. It resets at the start of each new invocation.

### Stateless Retries

By default, the agent sees its own prior attempts and the validator’s feedback, letting it build on previous work. Disable context preservation to restore the agent’s full session state (messages, system prompt, model state) to the snapshot captured immediately before the first model call. Each retry starts fresh, seeing only the original input plus the latest feedback. Use this when prior attempts would confuse the model rather than help it.

(( tab "Python" ))
```python
plugin = GoalLoop(
    goal=tests_pass,
    max_attempts=10,
    preserve_context=False,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const plugin = new GoalLoop({
  goal: testsPass,
  maxAttempts: 10,
  preserveContext: false,
})
```
(( /tab "TypeScript" ))

The snapshot excludes agent state (`state``appState`) deliberately: other plugins (rate limiters, cost trackers) rely on their mutations persisting across attempts.

### Custom Judge Configuration

When `goal` is a string, GoalLoop builds a judge agent using the host agent’s `aux_model``auxModel`. Override the model or system prompt to tune cost and behavior:

(( tab "Python" ))
```python
from strands.models.bedrock import BedrockModel
from strands.vended_plugins.goal import GoalLoop, JudgeConfig

plugin = GoalLoop(
    goal="Response must cite at least two sources.",
    max_attempts=3,
    judge=JudgeConfig(
        model=BedrockModel(model_id="us.amazon.nova-lite-v1:0"),
    ),
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { BedrockModel } from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

const plugin = new GoalLoop({
  goal: 'Response must cite at least two sources.',
  maxAttempts: 3,
  judge: {
    model: new BedrockModel({
      modelId: 'us.amazon.nova-lite-v1:0',
    }),
  },
})
```
(( /tab "TypeScript" ))

### Custom Resume Prompt

Override how feedback is injected before each retry. The template receives the trimmed feedback string (or `None``undefined` when the validator gave none) and returns the user message content:

(( tab "Python" ))
```python
def start_over_prompt(feedback):
    if not feedback:
        return "That didn't pass. Start over from scratch with a different approach."
    return (
        f"Validation failed:\n{feedback}\n\n"
        "Do NOT edit your previous response. Start over from scratch "
        "and take a completely different approach."
    )

plugin = GoalLoop(
    goal="...",
    max_attempts=3,
    resume_prompt_template=start_over_prompt,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
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
```
(( /tab "TypeScript" ))

### Building a Custom Judge

The judge primitives are exported for use in function validators. Build your own judge with a custom model or prompt while reusing the same transcript format:

(( tab "Python" ))
```python
from strands.vended_plugins.goal import (
    GoalLoop,
    build_judge_prompt,
    JUDGE_SYSTEM_PROMPT,
    JudgeOutcome,
)

async def custom_judge(response, agent):
    from strands import Agent as JudgeAgent
    from strands.models.bedrock import BedrockModel

    judge = JudgeAgent(
        model=BedrockModel(model_id="us.amazon.nova-lite-v1:0"),
        callback_handler=None,
        system_prompt=JUDGE_SYSTEM_PROMPT,
        structured_output_model=JudgeOutcome,
    )
    prompt = build_judge_prompt("Be concise.", agent.messages)
    result = await judge.invoke_async(prompt)
    outcome = result.structured_output
    return {"passed": outcome.passed, "feedback": outcome.feedback}

plugin = GoalLoop(goal=custom_judge, max_attempts=3)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import {
  GoalLoop,
  ValidationOutcome,
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_OUTCOME_SCHEMA,
} from '@strands-agents/sdk/vended-plugins/goal'

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
```
(( /tab "TypeScript" ))

## Limitations

-   **One GoalLoop per agent.** Attaching a second instance throws at initialization. Compose multiple constraints in a single validator function instead.
-   **Timeout is checked between attempts, not mid-stream.** An in-flight model call runs to completion before timeout fires, so actual wall-clock may exceed the budget by one attempt’s duration.
-   **NL judge cost.** Each failed attempt spawns a fresh judge agent invocation. For cost-sensitive workloads, use a cheaper model via `judge.model` or switch to a programmatic validator.

## Related pages

- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (3 shared tags)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (2 shared tags)
- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (2 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (2 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (2 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (2 shared tags)
- [Instruction following evaluator](/docs/user-guide/evals-sdk/evaluators/instruction_following_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_plugins/goal/plugin.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py)
- [harness-sdk/strands-py/src/strands/vended_plugins/goal/judge.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/judge.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-plugins/goal/plugin.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-plugins/goal/plugin.ts)
- [harness-sdk/strands-ts/src/vended-plugins/goal/judge.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-plugins/goal/judge.ts)
