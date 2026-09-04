/**
 * Realistic database tool — paginated results, single-row mutations, verbose
 * responses with metadata, constrained query syntax.
 *
 * Compared to the original makeDatabase():
 * - SELECT returns max PAGE_SIZE rows + a cursor for the next page
 * - INSERT/UPDATE/DELETE operate on one row at a time
 * - Responses include metadata (timestamps, affected counts, warnings)
 * - Results are nested JSON the agent must parse
 * - WHERE supports = and IN, not arbitrary expressions
 * - Optional rate limiting (returns 429 if too many calls in a window)
 */

import { tool } from '../../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'

type Row = Record<string, string | number | boolean | null>

export interface DatabaseOptions {
  /** Max rows returned per SELECT (default 5) */
  pageSize?: number
  /** If set, calls beyond this count in a 10-call window return 429 (default: no limit) */
  rateLimit?: number
  /** Add irrelevant metadata fields to responses (default true) */
  verbose?: boolean
}

export function makeDatabase(options: DatabaseOptions = {}) {
  const PAGE_SIZE = options.pageSize ?? 5
  const RATE_LIMIT = options.rateLimit ?? 0
  const VERBOSE = options.verbose ?? true

  const tables = new Map<string, { columns: string[]; rows: Row[] }>()
  let callCount = 0
  let windowStart = Date.now()

  function checkRateLimit(): string | null {
    if (!RATE_LIMIT) return null
    const now = Date.now()
    if (now - windowStart > 10_000) {
      windowStart = now
      callCount = 0
    }
    callCount++
    if (callCount > RATE_LIMIT) {
      return JSON.stringify({
        error: 'RATE_LIMITED',
        status: 429,
        message: `Rate limit exceeded (${RATE_LIMIT} calls per 10s window). Retry after a moment.`,
        retryAfterMs: 1000,
      })
    }
    return null
  }

  function wrapResponse(data: unknown, meta?: Record<string, unknown>): string {
    const base: Record<string, unknown> = { status: 'ok', data }
    if (VERBOSE) {
      base.metadata = {
        executionTimeMs: Math.floor(Math.random() * 15) + 2,
        serverNode: 'db-replica-03',
        cacheHit: false,
        ...meta,
      }
    }
    return JSON.stringify(base)
  }

  function wrapError(code: string, message: string, hint?: string): string {
    return JSON.stringify({
      status: 'error',
      error: { code, message, ...(hint && { hint }) },
      ...(VERBOSE && { metadata: { executionTimeMs: 1, serverNode: 'db-primary-01' } }),
    })
  }

  const createTable = tool({
    name: 'db_create_table',
    description: 'Create a new table with specified columns. Returns confirmation or error.',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      columns: z.array(z.string()).describe('Column names for the table'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      if (tables.has(input.table)) {
        return wrapError('TABLE_EXISTS', `Table "${input.table}" already exists`)
      }
      tables.set(input.table, { columns: input.columns, rows: [] })
      return wrapResponse({ table: input.table, columns: input.columns }, { rowCount: 0 })
    },
  })

  const insert = tool({
    name: 'db_insert',
    description: 'Insert a single row into a table. Values must be provided as a key-value object matching the table columns.',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      row: z.record(z.string(), z.any()).describe('Column-value pairs for the row'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      const t = tables.get(input.table)
      if (!t) return wrapError('TABLE_NOT_FOUND', `Table "${input.table}" does not exist`)
      const row: Row = {}
      for (const col of t.columns) {
        row[col] = (input.row[col] as string | number | boolean | null) ?? null
      }
      // Check for unknown columns
      const unknownCols = Object.keys(input.row).filter(k => !t.columns.includes(k))
      t.rows.push(row)
      const warnings: string[] = []
      if (unknownCols.length > 0) {
        warnings.push(`Unknown columns ignored: ${unknownCols.join(', ')}`)
      }
      return wrapResponse(
        { inserted: row, rowIndex: t.rows.length - 1 },
        { totalRows: t.rows.length, ...(warnings.length > 0 && { warnings }) },
      )
    },
  })

  const select = tool({
    name: 'db_select',
    description: 'Query rows from a table. Returns paginated results (max 5 per page). Use cursor for next page. WHERE supports: column = value, or column IN (val1, val2, ...).',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      where: z.record(z.string(), z.any()).optional().describe('Filter conditions as {column: value} or {column: [val1, val2]} for IN'),
      columns: z.array(z.string()).optional().describe('Columns to return (default: all)'),
      cursor: z.number().optional().describe('Pagination cursor (row offset). Omit for first page.'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      const t = tables.get(input.table)
      if (!t) return wrapError('TABLE_NOT_FOUND', `Table "${input.table}" does not exist`)

      let rows = t.rows

      // Apply WHERE filters
      if (input.where) {
        for (const [col, val] of Object.entries(input.where)) {
          if (!t.columns.includes(col)) {
            return wrapError('INVALID_COLUMN', `Column "${col}" does not exist in table "${input.table}"`, `Available columns: ${t.columns.join(', ')}`)
          }
          if (Array.isArray(val)) {
            rows = rows.filter(r => val.map(String).includes(String(r[col])))
          } else {
            rows = rows.filter(r => String(r[col]) === String(val))
          }
        }
      }

      // Apply column projection
      if (input.columns) {
        rows = rows.map(r => {
          const projected: Row = {}
          for (const col of input.columns!) {
            projected[col] = r[col] ?? null
          }
          return projected
        })
      }

      // Paginate
      const offset = input.cursor ?? 0
      const page = rows.slice(offset, offset + PAGE_SIZE)
      const hasMore = offset + PAGE_SIZE < rows.length
      const nextCursor = hasMore ? offset + PAGE_SIZE : null

      return wrapResponse(
        { rows: page, ...(nextCursor !== null && { nextCursor }) },
        { totalMatching: rows.length, pageSize: PAGE_SIZE, offset, hasMore },
      )
    },
  })

  const update = tool({
    name: 'db_update',
    description: 'Update rows matching a WHERE condition. Sets specified columns to new values. Affects all matching rows.',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      where: z.record(z.string(), z.any()).describe('Filter conditions as {column: value}'),
      set: z.record(z.string(), z.any()).describe('Column-value pairs to update'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      const t = tables.get(input.table)
      if (!t) return wrapError('TABLE_NOT_FOUND', `Table "${input.table}" does not exist`)

      let affected = 0
      for (const row of t.rows) {
        const matches = Object.entries(input.where).every(([col, val]) => {
          if (Array.isArray(val)) return val.map(String).includes(String(row[col]))
          return String(row[col]) === String(val)
        })
        if (matches) {
          for (const [col, val] of Object.entries(input.set)) {
            if (t.columns.includes(col)) {
              row[col] = val as string | number | boolean | null
            }
          }
          affected++
        }
      }

      if (affected === 0) {
        return wrapResponse({ affectedRows: 0, warning: 'No rows matched the WHERE condition' })
      }
      return wrapResponse({ affectedRows: affected }, { totalRows: t.rows.length })
    },
  })

  const deleteRows = tool({
    name: 'db_delete',
    description: 'Delete rows matching a WHERE condition.',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
      where: z.record(z.string(), z.any()).describe('Filter conditions as {column: value}'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      const t = tables.get(input.table)
      if (!t) return wrapError('TABLE_NOT_FOUND', `Table "${input.table}" does not exist`)

      const before = t.rows.length
      t.rows = t.rows.filter(row => {
        return !Object.entries(input.where).every(([col, val]) => {
          if (Array.isArray(val)) return val.map(String).includes(String(row[col]))
          return String(row[col]) === String(val)
        })
      })
      const deleted = before - t.rows.length

      return wrapResponse({ deletedRows: deleted }, { remainingRows: t.rows.length })
    },
  })

  const describe = tool({
    name: 'db_describe',
    description: 'Get schema information about a table (columns and row count).',
    inputSchema: z.object({
      table: z.string().describe('Table name'),
    }),
    callback: (input) => {
      const rl = checkRateLimit()
      if (rl) return rl
      const t = tables.get(input.table)
      if (!t) return wrapError('TABLE_NOT_FOUND', `Table "${input.table}" does not exist`)
      return wrapResponse({ table: input.table, columns: t.columns, rowCount: t.rows.length })
    },
  })

  const listTables = tool({
    name: 'db_list_tables',
    description: 'List all tables in the database with their row counts.',
    inputSchema: z.object({}),
    callback: () => {
      const rl = checkRateLimit()
      if (rl) return rl
      const result = [...tables.entries()].map(([name, t]) => ({
        table: name,
        columns: t.columns,
        rowCount: t.rows.length,
      }))
      return wrapResponse(result)
    },
  })

  return {
    createTable,
    insert,
    select,
    update,
    delete: deleteRows,
    describe,
    listTables,
    tools: [createTable, insert, select, update, deleteRows, describe, listTables],
    /** Direct access for seeding data without going through the tool interface */
    seed: (table: string, columns: string[], rows: Row[]) => {
      tables.set(table, { columns, rows: [...rows] })
    },
    /** Direct access for scoring — read raw state */
    getRows: (table: string): Row[] => tables.get(table)?.rows ?? [],
  }
}
