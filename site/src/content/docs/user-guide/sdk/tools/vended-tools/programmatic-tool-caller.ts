import { Agent } from '@strands-agents/sdk'
import {
  makeProgrammaticToolCaller,
  programmaticToolCaller,
  type ProgrammaticToolCallerPrintEvent,
} from '@strands-agents/sdk/vended-tools/programmatic-tool-caller'
import { read } from '@strands-agents/sdk/vended-tools/read'
import { write } from '@strands-agents/sdk/vended-tools/write'

// Programmatic tool caller example
async function programmaticToolCallerExample() {
  // --8<-- [start:programmatic_tool_caller_example]
  const agent = new Agent({ tools: [programmaticToolCaller, read] })
  await agent.invoke(
    'Count the TODOs in /app/src/agent.py, /app/src/tools.py, and /app/src/hooks.py'
  )
  // --8<-- [end:programmatic_tool_caller_example]
}

// Programmatic tool caller custom config example
async function programmaticToolCallerCustomExample() {
  // --8<-- [start:programmatic_tool_caller_custom_example]
  const programmaticToolCaller = makeProgrammaticToolCaller({
    allowedTools: ['read'], // the code can read files, but not write them
    timeout: 300_000, // 5 minutes for the whole run
    toolTimeout: 60_000, // 1 minute for each tool call the code makes
  })
  const agent = new Agent({ tools: [programmaticToolCaller, read, write] })
  // --8<-- [end:programmatic_tool_caller_custom_example]
  void agent
}

// Programmatic tool caller streaming example
async function programmaticToolCallerStreamExample() {
  // --8<-- [start:programmatic_tool_caller_stream_example]
  const agent = new Agent({ tools: [programmaticToolCaller, read], printer: false })
  const prompt =
    'Count the TODOs in /app/src/agent.py, /app/src/tools.py, and /app/src/hooks.py'
  for await (const event of agent.stream(prompt)) {
    if (event.type === 'toolStreamUpdateEvent') {
      const data = event.event.data as ProgrammaticToolCallerPrintEvent
      if (data.type === 'print') {
        process.stdout.write(data.text)
      }
    }
  }
  // --8<-- [end:programmatic_tool_caller_stream_example]
}
