import { createInterface } from 'node:readline'

import { loadTypescriptProject } from '../../project/typescript.js'
import { errorMessage } from '../../terminal/text.js'
import {
  createTemporaryTypescriptRunner,
  type TemporaryRunnerReply,
  type TemporaryRunnerRequest,
} from './typescript-runner.js'

const protocol = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

const send = (message: TemporaryRunnerReply): void => void protocol(`${JSON.stringify(message)}\n`)

const [entrypoint, root] = process.argv.slice(2)

const loadRunner = async (): Promise<
  (request: TemporaryRunnerRequest) => Promise<TemporaryRunnerReply | undefined>
> => {
  if (!entrypoint || !root) throw new Error('Usage: typescript-runner-main.js <agent file> <project root>')
  const project = await loadTypescriptProject({ root, entrypoint, language: 'typescript' })
  return createTemporaryTypescriptRunner(project)
}

const runner = loadRunner()
runner.catch(() => undefined)

const answer = async (line: string): Promise<void> => {
  let request: TemporaryRunnerRequest
  try {
    request = JSON.parse(line) as TemporaryRunnerRequest
  } catch {
    process.stderr.write(`typescript runner ignored a line that is not JSON: ${line.slice(0, 200)}\n`)
    return
  }
  try {
    const reply = await (await runner)(request)
    if (reply) send({ ...reply, id: request.id })
  } catch (error) {
    send({ id: request.id, error: errorMessage(error) })
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => void answer(line))
lines.on('close', () => process.exit(0))
