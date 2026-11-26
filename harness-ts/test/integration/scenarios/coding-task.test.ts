import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'

import { checkInvariants, record } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

const CALC = `export function add(a, b) {
  return a - b
}
`

const CALC_TEST = `import assert from 'node:assert/strict'
import { test } from 'node:test'

import { add } from './calc.mjs'

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5)
})
`

const TURNS = [
  'Run `node --test` in the current directory and report whether the tests pass.',
  'Fix the bug in calc.mjs that makes the test fail. Do not change calc.test.mjs.',
  'Add an exported function `multiply(a, b)` to calc.mjs, and a test for it in a new file multiply.test.mjs.',
  'Run `node --test` again and report the result.',
]

describe('coding task', () => {
  const workDir = useWorkDir()

  it('fixes the bug and adds a tested function, leaving the original test untouched', async () => {
    writeFileSync('calc.mjs', CALC)
    writeFileSync('calc.test.mjs', CALC_TEST)
    const agent = await buildAgent()
    const recording = record(agent)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'coding-task.json')))

    for (const turn of TURNS) {
      await agent.invoke(`${TESTING} ${turn}`)
    }

    // Models tend to open with `read` on the directory, which fails, and then recover.
    checkInvariants(recording, agent, { allowedToolErrors: ['read'] })
    const tests = spawnSync('node', ['--test'], { cwd: workDir(), encoding: 'utf8' })
    expect(tests.status, tests.stdout).toBe(0)
    expect(Number(/^# pass (\d+)/m.exec(tests.stdout)?.[1])).toBeGreaterThanOrEqual(2)
    const multiply = spawnSync(
      'node',
      ['-e', "import('./calc.mjs').then((calc) => process.exit(calc.multiply(3, 4) === 12 ? 0 : 1))"],
      { cwd: workDir() }
    )
    expect(multiply.status).toBe(0)
    expect(readFileSync('calc.test.mjs', 'utf8')).toBe(CALC_TEST)
  })
})
