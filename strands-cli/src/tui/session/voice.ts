import type { ChatController } from '../chat/controller.js'
import type { ChatPanelRow, ChatVoiceStore, ChatTurn } from '../chat/types.js'
import { errorMessage } from '../terminal/sanitize.js'
import {
  BEDROCK_VOICE_IDS,
  OPENAI_VOICE_IDS,
  VOICE_MODEL_IDS,
  VOICE_MODEL_OPTIONS,
  VOICE_PROVIDERS,
  VOICE_IDS,
  type VoiceEndpointingSensitivity,
  type VoiceId,
  type VoiceInput,
  type VoiceProvider,
  type VoiceSupervisorRequest,
} from '../voice/session.js'
import { conversationStatus } from './conversation-helpers.js'

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
  private _inputPaused = false

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
        this._voice.onSupervisorRequest((request) => {
          this._handleSupervisorRequest(request)
        })
      )
    }
  }

  pauseInput(): () => void {
    this._inputPaused = true
    return (): void => {
      this._inputPaused = false
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
        case 'voice:enabled': {
          if (selected !== undefined && selected !== 'on' && selected !== 'off') return false
          const { status } = this._voice.getSnapshot()
          const active = status !== 'off' && status !== 'error'
          const enabled = selected === undefined ? !active : selected === 'on'
          if (enabled !== active) {
            await (enabled ? this._voice.start() : this._voice.stop())
          }
          return true
        }
        case 'voice:spokenReplies':
          return this._voice.setSpokenReplies(!this._voice.getSnapshot().spokenReplies)
        case 'voice:endpointing': {
          const sensitivity = selected
            ? ENDPOINTING_OPTIONS.find((option) => option.value === selected)?.value
            : nextEndpointingSensitivity(this._voice.getSnapshot().endpointingSensitivity)
          return sensitivity ? this._voice.setEndpointingSensitivity(sensitivity) : false
        }
        case 'voice:provider': {
          const provider = selected
            ? VOICE_PROVIDERS.find((provider) => provider === selected)
            : nextProvider(this._voice.getSnapshot().provider)
          return provider ? this._voice.setProvider(provider) : false
        }
        case 'voice:model': {
          const model = selected ? VOICE_MODEL_IDS.find((model) => model === selected) : undefined
          return model ? this._voice.setModel(model) : false
        }
        case 'voice:voice': {
          const voice = selected
            ? VOICE_IDS.find((voice) => voice === selected)
            : nextVoiceId(this._voice.getSnapshot().voice, this._voice.getSnapshot().provider)
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
        label: 'Voice',
        description: voice.status,
        value: 'voice:enabled',
        control: {
          kind: 'segmented',
          options: [
            { label: 'Off', value: 'off', active: !active },
            { label: 'On', value: 'on', active },
          ],
        },
      },
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
        label: 'spoken replies',
        description: voice.spokenReplies ? 'on' : 'off',
        value: 'voice:spokenReplies',
        section: 'Audio',
        control: { kind: 'toggle', checked: voice.spokenReplies },
      },
      {
        label: 'provider',
        description: voice.provider === 'bedrock' ? 'Nova' : 'OpenAI',
        value: 'voice:provider',
        section: 'Voice',
        control: {
          kind: 'segmented',
          options: [
            { label: 'Nova', value: 'bedrock', ...(voice.provider === 'bedrock' ? { active: true } : {}) },
            { label: 'OpenAI', value: 'openai', ...(voice.provider === 'openai' ? { active: true } : {}) },
          ],
        },
      },
      ...modelRows(voice.provider, voice.model),
      ...voiceRows(voice.provider, voice.voice),
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
    let narratedTurnId: string | undefined
    return (): void => {
      const snapshot = controller.getSnapshot()
      const turn = snapshot.activeTurn ?? snapshot.completedTurns.at(-1)
      if (!turn || turn.status === 'running' || narratedTurnId === turn.id) {
        return
      }
      narratedTurnId = turn.id

      const voice = this._voice?.getSnapshot()
      if (
        !this._voice ||
        !isActive() ||
        turn.source === 'background' ||
        !voice?.spokenReplies ||
        voice.status === 'off' ||
        voice.status === 'error' ||
        turn.status === 'cancelled'
      ) {
        return
      }
      const narration = harnessNarration(turn)
      if (narration) {
        this._voice.narrate(narration)
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

  private _handleSupervisorRequest(request: VoiceSupervisorRequest): void {
    if (!this._voice) {
      return
    }
    try {
      if (this._inputPaused) {
        throw new Error('The harness agent is reloading. Try again after the reload finishes.')
      }
      const result =
        request.action === 'get_current_work'
          ? this._currentWork()
          : request.action === 'cancel_current_work'
            ? this._cancelCurrentWork()
            : this._delegate(request.instruction)
      this._voice.resolveSupervisorRequest(request.requestId, { ok: true, result })
    } catch (error) {
      this._voice.resolveSupervisorRequest(request.requestId, { ok: false, error: errorMessage(error) })
    }
  }

  private _currentWork(): Record<string, unknown> {
    const { controller } = this._active()
    const snapshot = controller.getSnapshot()
    const turn = snapshot.activeTurn
    const lastTurn = snapshot.completedTurns.at(-1)
    return {
      conversation: controller.backend.name,
      status: conversationStatus(snapshot).label,
      ...(turn ? { active_request: spokenExcerpt(turn.prompt) } : {}),
      active_tools:
        turn?.entries.flatMap((entry) => (entry.type === 'tool' && entry.status === 'running' ? [entry.name] : [])) ??
        [],
      queued_requests: snapshot.queuedPrompts.length,
      pending_steering: snapshot.pendingSteering.length,
      background_tasks: snapshot.tasks
        .filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status))
        .map((task) => ({ label: task.label, status: task.status })),
      ...(lastTurn ? { latest_result: spokenExcerpt(harnessNarration(lastTurn), 800) } : {}),
    }
  }

  private _delegate(instruction: string | undefined): Record<string, unknown> {
    const request = instruction?.trim()
    if (!request) {
      throw new Error('The voice delegation did not include an instruction.')
    }
    const { controller } = this._active()
    if (controller.getSnapshot().status === 'closed') {
      throw new Error('The active harness conversation is closed.')
    }
    const queued = controller.busy
    void controller.submit(request).catch((error: unknown) => {
      this._voice?.narrate(`The delegated harness request failed: ${errorMessage(error)}`)
    })
    return {
      accepted: true,
      state: queued ? 'queued' : 'started',
      conversation: controller.backend.name,
    }
  }

  private _cancelCurrentWork(): Record<string, unknown> {
    const { controller } = this._active()
    const cancelled = controller.cancel()
    return {
      cancelled,
      state: cancelled ? 'cancelled' : 'idle',
      conversation: controller.backend.name,
    }
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
    left.provider === right.provider &&
    left.voice === right.voice &&
    left.model === right.model &&
    left.message === right.message
  )
}

