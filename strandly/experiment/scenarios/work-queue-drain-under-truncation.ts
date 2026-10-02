import { createAgent } from '../src/agent-factory.js'
import { bash } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { makeTaskQueue } from '../src/tools/task-queue.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 10
const UNRELIABLE = process.env.CHAOS === '1'

export default scenario({
  description: 'Drain a 25-item prioritized work queue with dependencies — pop, do real bash work, complete with a result — respecting task priorities and dependency ordering, with verbose paginated status responses and optional stale-pop unreliability.',
  stresses: 'Long pop/work/complete loops where the authoritative state lives in an external tool returning verbose JSON the agent must parse. With 25 items, priority ordering, and inter-task dependencies (some tasks are blocked until prerequisites complete), the agent must check status, handle blocked tasks, retry after dependencies resolve, and parse nested responses. Under a sliding window of 10, early completions are evicted — the agent must trust the queue rather than memory. With CHAOS=1, ~12% of pops return stale (already-claimed) tasks the agent must detect and re-pop.',
  dimensions: ['context-management', 'state-consistency', 'agent-loop'],
  evaluation: {
    rubric: `Score 1.0 if all 25 tasks completed (done), zero pending, zero in-progress, zero failed, and each task has a concrete result from actual bash execution. Score 0.5 if 20+ completed but some missed or a dependency was violated. Score 0.0 if fewer than 15 completed or the agent looped/hallucinated results.`,
  },
  run,
})

