import readline from 'node:readline'
import { writeFileSync } from 'node:fs'
import { setInterval, setTimeout } from 'node:timers'

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
const exitMarkerIndex = process.argv.indexOf('--exit-marker')
const exitMarker = exitMarkerIndex >= 0 ? process.argv[exitMarkerIndex + 1] : undefined
const startMarkerIndex = process.argv.indexOf('--start-marker')
const startMarker = startMarkerIndex >= 0 ? process.argv[startMarkerIndex + 1] : undefined
const connectionDelayIndex = process.argv.indexOf('--connection-delay')
const connectionDelay = connectionDelayIndex >= 0 ? Number(process.argv[connectionDelayIndex + 1]) : 0
const supervisorResultMarkerIndex = process.argv.indexOf('--supervisor-result-marker')
const supervisorResultMarker =
  supervisorResultMarkerIndex >= 0 ? process.argv[supervisorResultMarkerIndex + 1] : undefined

if (startMarker) {
  writeFileSync(startMarker, 'started\n')
}

function exit() {
  if (exitMarker) {
    writeFileSync(exitMarker, 'stopped\n')
  }
  process.exit(0)
}

setTimeout(() => {
  emit({ type: 'connection_start', model: 'test-sonic' })
  setInterval(() => emit({ type: 'input_level', level: 0.58, db: -25.2 }), 80)
}, connectionDelay)

if (process.argv.includes('--fatal-error')) {
  setTimeout(() => emit({ type: 'fatal_error', code: 'TEST_FAILURE', message: 'simulated failure' }), 20)
}
if (process.argv.includes('--exit-error')) {
  process.stderr.write(`sidecar setup failed\n${'\n'.repeat(120)}ImportError: incompatible runtime.\n`)
  setTimeout(() => process.exit(1), 20)
}

if (process.argv.includes('--emit-transcript')) {
  setTimeout(() => {
    emit({
      type: 'transcript',
      role: 'user',
      current_transcript: 'hello',
      is_final: false,
    })
  }, 20)
  setTimeout(() => {
    emit({
      type: 'transcript',
      role: 'user',
      current_transcript: 'hello from voice',
      is_final: true,
    })
  }, 40)
}

if (process.argv.includes('--emit-restart')) {
  setTimeout(() => {
    emit({ type: 'connection_restart', reason: 'scheduled', turn_interrupted: false })
  }, 20)
  setTimeout(() => {
    emit({ type: 'connection_start', model: 'test-sonic' })
  }, 40)
}

if (process.argv.includes('--connection-stop')) {
  setTimeout(() => emit({ type: 'connection_stop', reason: 'user_request' }), 20)
}
if (process.argv.includes('--emit-supervisor-request')) {
  setTimeout(
    () =>
      emit({
        type: 'supervisor_request',
        request_id: 'supervisor-1',
        action: 'send_instruction',
        instruction: 'inspect the parser',
      }),
    20
  )
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'set_muted') {
    emit({ type: 'mute_changed', muted: command.muted === true })
  } else if (command.type === 'narrate') {
    emit({ type: 'speech_output_start' })
    setTimeout(
      () =>
        emit({
          type: process.argv.includes('--interrupt-speech') ? 'speech_output_interrupted' : 'speech_output_complete',
        }),
      150
    )
  } else if (command.type === 'stop_speaking') {
    emit({ type: 'speech_output_stopped' })
  } else if (command.type === 'supervisor_result' && supervisorResultMarker) {
    writeFileSync(supervisorResultMarker, JSON.stringify(command))
  } else if (command.type === 'stop') {
    exit()
  }
})

process.on('SIGTERM', exit)
