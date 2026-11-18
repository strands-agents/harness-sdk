Use a workflow when you know which steps should run and in what order. Your application calls each agent, passes its result to the next step, and decides how to handle failures. Each agent can have its own instructions, model, and tools.

For a short sequence, ordinary function calls are enough. Define a [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md) when you need to express dependencies across parallel branches or route results through conditional edges. To let an agent construct and run a task graph through a tool call, use the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md).

## Pass results from one agent to the next

This workflow extracts facts from incident notes, analyzes those facts, and writes a report. The agents receive the information they need through their prompts; your code fixes the order of the calls.

Before running the example, install the SDK and configure a model provider as shown in the [quickstart](/docs/user-guide/sdk/quickstart/overview/index.md).

> **Diagram:** A sequential workflow controlled by application code. Incident notes go to the researcher to extract facts. Those facts go to the analyst to analyze. The analysis goes to the writer to write a report. The code calls each agent in turn.

(( tab "Python" ))
```python
from strands import Agent


def process_workflow(notes: str) -> str:
    researcher = Agent(
        system_prompt="Extract the facts in the supplied incident notes.",
        callback_handler=None,
    )
    analyst = Agent(
        system_prompt="Analyze the supplied facts. Distinguish causes from guesses.",
        callback_handler=None,
    )
    writer = Agent(
        system_prompt="Write a concise incident report from the supplied analysis.",
        callback_handler=None,
    )

    facts = researcher(f"Extract facts from these notes:\n{notes}")
    analysis = analyst(f"Analyze these incident facts:\n{facts}")
    report = writer(f"Write a report from this analysis:\n{analysis}")
    return str(report)


# Fictional notes keep the example independent of external data sources.
notes = (
    "09:00: deployed version 2.3. 09:05: checkout errors increased. "
    "09:12: rolled back to version 2.2. 09:15: error rate returned to normal. "
    "Root cause has not been confirmed."
)
print(process_workflow(notes))
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'

async function processWorkflow(notes: string): Promise<string> {
  const researcher = new Agent({
    systemPrompt: 'Extract the facts in the supplied incident notes.',
    printer: false,
  })
  const analyst = new Agent({
    systemPrompt: 'Analyze the supplied facts. Distinguish causes from guesses.',
    printer: false,
  })
  const writer = new Agent({
    systemPrompt: 'Write a concise incident report from the supplied analysis.',
    printer: false,
  })

  const facts = await researcher.invoke(`Extract facts from these notes:\n${notes}`)
  const analysis = await analyst.invoke(`Analyze these incident facts:\n${facts}`)
  const report = await writer.invoke(`Write a report from this analysis:\n${analysis}`)
  return report.toString()
}

// Fictional notes keep the example independent of external data sources.
const notes =
  '09:00: deployed version 2.3. 09:05: checkout errors increased. ' +
  '09:12: rolled back to version 2.2. 09:15: error rate returned to normal. ' +
  'Root cause has not been confirmed.'
console.log(await processWorkflow(notes))
```
(( /tab "TypeScript" ))

The researcher finishes before the analyst starts, and the analyst finishes before the writer starts. The report’s wording varies with the model; the order and inputs come from your application code. Creating the agents inside the function gives each run a fresh conversation.

## Decide what happens when a step fails

If an agent call raises an error in this example, the function exits and later steps do not run. Catch errors around a step when your application should retry it, ask for input, or return a partial result. Check the returned content before continuing when a successful call can still produce an unsuitable answer.

A sequence of function calls does not add workflow persistence, a shared run status, or an overall deadline. Implement the controls your application needs, or use a [Graph](/docs/user-guide/sdk/multi-agent/graph/index.md) and its orchestration APIs. The [supervised orchestrator example](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md#grow-into-a-supervised-orchestrator) shows node timeouts, an approval gate, and cancellation, including the limits of timeout enforcement.

## Let an agent construct the workflow

Use the [vended `graph` tool](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) when the agent should decide how to divide a request into sub-tasks. The model supplies nodes and dependency edges; the tool creates the agents, runs independent nodes in parallel, and passes upstream outputs to downstream nodes.

The tool accepts acyclic graphs. Configure it to constrain the graph’s size and the instructions, models, and tools available to its nodes. For a fixed sequence like the example above, keep the calls in your application. For cycles or conditional edges that your application defines, use the [Graph SDK API](/docs/user-guide/sdk/multi-agent/graph/index.md).

## Related pages

- [A2A Server Configuration](/docs/user-guide/sdk/multi-agent/a2a-server-configuration/index.md) (1 shared tag)
- [Agent-to-Agent (A2A) Protocol](/docs/user-guide/sdk/multi-agent/agent-to-agent/index.md) (1 shared tag)
- [Choose a multi-agent pattern](/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md) (1 shared tag)
- [Graph Components](/docs/user-guide/sdk/multi-agent/graph-components/index.md) (1 shared tag)
- [Graph Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/graph/index.md) (1 shared tag)
- [Swarm Multi-Agent Pattern](/docs/user-guide/sdk/multi-agent/swarm/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (1 shared tag)
