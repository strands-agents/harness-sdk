import { useEffect, useState, type ReactElement } from 'react'

import type { DevChatPanelProps } from '../../ui/chat/types.js'
import { Fill, KeyHints, Line, PanelTitle, plural } from '../../ui/panels/kit.js'
import type { OptimizeState } from '../panels/model.js'
import type { TemporaryStore } from './jobs.js'
import { temporaryOptimizeJobs } from './sessions.js'

/** The runs line's landing view: optimization is chat-driven, so this only shows what is going. */
export const OptimizeRunsView = ({
  session,
  height,
}: DevChatPanelProps & { session: TemporaryStore<OptimizeState> }): ReactElement => {
  const [state, setState] = useState(session.snapshot())
  useEffect(() => session.subscribe(() => setState(session.snapshot())), [session])
  const jobs = temporaryOptimizeJobs(state)
  const shown = jobs.slice(0, Math.max(1, height - 4))
  return (
    <>
      <PanelTitle name="optimize" parts={[plural(jobs.length, 'run')]} />
      {jobs.length === 0 ? <Line tone="muted">{'  No optimization is running.'}</Line> : null}
      {shown.map((job) => (
        <Line
          key={job.id}
        >{`  ● ${job.label}${job.total === undefined ? '' : ` · ${job.done ?? 0}/${job.total}`}`}</Line>
      ))}
      <Line tone="muted">{'  Runs are set up and reviewed in the chat. Ask how a run is going, or to start one.'}</Line>
      <Fill />
      <KeyHints hints={['Esc close']} />
    </>
  )
}
