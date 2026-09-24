import type { ChatController } from '../chat/controller.js'
import type { ChatControllerApi, ChatPanelRow, ChatVoiceStore } from '../chat/types.js'
import { errorMessage } from '../terminal/sanitize.js'
import { VOICE_IDS, type VoiceInput, type VoiceEndpointingSensitivity, type VoiceId } from '../voice/session.js'

const STREAMING_SPEECH_MAX_CHARS = 180
const ENDPOINTING_OPTIONS = [
  { label: 'Fast', value: 'HIGH' },
  { label: 'Balanced', value: 'MEDIUM' },
  { label: 'Patient', value: 'LOW' },
] as const

export class ConversationVoice {
  readonly store?: ChatVoiceStore
  snapshot: ReturnType<VoiceInput['getSnapshot']> | undefined
  private readonly _listeners = new Set<() => void>()
  private readonly _voiceUnsubscribers: (() => void)[] = []
  private _pendingVoiceInput: string[] | undefined

  constructor(
    private readonly _voice: VoiceInput | undefined,
    private readonly _active: () => { id: string; controller: ChatController },
    private readonly _panels: {
      panel(rows?: ChatPanelRow[]): void
      error(title: string, label: string, message: string): void
    }
  ) {
    this.snapshot = _voice?.getSnapshot()
    if (_voice) {
      this.store = {
        subscribe: (listener): (() => void) => {
          this._listeners.add(listener)
          return () => {
            this._listeners.delete(listener)
          }
        },
        getSnapshot: (): ReturnType<VoiceInput['getSnapshot']> => this.snapshot!,
      }
    }
  }

  connect(onChange: () => void): void {
    if (this._voice) {
      this._voiceUnsubscribers.push(
        this._voice.subscribe(() => {
          const previous = this.snapshot!
          this.snapshot = this._voice!.getSnapshot()
          for (const listener of this._listeners) {
            listener()
          }
          if (sameVoiceState(previous, this.snapshot)) {
            return
          }
          onChange()
        }),
        this._voice.onSpeechStart(() => {
          if (!this._pendingVoiceInput && this._active().controller.busy) {
            this._active().controller.cancel()
          }
        }),
        this._voice.onTranscript((transcript) => {
          if (this._pendingVoiceInput) {
            this._pendingVoiceInput.push(transcript)
          } else {
            void this._active().controller.steer(transcript)
          }
        })
      )
    }
  }

  pauseInput(): (target: ChatControllerApi) => void {
    const pending: string[] = []
    this._pendingVoiceInput = pending
    return (target): void => {
      this._pendingVoiceInput = undefined
      for (const transcript of pending) {
        void target.submit(transcript)
      }
    }
  }

  async handleCommand(argument: string): Promise<void> {
    if (!this._voice) {
      this._panels.error('voice unavailable', '/voice', 'This build does not include the repository voice sidecar.')
      return
    }
    const action = argument.trim().toLowerCase()
    if (action === 'off') {
      this._panels.panel()
      await this._voice.stop()
      return
    }
    if (!action || action === 'status') {
      this._panels.panel(this.rows())
      return
    }
    if (action !== 'on') {
      this._panels.error(
        'unknown voice command',
        `/voice ${argument}`,
        'Use /voice, /voice on, /voice off, or /voice status.'
      )
      return
    }

    this._panels.panel()
    try {
      if (this._voice.getSnapshot().status === 'off' || this._voice.getSnapshot().status === 'error') {
        await this._voice.start()
      }
    } catch (error) {
      this._panels.error('voice failed', '/voice', errorMessage(error))
    }
  }

