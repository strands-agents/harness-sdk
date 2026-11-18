import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { pythonRepl, makePythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'

// Python REPL tool example
async function pythonReplExample() {
  // --8<-- [start:python_repl_example]
  const agent = new Agent({ tools: [pythonRepl] })
  await agent.invoke(
    'Use python_repl to compute the first 10 Fibonacci numbers and print them.'
  )
  // --8<-- [end:python_repl_example]
}

// Python REPL tool with a bound sandbox and custom interpreter
async function pythonReplCustomExample() {
  // --8<-- [start:python_repl_custom_example]
  const pythonRepl = makePythonRepl(new DockerSandbox({ container: 'my-container' }), {
    language: 'python3.12',
  })
  const agent = new Agent({ tools: [pythonRepl] })
  // --8<-- [end:python_repl_custom_example]
}
