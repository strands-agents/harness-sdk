import { useEffect, useState, type ReactElement } from 'react'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Fill, KeyHints, Line, PanelTitle, plural } from '../../ui/panels/kit.js'
import type { EvalsBrowser, OptimizeState } from '../panels/model.js'
import type { TemporaryStore } from './jobs.js'
import { temporaryOptimizeJobs } from './sessions.js'

const recordOf = (state: OptimizeState, id: string): string | undefined => {
  const run = state.runs?.find((candidate) => candidate.id === id)
  if (run?.state.step === 'running') return run.state.progress.run
  return run?.state.step === 'review' ? run.state.review.run : undefined
}

/** The runs line's landing view: optimization is chat-driven, so this only shows what is going. */
export const OptimizeRunsView = ({
  session,
  browser,
  height,
}: DevChatPanelProps & { session: TemporaryStore<OptimizeState>; browser: EvalsBrowser }): ReactElement => {
  const [state, setState] = useState(session.snapshot())
  const [links, setLinks] = useState<Readonly<Record<string, string>>>({})
  useEffect(() => session.subscribe(() => setState(session.snapshot())), [session])
  const jobs = temporaryOptimizeJobs(state)
  const records = jobs.map(({ id }) => `${id}:${recordOf(state, id) ?? ''}`).join('\n')
  useEffect(() => {
    let stale = false
    void Promise.all(
      jobs.flatMap(({ id }) => {
        const record = recordOf(state, id)
        if (record === undefined) return []
        return [
          browser
            .address({ view: 'optimization', record })
            .then((address) => (address.status === 'ready' ? ([id, address.url] as const) : undefined))
            .catch(() => undefined),
        ]
      })
    ).then((found) => {
      if (!stale) setLinks(Object.fromEntries(found.flatMap((entry) => (entry ? [entry] : []))))
    })
    return (): void => {
      stale = true
    }
  }, [browser, records])
  const shown = jobs.slice(0, Math.max(1, Math.floor((height - 4) / 2)))
  return (
    <>
      <PanelTitle name="optimize" parts={[plural(jobs.length, 'run')]} />
      {jobs.length === 0 ? <Line tone="muted">{'  No optimization is running.'}</Line> : null}
      {shown.flatMap((job) => [
        <Line
          key={job.id}
        >{`  ● ${job.label}${job.total === undefined ? '' : ` · ${job.done ?? 0}/${job.total}`}`}</Line>,
        ...(links[job.id] ? [<Line key={`${job.id}:link`} tone="muted">{`    ${links[job.id]}`}</Line>] : []),
      ])}
      <Line tone="muted">{'  Runs are set up and reviewed in the chat. Ask how a run is going, or to start one.'}</Line>
      <Fill />
      <KeyHints hints={['Esc close']} />
    </>
  )
}