  async handlePanelAction(value: string): Promise<boolean> {
    if (!this._voice) {
      return false
    }
    const [action, selected] = value.split('=')
    try {
      switch (action) {
        case 'voice:start':
          await this._voice.start()
          return true
        case 'voice:stop':
          await this._voice.stop()
          return true
        case 'voice:microphone':
          return this._voice.toggleMuted()
        case 'voice:spokenReplies':
          return this._voice.setSpokenReplies(!this._voice.getSnapshot().spokenReplies)
        case 'voice:endpointing': {
          const sensitivity = selected
            ? ENDPOINTING_OPTIONS.find((option) => option.value === selected)?.value
            : nextEndpointingSensitivity(this._voice.getSnapshot().endpointingSensitivity)
          return sensitivity ? this._voice.setEndpointingSensitivity(sensitivity) : false
        }
        case 'voice:voice': {
          const voice = selected
            ? VOICE_IDS.find((voice) => voice === selected)
            : nextVoiceId(this._voice.getSnapshot().voice)
          return voice ? this._voice.setVoice(voice) : false
        }
        default:
          return false
      }
    } catch (error) {
      this._panels.error('voice update failed', 'voice', errorMessage(error))
      return false
    }
  }

  rows(): ChatPanelRow[] {
    if (!this._voice) {
      return []
    }
    const voice = this._voice.getSnapshot()
    const active = voice.status !== 'off' && voice.status !== 'error'
    return [
      {
        label: active ? 'Stop Voice' : 'Start Voice',
        description: voice.status,
        value: active ? 'voice:stop' : 'voice:start',
        ...(active ? { tone: 'danger' } : {}),
      },
      ...(voice.model
        ? [
            {
              label: 'model',
              description: voice.model,
              section: 'Session',
            },
          ]
        : []),
      ...(voice.message
        ? [
            {
              label: 'detail',
              description: voice.message,
              section: 'Session',
              tone: 'danger' as const,
            },
          ]
        : []),
      {
        label: 'microphone',
        description: voice.muted ? 'muted' : 'live',
        value: 'voice:microphone',
        section: 'Audio',
        control: { kind: 'toggle', checked: active && !voice.muted },
      },
      {
        label: 'spoken replies',
        description: voice.spokenReplies ? 'on' : 'off',
        value: 'voice:spokenReplies',
        section: 'Audio',
        control: { kind: 'toggle', checked: voice.spokenReplies },
      },
      ...voiceRows(voice.voice),
      {
        label: 'end of turn',
        description: {
          HIGH: 'fast',
          MEDIUM: 'balanced',
          LOW: 'patient',
        }[voice.endpointingSensitivity],
        value: 'voice:endpointing',
        section: 'Listening',
        control: {
          kind: 'segmented',
          options: ENDPOINTING_OPTIONS.map((option) => ({
            ...option,
            ...(voice.endpointingSensitivity === option.value ? { active: true } : {}),
          })),
        },
      },
    ]
  }

  followConversation(controller: ChatController, isActive: () => boolean): () => void {
    let speechTurnId: string | undefined
    let speechText = ''
    let spokenOffset = 0
    return (): void => {
      const snapshot = controller.getSnapshot()
      const turn = snapshot.activeTurn ?? snapshot.completedTurns.at(-1)
      if (!turn) {
        return
      }
      const text = turn.entries
        .filter((entry) => entry.type === 'assistant')
        .map((entry) => entry.text)
        .join('\n\n')
      if (speechTurnId !== turn.id) {
        speechTurnId = turn.id
        speechText = ''
        spokenOffset = 0
      } else if (!text.startsWith(speechText)) {
        speechText = text
        spokenOffset = text.length
        return
      }
      speechText = text

      const voice = this._voice?.getSnapshot()
      if (
        !this._voice ||
        !isActive() ||
        turn.source === 'background' ||
        !voice?.spokenReplies ||
        voice.status === 'off' ||
        voice.status === 'error' ||
        turn.status === 'cancelled' ||
        turn.status === 'error'
      ) {
        spokenOffset = text.length
        return
      }
      for (const chunk of streamingSpeechChunks(text, spokenOffset, turn.status === 'complete')) {
        if (!this._voice.speak(chunk.text)) {
          spokenOffset = text.length
          return
        }
        spokenOffset = chunk.end
      }
    }
  }

