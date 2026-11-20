import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { canonicalPath } from './permission-rules.js'
import { isRecord } from '../values.js'

/**
 * A change the developer accepted in a review panel, so the write that applies it does not ask again.
 * A ticket matches one `write` of the exact accepted text and is spent on first use.
 */
interface AcceptedChange {
  path: string
  digest: string
}

const digestOf = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')

export class AcceptedChanges {
  private readonly _tickets: AcceptedChange[] = []

  accept(workspace: string, path: string, content: string): void {
    this._tickets.push({ path: canonicalPath(resolve(workspace, path)), digest: digestOf(content) })
  }

  /** Spends a matching ticket. Only `write` qualifies: it carries the whole text the panel showed. */
  spend(workspace: string, toolName: string, input: unknown): boolean {
    if (toolName !== 'write' || !isRecord(input)) {
      return false
    }
    const { path, content } = input
    if (typeof path !== 'string' || typeof content !== 'string') {
      return false
    }
    const target = canonicalPath(resolve(workspace, path))
    const digest = digestOf(content)
    const at = this._tickets.findIndex((ticket) => ticket.path === target && ticket.digest === digest)
    if (at === -1) {
      return false
    }
    this._tickets.splice(at, 1)
    return true
  }

  clear(): void {
    this._tickets.length = 0
  }
}
