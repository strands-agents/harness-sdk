import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, measureElement, type DOMElement } from 'ink'

import type { ChatNotice, ChatSnapshot, ChatTurn } from '../chat/controller.js'
import { planTranscriptLayout, sameTranscriptLayoutPlan, type TranscriptLayoutPlan } from './transcript-layout.js'
import { CompletedTurnView, TurnView } from './transcript-turn.js'
import { registerElement } from './interaction.js'
import { Text, useTheme } from './theme.js'

const EMPTY_TOOL_GROUPS: ReadonlySet<string> = new Set()

interface TranscriptMeasurementCache {
  completed: Map<string, { turn: ChatTurn; noticesKey: string; height: number }>
  rootHeight: number
  activeTurnId: string | undefined
  activeHeight: number
  viewportHeight: number
}

/**
 * Upper bound on measurement-driven re-renders between two prop changes. Measuring converges in a
 * pass or two; anything beyond this means heights depend on the layout they produce, and a stale
 * window is preferable to an unbounded render loop.
 */
const MAX_MEASUREMENT_RENDERS = 4

function noticesKey(notices: readonly ChatNotice[]): string {
  return notices
    .map((notice) => [notice.id, notice.status, notice.text, notice.taskId ?? ''].join('\u001f'))
    .join('\u001e')
}

function measuredHeight(cache: TranscriptMeasurementCache, turn: ChatTurn, noticesKey: string): number | undefined {
  const measurement = cache.completed.get(turn.id)
  return measurement?.turn === turn && measurement.noticesKey === noticesKey ? measurement.height : undefined
}

