import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LiteLLMModel } from '@strands-agents/sdk/models/litellm'
import { Message, TextBlock } from '@strands-agents/sdk'
import type { ModelStreamEvent } from '@strands-agents/sdk'

const LITELLM_IMAGE = 'docker.litellm.ai/berriai/litellm:main-latest'
const PROXY_API_KEY = 'strands-litellm-smoke-key'
const EXPECTED_TEXT = 'Hello from the LiteLLM Docker gateway.'

const streamedChunks = [
  {
    id: 'chatcmpl-strands-smoke',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-strands-smoke',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: { content: EXPECTED_TEXT }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-strands-smoke',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
  },
] as const

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Unable to determine upstream server port'))
        return
      }
      resolve(address.port)
    })
  })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requestStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.setTimeout(3_000, () => request.destroy(new Error('Health request timed out')))
    request.once('error', reject)
    request.end()
  })
}

async function waitForProxy(proxyProcess: ChildProcessWithoutNullStreams, proxyUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (proxyProcess.exitCode !== null) {
      throw new Error(`LiteLLM exited before becoming ready (code ${proxyProcess.exitCode})`)
    }
    try {
      const status = await requestStatus(`${proxyUrl}/health/readiness`)
      if (status === 200) return
    } catch (error) {
      if (!(error instanceof Error)) throw error
    }
    await wait(500)
  }
  throw new Error('Timed out waiting for LiteLLM readiness')
}

function createUpstreamServer() {
  return createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    for (const chunk of streamedChunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
}

function textDelta(event: ModelStreamEvent): string {
  if (event.type !== 'modelContentBlockDeltaEvent' || event.delta.type !== 'textDelta') return ''
  return event.delta.text
}

async function main(): Promise<void> {
  const upstream = createUpstreamServer()
  const upstreamPort = await listen(upstream)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'strands-litellm-smoke-'))
  const configPath = join(temporaryDirectory, 'config.yaml')
  const proxyPort = 40_000 + Math.floor(Math.random() * 1_000)
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1`
  const containerName = `strands-litellm-smoke-${process.pid}`
  let proxyProcess: ChildProcessWithoutNullStreams | undefined

  try {
    await writeFile(
      configPath,
      `model_list:\n  - model_name: strands-smoke\n    litellm_params:\n      model: openai/fake\n      api_base: http://127.0.0.1:${upstreamPort}/v1\n      api_key: smoke-upstream-key\ngeneral_settings:\n  master_key: ${PROXY_API_KEY}\n`,
      'utf8'
    )

    proxyProcess = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--network',
        'host',
        '--volume',
        `${configPath}:/app/config.yaml:ro`,
        LITELLM_IMAGE,
        '--config',
        '/app/config.yaml',
        '--port',
        String(proxyPort),
      ],
      { stdio: 'pipe' }
    )
    proxyProcess.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[LiteLLM] ${chunk}`))

    console.log(`Waiting for LiteLLM on ${proxyUrl}`)
    await waitForProxy(proxyProcess, proxyUrl.replace('/v1', ''))
    console.log('LiteLLM is ready; sending a streamed completion')

    const model = new LiteLLMModel({
      modelId: 'strands-smoke',
      baseURL: proxyUrl,
      apiKey: PROXY_API_KEY,
      stream: true,
    })
    const messages = [new Message({ role: 'user', content: [new TextBlock('Say hello.')] })]
    let responseText = ''

    for await (const event of model.stream(messages)) {
      const delta = textDelta(event)
      responseText += delta
      if (delta) process.stdout.write(delta)
    }
    process.stdout.write('\n')

    if (responseText !== EXPECTED_TEXT) {
      throw new Error(`Unexpected streamed response: ${JSON.stringify(responseText)}`)
    }
    console.log('LiteLLM Docker smoke test passed')
  } finally {
    if (proxyProcess?.exitCode === null) {
      proxyProcess.kill('SIGTERM')
    }
    upstream.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

await main()