function modelRows(provider: VoiceProvider, activeModel: string): ChatPanelRow[] {
  return VOICE_MODEL_OPTIONS[provider].map((model) => ({
    label: model.label,
    description: model.value,
    value: `voice:model=${model.value}`,
    section: 'Model',
    ...(model.value === activeModel
      ? {
          current: true,
          badge: { text: 'current', tone: 'success' as const },
        }
      : {}),
  }))
}

function harnessNarration(turn: ChatTurn): string {
  const text = turn.entries
    .filter((entry) => entry.type === 'assistant')
    .map((entry) => entry.text)
    .join('\n\n')
    .trim()
  if (text) {
    return text
  }
  return turn.status === 'error' ? `The harness request failed: ${turn.error ?? 'Unknown error'}` : ''
}

function spokenExcerpt(text: string, limit = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`
}

function nextEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): VoiceEndpointingSensitivity {
  const index = ENDPOINTING_OPTIONS.findIndex((option) => option.value === sensitivity)
  return ENDPOINTING_OPTIONS[(index + 1) % ENDPOINTING_OPTIONS.length]!.value
}

function voiceRows(provider: VoiceProvider, activeVoice: VoiceId): ChatPanelRow[] {
  const rows: readonly [label: string, voices: readonly VoiceId[]][] =
    provider === 'bedrock'
      ? [
          ['English (US)', ['tiffany', 'matthew']],
          ['English (GB)', ['amy']],
          ['French', ['ambre', 'florian']],
          ['Italian', ['beatrice', 'lorenzo']],
          ['German', ['greta', 'lennart']],
          ['Spanish', ['lupe', 'carlos']],
        ]
      : [
          ['OpenAI', ['alloy', 'coral']],
          ['More', ['sage', 'verse']],
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

function nextProvider(current: VoiceProvider): VoiceProvider {
  const index = VOICE_PROVIDERS.indexOf(current)
  return VOICE_PROVIDERS[(index + 1) % VOICE_PROVIDERS.length]!
}

function nextVoiceId(current: VoiceId, provider: VoiceProvider): VoiceId {
  const choices: readonly VoiceId[] = provider === 'bedrock' ? BEDROCK_VOICE_IDS : OPENAI_VOICE_IDS
  const index = choices.indexOf(current)
  return choices[(index + 1) % choices.length]!
}