  toggleMuted(): boolean {
    return this._voice?.toggleMuted() ?? false
  }

  stop(): Promise<void> | undefined {
    return this._voice?.stop()
  }

  disconnect(): void {
    for (const unsubscribe of this._voiceUnsubscribers) {
      unsubscribe()
    }
    this._voiceUnsubscribers.length = 0
  }

  dispose(): Promise<void> {
    return this._voice?.dispose() ?? Promise.resolve()
  }

  clearListeners(): void {
    this._listeners.clear()
  }
}

function sameVoiceState(
  left: ReturnType<VoiceInput['getSnapshot']>,
  right: ReturnType<VoiceInput['getSnapshot']>
): boolean {
  return (
    left.status === right.status &&
    left.muted === right.muted &&
    left.spokenReplies === right.spokenReplies &&
    left.endpointingSensitivity === right.endpointingSensitivity &&
    left.voice === right.voice &&
    left.model === right.model &&
    left.message === right.message
  )
}

function streamingSpeechChunks(text: string, start: number, final: boolean): { text: string; end: number }[] {
  const chunks: { text: string; end: number }[] = []
  let cursor = start

  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor]!)) {
      cursor += 1
    }
    if (cursor >= text.length) {
      break
    }

    const remaining = text.slice(cursor)
    const sentenceEnd = speechSentenceEnd(remaining)
    let length: number | undefined
    if (sentenceEnd !== undefined && sentenceEnd <= STREAMING_SPEECH_MAX_CHARS) {
      length = sentenceEnd
    } else if (remaining.length >= STREAMING_SPEECH_MAX_CHARS) {
      const space = remaining.lastIndexOf(' ', STREAMING_SPEECH_MAX_CHARS)
      length = space > 0 ? space : STREAMING_SPEECH_MAX_CHARS
    } else if (final) {
      length = remaining.length
    }
    if (length === undefined) {
      break
    }

    const end = cursor + length
    const chunk = text.slice(cursor, end).trim()
    cursor = end
    chunks.push({ text: chunk, end })
  }

  return chunks
}

function speechSentenceEnd(text: string): number | undefined {
  const sentence = /[.!?](?:["')\]]*)(?=\s|$)/.exec(text)
  const lineBreak = text.indexOf('\n')
  const sentenceEnd = sentence ? sentence.index + sentence[0].length : undefined
  if (lineBreak < 0) {
    return sentenceEnd
  }
  const lineEnd = lineBreak + 1
  return sentenceEnd === undefined ? lineEnd : Math.min(sentenceEnd, lineEnd)
}

function nextEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): VoiceEndpointingSensitivity {
  const index = ENDPOINTING_OPTIONS.findIndex((option) => option.value === sensitivity)
  return ENDPOINTING_OPTIONS[(index + 1) % ENDPOINTING_OPTIONS.length]!.value
}

function voiceRows(activeVoice: VoiceId): ChatPanelRow[] {
  const rows: readonly [label: string, voices: readonly VoiceId[]][] = [
    ['English (US)', ['tiffany', 'matthew']],
    ['English (GB)', ['amy']],
    ['French', ['ambre', 'florian']],
    ['Italian', ['beatrice', 'lorenzo']],
    ['German', ['greta', 'lennart']],
    ['Spanish', ['lupe', 'carlos']],
  ]
  return rows.map(([label, voices]) => ({
    label,
    description: voices.join(' / '),
    value: 'voice:voice',
    section: 'Voice',
    control: {
      kind: 'segmented',
      options: voices.map((voice) => ({
        label: voice,
        value: voice,
        ...(voice === activeVoice ? { active: true } : {}),
      })),
    },
  }))
}

function nextVoiceId(current: VoiceId): VoiceId {
  const index = VOICE_IDS.indexOf(current)
  return VOICE_IDS[(index + 1) % VOICE_IDS.length]!
}
