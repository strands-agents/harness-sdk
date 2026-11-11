import { describe, it, expectTypeOf } from 'vitest'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { tool } from '../tool-factory.js'
import type { InvokableTool } from '../tool.js'

type User = { name: string; age: number }

declare const userSchema: StandardSchemaV1<unknown, User> & StandardJSONSchemaV1<unknown, User>

describe('standard-schema-tool type tests', () => {
  it('types the callback input as the schema output', () => {
    tool({
      name: 'user',
      inputSchema: userSchema,
      callback: (input) => {
        expectTypeOf(input).toEqualTypeOf<User>()
        return input.name
      },
    })
  })

  it('types invoke() by the schema output and the callback return', () => {
    const userTool = tool({
      name: 'user',
      inputSchema: userSchema,
      callback: (input) => ({ adult: input.age >= 18 }),
    })

    expectTypeOf(userTool).toEqualTypeOf<InvokableTool<User, { adult: boolean }>>()
    expectTypeOf(userTool.invoke).parameter(0).toEqualTypeOf<User>()
    expectTypeOf(userTool.invoke).returns.resolves.toEqualTypeOf<{ adult: boolean }>()
  })

  it('types invoke() by the final value of an async generator callback', () => {
    const counter = tool({
      name: 'counter',
      inputSchema: userSchema,
      callback: async function* (input) {
        yield input.age
        return input.name.length
      },
    })

    expectTypeOf(counter.invoke).returns.resolves.toEqualTypeOf<number>()
  })
})
