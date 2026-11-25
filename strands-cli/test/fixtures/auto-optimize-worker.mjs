// Stands in for the strands that auto-optimize starts: it prints its arguments and its request, then ends as told.
import { writeFileSync } from 'node:fs'

let request = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (request += chunk))
process.stdin.on('end', () => {
  process.stdout.write(`arguments: ${JSON.stringify(process.argv.slice(2))}\n`)
  process.stdout.write(`cwd: ${process.cwd()}\n`)
  process.stdout.write(`prepared: ${process.env.STRANDS_DEV_PROJECT_PREPARED}\n`)
  process.stderr.write(`request: ${request}\n`)
  const [mode, value] = request.split(' ')
  if (mode === 'exit') process.exit(Number(value))
  if (mode === 'wait') {
    writeFileSync(value, String(process.pid))
    setInterval(() => undefined, 1000)
  }
})
