import readline from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
import { setInterval, setTimeout } from 'node:timers'

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
const exitMarkerIndex = process.argv.indexOf('--exit-marker')
const exitMarker = exitMarkerIndex >= 0 ? process.argv[exitMarkerIndex + 1] : undefined
const startMarkerIndex = process.argv.indexOf('--start-marker')
const startMarker = startMarkerIndex >= 0 ? process.argv[startMarkerIndex + 1] : undefined
const connectionDelayIndex = process.argv.indexOf('--connection-delay')
const connectionDelay = connectionDelayIndex >= 0 ? Number(process.argv[connectionDelayIndex + 1]) : 0
const stopDelayIndex = process.argv.indexOf('--stop-delay')
const stopDelay = stopDelayIndex >= 0 ? Number(process.argv[stopDelayIndex + 1]) : 0
const stopMarkerIndex = process.argv.indexOf('--stop-marker')
const stopMarker = stopMarkerIndex >= 0 ? process.argv[stopMarkerIndex + 1] : undefined
const eventsPath = process.env.STRANDS_VOICE_TEST_EVENTS
let muted = process.argv.includes('--muted')
const supervisorResultMarkerIndex = process.argv.indexOf('--supervisor-result-marker')
const supervisorResultMarker =
  supervisorResultMarkerIndex >= 0 ? process.argv[supervisorResultMarkerIndex + 1] : undefined

if (startMarker) {
  writeFileSync(startMarker, 'started\n')
}
if (eventsPath) {
  appendFileSync(eventsPath, `${JSON.stringify({ type: 'startup', pid: process.pid, muted })}\n`)
}

function exit() {
  if (exitMarker) {
    writeFileSync(exitMarker, 'stopped\n')
  }
  process.exit(0)
}

if (!process.argv.includes('--no-connection')) {
  setTimeout(() => {
    emit({ type: 'connection_start', model: 'test-sonic' })
    if (process.env.STRANDS_VOICE_TEST_STALL_INPUT !== '1') {
      setInterval(
        () =>
          emit({
            type: 'input_level',
            level: muted ? 0 : Number(process.env.STRANDS_VOICE_TEST_INPUT_LEVEL ?? 0.58),
            db: muted ? -60 : -25.2,
          }),
        80
      )
    }
  }, connectionDelay)
}

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
  if (!process.argv.includes('--stall-reconnect')) {
    setTimeout(() => {
      emit({ type: 'connection_start', model: 'test-sonic' })
    }, 40)
  }
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
    muted = command.muted === true
    emit({ type: 'mute_changed', muted })
  } else if (command.type === 'narrate') {
    if (eventsPath) appendFileSync(eventsPath, `${JSON.stringify({ type: 'narration', text: command.text })}\n`)
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
    if (process.argv.includes('--ignore-stop')) return
    if (stopMarker) writeFileSync(stopMarker, 'stopping\n')
    if (process.argv.includes('--supervisor-during-stop')) {
      emit({
        type: 'supervisor_request',
        request_id: 'late-request',
        action: 'send_instruction',
        instruction: 'This request arrived during shutdown',
      })
      emit({ type: 'speech_output_start' })
    }
    setTimeout(exit, stopDelay)
  }
})

process.on('SIGTERM', process.argv.includes('--ignore-stop') ? () => {} : exit)
