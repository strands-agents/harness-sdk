import { specTypeSchemas, type CallToolResult, type StandardSchemaV1Sync } from '@modelcontextprotocol/client'
import { z } from 'zod'

import type {
  McpCallToolWithTaskResult,
  McpGetTaskResult,
  McpInputRequiredResult,
  McpUpdateTaskResult,
} from './task-types.js'

const RESULT_META_SCHEMA = z.record(z.string(), z.unknown()).optional()
const ISO_TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true })
const DURATION_MS_SCHEMA = z.number().int().nonnegative()
const TASK_PAYLOAD_FIELDS = ['inputRequests', 'result', 'error'] as const
const ACKNOWLEDGEMENT_FIELDS = [
  'taskId',
  'status',
  'statusMessage',
  'createdAt',
  'lastUpdatedAt',
  'ttlMs',
  'pollIntervalMs',
  ...TASK_PAYLOAD_FIELDS,
] as const

function fromStandardSchema<TInput, TOutput>(
  schema: StandardSchemaV1Sync<TInput, TOutput>
): z.ZodType<TOutput, unknown> {
  return z.unknown().transform((value, context) => {
    const result = schema['~standard'].validate(value)
    if (result.issues !== undefined) {
      context.addIssue({
        code: 'custom',
        message: result.issues.map((issue) => issue.message).join('; ') || 'Invalid MCP protocol value',
      })
      return z.NEVER
    }
    return result.value
  })
}

function forbidFields<TSchema extends z.ZodObject>(schema: TSchema, fields: readonly string[]): TSchema {
  return schema.superRefine((value, context) => {
    for (const field of fields) {
      if (Object.hasOwn(value, field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `"${field}" is not valid for task status "${String(value.status)}"`,
        })
      }
    }
  })
}

const McpCallToolResultSchema = z
  .unknown()
  .refine(
    (value) => value !== null && typeof value === 'object' && 'content' in value && Array.isArray(value.content),
    'Modern tool results require a content array'
  )
  .pipe(fromStandardSchema(specTypeSchemas.CallToolResult))
const McpInputRequestsSchema = z.record(
  z.string(),
  z.union([
    fromStandardSchema(specTypeSchemas.CreateMessageRequest),
    fromStandardSchema(specTypeSchemas.ListRootsRequest),
    z.object({
      method: z.literal('elicitation/create'),
      params: z.union([
        fromStandardSchema(specTypeSchemas.ElicitRequestFormParams),
        // The modern URL request no longer includes the legacy elicitationId.
        z.object({
          mode: z.literal('url'),
          message: z.string(),
          url: z.url(),
          _meta: fromStandardSchema(specTypeSchemas.RequestMeta).optional(),
        }),
      ]),
    }),
  ])
)

/** Validates responses keyed by their pending input request. @internal */
export const McpInputResponsesSchema = z.record(
  z.string(),
  z.union([
    fromStandardSchema(specTypeSchemas.CreateMessageResultWithTools),
    fromStandardSchema(specTypeSchemas.ListRootsResult),
    fromStandardSchema(specTypeSchemas.ElicitResult),
  ])
)

const taskSchema = z
  .looseObject({
    taskId: z.string().min(1),
    statusMessage: z.string().optional(),
    createdAt: ISO_TIMESTAMP_SCHEMA,
    lastUpdatedAt: ISO_TIMESTAMP_SCHEMA,
    ttlMs: DURATION_MS_SCHEMA.nullable(),
    pollIntervalMs: DURATION_MS_SCHEMA.optional(),
    status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
    _meta: RESULT_META_SCHEMA,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.lastUpdatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['lastUpdatedAt'],
        message: '"lastUpdatedAt" must not precede "createdAt"',
      })
    }
  })

const taskStates = [
  forbidFields(taskSchema.safeExtend({ status: z.literal('working') }), TASK_PAYLOAD_FIELDS),
  forbidFields(
    taskSchema.safeExtend({
      status: z.literal('input_required'),
      inputRequests: McpInputRequestsSchema,
    }),
    ['result', 'error']
  ),
  forbidFields(
    taskSchema.safeExtend({
      status: z.literal('completed'),
      result: McpCallToolResultSchema,
    }),
    ['inputRequests', 'error']
  ),
  forbidFields(
    taskSchema.safeExtend({
      status: z.literal('failed'),
      error: z.looseObject({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }),
    }),
    ['inputRequests', 'result']
  ),
  forbidFields(taskSchema.safeExtend({ status: z.literal('cancelled') }), TASK_PAYLOAD_FIELDS),
] as const

const directCallToolResultSchema = z.looseObject({ resultType: z.literal('complete') }).transform((value, context) => {
  const parsed = McpCallToolResultSchema.safeParse(value)
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: parsed.error.message })
    return z.NEVER
  }
  const result = { ...parsed.data } as Record<string, unknown>
  delete result.resultType
  return result as CallToolResult
})

const inputRequiredCallToolResultSchema = z
  .looseObject({
    resultType: z.literal('input_required'),
    inputRequests: McpInputRequestsSchema.optional(),
    requestState: z.string().optional(),
    _meta: RESULT_META_SCHEMA,
  })
  .superRefine((value, context) => {
    if (Object.keys(value.inputRequests ?? {}).length === 0 && value.requestState === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Expected at least one of "inputRequests" or "requestState"',
      })
    }
  })

/** Validates task-aware tool results and removes the direct-result wire discriminator. @internal */
export const McpCallToolWithTaskResultSchema = z.union([
  directCallToolResultSchema,
  inputRequiredCallToolResultSchema,
  taskSchema.safeExtend({ resultType: z.literal('task') }),
]) as z.ZodType<McpCallToolWithTaskResult | McpInputRequiredResult>

/** Validates the complete state returned by tasks/get. @internal */
export const McpGetTaskResultSchema = z.union(
  taskStates.map((schema) => schema.safeExtend({ resultType: z.literal('complete') }))
) as z.ZodType<McpGetTaskResult>

/** Validates the empty acknowledgement shared by tasks/update and tasks/cancel. @internal */
export const McpTaskAcknowledgementSchema = z
  .looseObject({
    resultType: z.literal('complete'),
    _meta: RESULT_META_SCHEMA,
  })
  .superRefine((value, context) => {
    for (const field of ACKNOWLEDGEMENT_FIELDS) {
      if (Object.hasOwn(value, field)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `"${field}" is not valid in an empty task acknowledgement`,
        })
      }
    }
  }) as z.ZodType<McpUpdateTaskResult>

/** Normalizes notification state to the tasks/get result envelope. @internal */
export const McpTaskStatusNotificationSchema = z.union(taskStates).transform((params) => ({
  ...params,
  resultType: 'complete' as const,
})) as z.ZodType<McpGetTaskResult>
