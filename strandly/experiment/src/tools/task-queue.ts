/**
 * Realistic task queue — verbose responses, task dependencies, priority levels,
 * optional unreliability (stale pops, lost acks).
 *
 * Compared to makeTaskQueue():
 * - Tasks have priority, dependencies (blockedBy), and metadata
 * - pop respects priority ordering and dependency constraints
 * - status returns detailed breakdown with pagination
 * - unreliability flag: ~10% of pops return a task that was already claimed (stale)
 *   requiring the agent to detect the conflict and re-pop
 */

import { tool } from '../../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'

export interface QueueTask {
  id: string
  description: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  status: 'pending' | 'in-progress' | 'done' | 'failed'
  blockedBy?: string[]
  result?: string
  assignedAt?: number
  completedAt?: number
  attempts: number
}

export interface TaskQueueOptions {
  unreliable?: boolean
  /** Max tasks returned in status list (default 10) */
  pageSize?: number
}

export function makeTaskQueue(initialTasks: Array<{ description: string; priority?: string; blockedBy?: string[] }>, options: TaskQueueOptions = {}) {
  const UNRELIABLE = options.unreliable ?? false
  const PAGE_SIZE = options.pageSize ?? 10

  let nextId = 1
  const tasks: QueueTask[] = initialTasks.map(t => ({
    id: String(nextId++),
    description: t.description,
    priority: (t.priority as QueueTask['priority']) ?? 'medium',
    status: 'pending',
    blockedBy: t.blockedBy,
    attempts: 0,
  }))

  let lastPoppedId: string | null = null

  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

  function isBlocked(task: QueueTask): boolean {
    if (!task.blockedBy || task.blockedBy.length === 0) return false
    return task.blockedBy.some(depId => {
      const dep = tasks.find(t => t.id === depId)
      return dep && dep.status !== 'done'
    })
  }

  const pop = tool({
    name: 'queue_pop',
    description: 'Take the next available task from the queue (highest priority first, respects dependencies). Returns the task details or empty if no tasks are available. A task that is blocked by incomplete dependencies will be skipped.',
    inputSchema: z.object({}),
    callback: () => {
      // Unreliability: occasionally return a stale (already claimed) task
      if (UNRELIABLE && lastPoppedId && Math.random() < 0.12) {
        const staleTask = tasks.find(t => t.id === lastPoppedId)
        if (staleTask && staleTask.status === 'in-progress') {
          return JSON.stringify({
            task: {
              id: staleTask.id,
              description: staleTask.description,
              priority: staleTask.priority,
              blockedBy: staleTask.blockedBy ?? [],
            },
            warning: 'POSSIBLE_STALE: this task may already be in-progress. Check status before working on it.',
            queueDepth: tasks.filter(t => t.status === 'pending').length,
          })
        }
      }

      // Find next eligible task (pending, not blocked, highest priority)
      const eligible = tasks
        .filter(t => t.status === 'pending' && !isBlocked(t))
        .sort((a, b) => priorityOrder[a.priority]! - priorityOrder[b.priority]!)

      if (eligible.length === 0) {
        const pending = tasks.filter(t => t.status === 'pending')
        const blocked = pending.filter(t => isBlocked(t))
        return JSON.stringify({
          task: null,
          message: pending.length === 0
            ? 'Queue is empty — all tasks are in-progress or done.'
            : `No eligible tasks. ${blocked.length} tasks are blocked by incomplete dependencies.`,
          queueDepth: pending.length,
          blockedCount: blocked.length,
        })
      }

      const task = eligible[0]!
      task.status = 'in-progress'
      task.assignedAt = Date.now()
      task.attempts++
      lastPoppedId = task.id

      return JSON.stringify({
        task: {
          id: task.id,
          description: task.description,
          priority: task.priority,
          blockedBy: task.blockedBy ?? [],
          attempt: task.attempts,
        },
        queueDepth: tasks.filter(t => t.status === 'pending').length,
      })
    },
  })

  const complete = tool({
    name: 'queue_complete',
    description: 'Mark a task as done with a result. Returns confirmation or error if task not found / not in-progress.',
    inputSchema: z.object({
      id: z.string().describe('Task ID to mark as done'),
      result: z.string().describe('The result/output of completing this task'),
    }),
    callback: (input) => {
      const task = tasks.find(t => t.id === input.id)
      if (!task) {
        return JSON.stringify({ success: false, error: 'TASK_NOT_FOUND', message: `No task with id "${input.id}"` })
      }
      if (task.status === 'done') {
        return JSON.stringify({ success: false, error: 'ALREADY_DONE', message: `Task ${input.id} was already completed` })
      }
      if (task.status !== 'in-progress') {
        return JSON.stringify({ success: false, error: 'NOT_IN_PROGRESS', message: `Task ${input.id} is "${task.status}", not in-progress. Pop it first.` })
      }

      task.status = 'done'
      task.result = input.result
      task.completedAt = Date.now()

      // Report which tasks are now unblocked
      const newlyUnblocked = tasks.filter(t =>
        t.status === 'pending' && t.blockedBy?.includes(input.id) && !isBlocked(t)
      )

      return JSON.stringify({
        success: true,
        taskId: input.id,
        ...(newlyUnblocked.length > 0 && {
          unblocked: newlyUnblocked.map(t => ({ id: t.id, description: t.description.slice(0, 60) })),
        }),
      })
    },
  })

  const fail = tool({
    name: 'queue_fail',
    description: 'Mark a task as failed. It returns to pending for retry (up to 3 attempts).',
    inputSchema: z.object({
      id: z.string().describe('Task ID to mark as failed'),
      reason: z.string().describe('Why the task failed'),
    }),
    callback: (input) => {
      const task = tasks.find(t => t.id === input.id)
      if (!task) return JSON.stringify({ success: false, error: 'TASK_NOT_FOUND' })

      if (task.attempts >= 3) {
        task.status = 'failed'
        return JSON.stringify({ success: true, taskId: input.id, finalStatus: 'failed', message: 'Max attempts reached. Task permanently failed.' })
      }

      task.status = 'pending'
      return JSON.stringify({ success: true, taskId: input.id, finalStatus: 'pending', attemptsRemaining: 3 - task.attempts, message: 'Task returned to queue for retry.' })
    },
  })

  const status = tool({
    name: 'queue_status',
    description: 'Get queue status summary and optionally list tasks. Use filter to see specific statuses. Results are paginated.',
    inputSchema: z.object({
      filter: z.enum(['all', 'pending', 'in-progress', 'done', 'failed']).optional().describe('Filter by status (default: summary only)'),
      cursor: z.number().optional().describe('Pagination cursor for task list'),
    }),
    callback: (input) => {
      const summary = {
        pending: tasks.filter(t => t.status === 'pending').length,
        inProgress: tasks.filter(t => t.status === 'in-progress').length,
        done: tasks.filter(t => t.status === 'done').length,
        failed: tasks.filter(t => t.status === 'failed').length,
        total: tasks.length,
        blocked: tasks.filter(t => t.status === 'pending' && isBlocked(t)).length,
      }

      if (!input.filter || input.filter === 'all') {
        return JSON.stringify({ summary })
      }

      const filtered = tasks.filter(t => t.status === input.filter)
      const offset = input.cursor ?? 0
      const page = filtered.slice(offset, offset + PAGE_SIZE)
      const hasMore = offset + PAGE_SIZE < filtered.length

      return JSON.stringify({
        summary,
        tasks: page.map(t => ({
          id: t.id,
          description: t.description.slice(0, 80),
          priority: t.priority,
          status: t.status,
          ...(t.blockedBy && { blockedBy: t.blockedBy }),
          ...(t.result && { result: t.result.slice(0, 100) }),
        })),
        ...(hasMore && { nextCursor: offset + PAGE_SIZE }),
        totalFiltered: filtered.length,
      })
    },
  })

  return {
    pop, complete, fail, status,
    tools: [pop, complete, fail, status],
    /** Direct access for scoring */
    getTasks: () => tasks,
    getDoneTasks: () => tasks.filter(t => t.status === 'done'),
    getFailedTasks: () => tasks.filter(t => t.status === 'failed'),
  }
}
