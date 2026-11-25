import { resolve } from 'node:path'
import { WizardBroker } from '../../ui/panels/wizard-request.js'
import { recordDevEvent } from '../telemetry.js'
import { reviewOptimizeRun } from './review-run.js'
import { evalsWorkspaceDirectory } from './evals-process.js'
import { EvalsUi } from './evals-ui.js'
import { EvalsExperiments } from './experiments-session.js'
import { evalsFileChangeWarning, type EvalsDevSettings, type EvalsSessionHost } from './host.js'
import { EvalsAutoOptimize } from './auto-optimize.js'
import type { ChatSettings } from '../../config/settings.js'
import { EvalsEvaluate } from './evaluate-session.js'
import { EvalsOptimize, evalsOptimizeJobs } from './optimize-session.js'

export interface EvalsDevSessions {
  readonly experiments: EvalsExperiments
  readonly evaluate: EvalsEvaluate
  readonly optimize: EvalsOptimize
  /** Starts an optimization from the chats every so many chat turns, when the developer set that. */
  readonly auto: EvalsAutoOptimize
  /** Changes a setting of the workspace through the chat screen, as its settings panel does. */
  readonly setSettings: (update: Partial<ChatSettings>) => Promise<void>
  /** The settings of the workspace as they are now. */
  readonly settings: () => EvalsDevSettings | undefined
  readonly fileChanges: () => string | undefined
  readonly ui: EvalsUi
  readonly ask: WizardBroker
  /** Opens a file in the developer's editor through the chat screen; a relative path is from the agent folder. */
  readonly openFile: (path: string) => Promise<void>
}

const registry = new Map<string, { use: (host: EvalsSessionHost) => void; sessions: EvalsDevSessions }>()

export const evalsDevSessions = (host: EvalsSessionHost): EvalsDevSessions => {
  const key = evalsWorkspaceDirectory(host.workspace)
  const existing = registry.get(key)
  if (existing) {
    existing.use(host)
    return existing.sessions
  }
  let latest = host
  const current = (): EvalsSessionHost => latest
  const experiments = new EvalsExperiments(current)
  const optimize = new EvalsOptimize(current, experiments)
  const optimizing = (): boolean => evalsOptimizeJobs(optimize.snapshot()).length > 0
  const sessions = {
    experiments,
    evaluate: new EvalsEvaluate(current, experiments),
    optimize,
    // A run that is going, or one whose edits still wait for an answer, is done with before the next one starts.
    auto: new EvalsAutoOptimize(current, {
      busy: optimizing,
      idle: (signal): Promise<void> =>
        new Promise((resolveIdle, rejectIdle) => {
          if (!optimizing()) return resolveIdle()
          const settle = (): void => {
            unsubscribe()
            signal.removeEventListener('abort', aborted)
          }
          const aborted = (): void => {
            settle()
            rejectIdle(signal.reason)
          }
          const unsubscribe = optimize.subscribe(() => {
            if (optimizing()) return
            settle()
            resolveIdle()
          })
          signal.addEventListener('abort', aborted, { once: true })
        }),
    }),
    fileChanges: (): string | undefined => evalsFileChangeWarning(latest),
    setSettings: async (update: Partial<ChatSettings>): Promise<void> => {
      const set = latest.context?.setSettings
      if (!set) throw new Error('No chat is open to change the settings through.')
      if (!(await set(update))) throw new Error('The setting could not be saved.')
    },
    settings: (): EvalsDevSettings | undefined => latest.settings?.(),
    ui: new EvalsUi(current, host.evalsUi),
    ask: new WizardBroker((event) =>
      recordDevEvent(event === 'shown' ? 'ask_shown' : event === 'answered' ? 'ask_answered' : 'ask_cancelled')
    ),
    openFile: async (path: string): Promise<void> => {
      const open = latest.context?.openFile
      if (!open) throw new Error('This terminal cannot open an editor.')
      await open(resolve(latest.workspace.root, path))
    },
  }
  latest = { ...latest, evalsLink: (place, runFolder): string | undefined => sessions.ui.link(place, runFolder) }
  sessions.optimize.onReview = (id): void => void reviewOptimizeRun(sessions, id)
  sessions.optimize.onSettled = (id): void => sessions.ask.withdraw(id)
  registry.set(key, {
    use: (next) => {
      latest = { ...latest, ...next }
    },
    sessions,
  })
  return sessions
}