export const TranscriptViewport = memo(function TranscriptViewport({
  header,
  turns,
  activeTurn,
  notices,
  settings,
  scrollOffset,
  layoutKey,
  synchronousLayout = false,
  onMaxScrollChange,
  expandedToolGroups = EMPTY_TOOL_GROUPS,
  onToolGroupElement,
}: {
  header?: ReactElement
  turns: readonly ChatTurn[]
  activeTurn?: ChatTurn
  notices: readonly ChatNotice[]
  settings: ChatSnapshot['settings']
  scrollOffset: number
  layoutKey: string
  synchronousLayout?: boolean
  onMaxScrollChange?: (maximum: number) => void
  expandedToolGroups?: ReadonlySet<string>
  onToolGroupElement?: (id: string, element: DOMElement | null) => void
}): ReactElement {
  const viewportRef = useRef<DOMElement>(null)
  const contentRef = useRef<DOMElement>(null)
  const rootNoticesRef = useRef<DOMElement>(null)
  const activeTurnRef = useRef<DOMElement>(null)
  const completedTurnRefs = useRef(new Map<string, DOMElement>())
  const maximumRef = useRef(0)
  const renderedPlanRef = useRef<TranscriptLayoutPlan | undefined>(undefined)
  const measurementRenders = useRef({ inputs: [] as unknown[], count: 0 })
  const [, setMeasurementVersion] = useState(0)
  const measurementKey = `${layoutKey}:${settings.transcriptSpacing}:${settings.showReasoning}:${settings.toolOutput}:${[...expandedToolGroups].join(',')}`
  const cache = useMemo<TranscriptMeasurementCache>(
    () => ({
      completed: new Map(),
      rootHeight: 0,
      activeTurnId: undefined,
      activeHeight: 0,
      viewportHeight: 0,
    }),
    [measurementKey]
  )
  const { noticesByTurn, rootNotices } = useMemo(() => {
    const grouped = new Map<string, ChatNotice[]>()
    const roots: ChatNotice[] = []
    for (const notice of notices) {
      if (!notice.afterTurnId) {
        roots.push(notice)
        continue
      }
      const values = grouped.get(notice.afterTurnId) ?? []
      values.push(notice)
      grouped.set(notice.afterTurnId, values)
    }
    const byTurn = new Map<string, { notices: readonly ChatNotice[]; key: string }>()
    for (const [turnId, turnNotices] of grouped) {
      byTurn.set(turnId, { notices: turnNotices, key: noticesKey(turnNotices) })
    }
    return { noticesByTurn: byTurn, rootNotices: roots }
  }, [notices])
  const completedUnits = useMemo(
    () =>
      turns.map((turn) => {
        const grouped = noticesByTurn.get(turn.id)
        return { turn, notices: grouped?.notices ?? [], noticesKey: grouped?.key ?? '' }
      }),
    [noticesByTurn, turns]
  )
  const activeNotices = useMemo(
    () => (activeTurn ? notices.filter((notice) => notice.afterTurnId === activeTurn.id) : []),
    [activeTurn, notices]
  )
  const plan = planTranscriptLayout(
    completedUnits.map((unit) => measuredHeight(cache, unit.turn, unit.noticesKey)),
    cache.rootHeight,
    cache.activeTurnId === activeTurn?.id ? cache.activeHeight : 0,
    cache.viewportHeight,
    scrollOffset
  )
  renderedPlanRef.current = plan
  const visibleUnits = completedUnits.slice(plan.window.start, plan.window.end)
  const inputs = [cache, completedUnits, activeTurn, scrollOffset, header, settings]
  if (inputs.some((input, index) => input !== measurementRenders.current.inputs[index])) {
    measurementRenders.current = { inputs, count: 0 }
  }

  // Yoga computes layout before effects run, so measuring here reads the committed frame. Nothing
  // below sets state unless the layout plan derived from the fresh heights differs from the one that
  // was just rendered, which is what keeps measurement from feeding back into itself.
  const measureLayout = (): void => {
    if (!viewportRef.current || !contentRef.current) {
      return
    }
    const currentIds = new Set(completedUnits.map((unit) => unit.turn.id))
    for (const id of cache.completed.keys()) {
      if (!currentIds.has(id)) {
        cache.completed.delete(id)
      }
    }
    for (const unit of visibleUnits) {
      const element = completedTurnRefs.current.get(unit.turn.id)
      if (element) {
        cache.completed.set(unit.turn.id, {
          turn: unit.turn,
          noticesKey: unit.noticesKey,
          height: measureElement(element).height,
        })
      }
    }
    cache.rootHeight = rootNoticesRef.current ? measureElement(rootNoticesRef.current).height : 0
    cache.activeTurnId = activeTurn?.id
    cache.activeHeight = activeTurnRef.current ? measureElement(activeTurnRef.current).height : 0
    cache.viewportHeight = measureElement(viewportRef.current).height
    const maximum = Math.max(0, measureElement(contentRef.current).height - cache.viewportHeight)
    if (maximum !== maximumRef.current) {
      maximumRef.current = maximum
      onMaxScrollChange?.(maximum)
    }
    const next = planTranscriptLayout(
      completedUnits.map((unit) => measuredHeight(cache, unit.turn, unit.noticesKey)),
      cache.rootHeight,
      cache.activeHeight,
      cache.viewportHeight,
      scrollOffset
    )
    if (
      sameTranscriptLayoutPlan(renderedPlanRef.current!, next) ||
      measurementRenders.current.count >= MAX_MEASUREMENT_RENDERS
    ) {
      return
    }
    measurementRenders.current.count++
    setMeasurementVersion((version) => version + 1)
  }
  useLayoutEffect(() => {
    if (synchronousLayout) {
      measureLayout()
    }
  })
  useEffect(() => {
    if (!synchronousLayout) {
      measureLayout()
    }
  })

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      justifyContent={plan.anchorBottom ? 'flex-end' : 'flex-start'}
    >
      <Box
        ref={contentRef}
        flexDirection="column"
        flexShrink={0}
        marginBottom={plan.anchorBottom ? -plan.scrollOffset : 0}
      >
        <Box ref={rootNoticesRef} flexDirection="column">
          {header}
          {rootNotices.map((notice) => (
            <NoticeView key={notice.id} notice={notice} />
          ))}
        </Box>
        {plan.window.before > 0 ? <Box height={plan.window.before} flexShrink={0} /> : null}
        {visibleUnits.map(({ turn, notices: turnNotices }) => (
          <Box
            key={turn.id}
            ref={(element) => {
              registerElement(completedTurnRefs.current, turn.id, element)
            }}
            flexDirection="column"
          >
            <CompletedTurnView
              turn={turn}
              settings={settings}
              expandedToolGroups={expandedToolGroups}
              {...(onToolGroupElement ? { onToolGroupElement } : {})}
            />
            {turnNotices.map((notice) => (
              <NoticeView key={notice.id} notice={notice} />
            ))}
          </Box>
        ))}
        {plan.window.after > 0 ? <Box height={plan.window.after} flexShrink={0} /> : null}
        {activeTurn ? (
          <Box ref={activeTurnRef} flexDirection="column">
            <TurnView
              turn={activeTurn}
              settings={settings}
              active
              expandedToolGroups={expandedToolGroups}
              {...(onToolGroupElement ? { onToolGroupElement } : {})}
            />
            {activeNotices.map((notice) => (
              <NoticeView key={notice.id} notice={notice} />
            ))}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
})

function NoticeView({ notice }: { notice: ChatNotice }): ReactElement {
  const theme = useTheme()
  const marker =
    notice.status === 'running' ? '◐' : notice.status === 'error' ? '×' : notice.status === 'delivered' ? '↳' : '✓'
  const color =
    notice.status === 'running'
      ? theme.warning
      : notice.status === 'error'
        ? 'red'
        : notice.status === 'delivered'
          ? theme.accent
          : 'green'
  return (
    <Box paddingLeft={1}>
      <Text>
        <Text color={color}>{marker}</Text> {notice.text}
        {notice.taskId ? <Text dimColor> - {notice.taskId}</Text> : null}
      </Text>
    </Box>
  )
}
