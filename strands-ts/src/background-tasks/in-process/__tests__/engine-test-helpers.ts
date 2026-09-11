import { expect } from 'vitest'
import { InProcessTaskEngine } from '../engine.js'
import type { InterruptStateData } from '../../../interrupt.js'
import type { ToolResultBlockData } from '../../../types/messages.js'
import type { InProcessTaskEngineOptions, InProcessTaskRecord } from '../types.js'

type ExpectedTaskFields = Pick<InProcessTaskRecord, 'status'> &
  Partial<Pick<InProcessTaskRecord, 'state' | 'result' | 'failure'>>

export function createEngine(
  execute: InProcessTaskEngineOptions['execute'],
  options: Partial<InProcessTaskEngineOptions> = {}
): InProcessTaskEngine {
  return new InProcessTaskEngine({
    maxConcurrency: 2,
    timeout: 1_000,
    execute,
    onTaskUpdated: () => undefined,
    ...options,
  })
}

export function createAdmission(
  value: string
): Pick<InProcessTaskRecord, 'toolUseId' | 'toolName' | 'invocationStateId'> {
  return {
    toolUseId: value,
    toolName: value,
    invocationStateId: value,
  }
}

export function createResult(value: string): ToolResultBlockData {
  return {
    toolUseId: value,
    status: 'success',
    content: [{ text: value }],
  }
}

export function createState(value: string): InterruptStateData {
  return {
    interrupts: {
      [value]: {
        id: value,
        name: value,
      },
    },
    activated: true,
  }
}

export function getStateValue(state: InterruptStateData): string {
  return Object.keys(state.interrupts)[0]!
}

export function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function expectTask(
  actual: InProcessTaskRecord | undefined,
  task: InProcessTaskRecord,
  fields: ExpectedTaskFields
): void {
  expect(actual).toEqual({
    taskId: task.taskId,
    toolUseId: task.toolUseId,
    toolName: task.toolName,
    invocationStateId: task.invocationStateId,
    ...fields,
    createdAt: task.createdAt,
    lastUpdatedAt: expect.any(String),
  })
}