async function run(profiler: ProfilerObserver) {
  // 25 tasks with priorities and dependencies — forms a partial order.
  // Dependencies mean some tasks can't start until their prerequisite is done.
  const queue = makeTaskQueue([
    // Group 1: Independent foundation tasks (no deps, mixed priority)
    { description: 'Count total .ts files in strands-ts/src/ recursively (find strands-ts/src -name "*.ts" | wc -l).', priority: 'high' },
    { description: 'Count total lines in strands-ts/src/agent/agent.ts (wc -l).', priority: 'high' },
    { description: 'List all directories directly under strands-ts/src/ (ls -d strands-ts/src/*/).', priority: 'medium' },
    { description: 'Count exported functions in strands-ts/src/tools/tool-factory.ts (grep -c "export function").', priority: 'medium' },
    { description: 'Report the file size in bytes of strands-ts/src/models/bedrock.ts (wc -c).', priority: 'low' },
    { description: 'Count how many .ts files are in strands-ts/src/hooks/ (ls strands-ts/src/hooks/*.ts | wc -l).', priority: 'medium' },
    { description: 'Count import statements in strands-ts/src/agent/agent.ts (grep -c "^import").', priority: 'low' },
    { description: 'Find the longest .ts file in strands-ts/src/models/ by line count (wc -l strands-ts/src/models/*.ts | sort -n | tail -2 | head -1).', priority: 'medium' },

    // Group 2: Depends on task 1 (total .ts file count)
    { description: 'Count .ts files under strands-ts/src/agent/ only (find strands-ts/src/agent -name "*.ts" | wc -l). Compare mentally to the total from task 1.', priority: 'high', blockedBy: ['1'] },
    { description: 'Count .ts files under strands-ts/src/tools/ only (find strands-ts/src/tools -name "*.ts" | wc -l).', priority: 'medium', blockedBy: ['1'] },

    // Group 3: Depends on task 2 (agent.ts line count)
    { description: 'Count how many lines in agent.ts contain "async" (grep -c "async" strands-ts/src/agent/agent.ts).', priority: 'high', blockedBy: ['2'] },
    { description: 'Count how many lines in agent.ts contain "throw" (grep -c "throw" strands-ts/src/agent/agent.ts).', priority: 'medium', blockedBy: ['2'] },
    { description: 'Show lines 1-5 of agent.ts (head -5 strands-ts/src/agent/agent.ts).', priority: 'low', blockedBy: ['2'] },

    // Group 4: Depends on task 3 (directory listing)
    { description: 'For each subdirectory found in task 3, count its .ts files (for d in strands-ts/src/*/; do echo "$d: $(ls "$d"*.ts 2>/dev/null | wc -l)"; done).', priority: 'critical', blockedBy: ['3'] },

    // Group 5: Depends on multiple prerequisites
    { description: 'Count total exported symbols (grep -rc "^export" strands-ts/src/agent/ | tail -1).', priority: 'high', blockedBy: ['9', '11'] },
    { description: 'Count lines in strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts (wc -l).', priority: 'medium', blockedBy: ['3'] },
    { description: 'Count .ts files in strands-ts/src/conversation-manager/ (ls strands-ts/src/conversation-manager/*.ts | wc -l).', priority: 'medium', blockedBy: ['3'] },
    { description: 'Count occurrences of "Plugin" in strands-ts/src/plugins/ files (grep -rc "Plugin" strands-ts/src/plugins/).', priority: 'low', blockedBy: ['6'] },

    // Group 6: Deep dependency chain (sequential)
    { description: 'Count test files in strands-ts/src (find strands-ts/src -name "*.test.ts" | wc -l).', priority: 'high', blockedBy: ['1'] },
    { description: 'Find which directory under strands-ts/src has the most test files (find strands-ts/src -name "*.test.ts" -exec dirname {} \\; | sort | uniq -c | sort -rn | head -1).', priority: 'medium', blockedBy: ['19'] },
    { description: 'In the directory from task 20, count total lines across all test files (find <dir> -name "*.test.ts" -exec wc -l {} + | tail -1). Use strands-ts/src/agent/__tests__ if task 20 result is unclear.', priority: 'low', blockedBy: ['20'] },

    // Group 7: Independent tail tasks
    { description: 'Count how many files in strands-ts/src/ contain the word "stream" (grep -rl "stream" strands-ts/src/ | wc -l).', priority: 'medium' },
    { description: 'Report the total size of all .ts files in strands-ts/src/types/ (wc -c strands-ts/src/types/*.ts | tail -1).', priority: 'low' },
    { description: 'Count how many lines in strands-ts/src/models/streaming.ts (wc -l).', priority: 'low' },
    { description: 'Count how many interfaces are defined in strands-ts/src/types/messages.ts (grep -c "^export interface" strands-ts/src/types/messages.ts).', priority: 'medium' },
  ], { unreliable: UNRELIABLE, pageSize: 8 })

  const agent = createAgent(profiler, {
    systemPrompt: `You are a worker draining a prioritized task queue with dependencies.

WORKFLOW:
1. Call queue_pop to get the next available task (highest priority, unblocked)
2. If you get a task, do the bash work it describes
3. Call queue_complete with the task id and your result
4. Call queue_status to check progress
5. Repeat until queue_status shows zero pending AND zero in-progress

RULES:
- queue_pop returns verbose JSON — parse the "task" field for id and description
- Some tasks are BLOCKED (their dependencies haven't completed yet) — queue_pop will skip them and give you the next eligible one. When blocked tasks exist, keep working on available ones; they'll unblock as prerequisites complete.
- If queue_pop says no eligible tasks but some are blocked, call queue_status to check if any in-progress tasks need attention
- Never invent task ids — only complete ids from queue_pop
- Never re-do a completed task
- If you get a POSSIBLE_STALE warning from queue_pop, call queue_status to verify the task's status before working on it${UNRELIABLE ? '\n- The queue system is unreliable — you may occasionally get stale tasks that were already claimed. Check the warning field and verify before working.' : ''}`,
    tools: [bash, ...queue.tools],
    windowSize: WINDOW,
  })

  const task = 'Drain the entire work queue. Pop tasks in priority order, respecting dependencies. Do the bash work each describes, complete it with the result, and continue until the queue is fully drained. Give a final summary of all completed tasks with their results.'

  profiler.recordInvocationInput(task)
  const result = await agent.invoke(task, { limits: { turns: 120 } })
  profiler.recordResult(result)

  // SDK invariants
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle
  const doneTasks = queue.getDoneTasks()
  const failedTasks = queue.getFailedTasks()
  const allTasks = queue.getTasks()
  const pending = allTasks.filter(t => t.status === 'pending').length
  const inProgress = allTasks.filter(t => t.status === 'in-progress').length
  const drained = pending === 0 && inProgress === 0

  profiler.recordInvariants(
    stateConsistent(
      'queue-fully-drained',
      drained && failedTasks.length === 0,
      [
        drained
          ? `queue fully drained: ${doneTasks.length}/${allTasks.length} done, 0 pending, 0 in-progress`
          : `queue not drained: ${pending} pending, ${inProgress} in-progress (${doneTasks.length}/${allTasks.length} done)`,
        failedTasks.length > 0 ? `${failedTasks.length} tasks failed permanently` : null,
      ].filter(Boolean).join('; '),
    ),
  )
}
