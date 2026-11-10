import { describe, it, expect, vi, afterEach } from 'vitest'
import { bash, BashTimeoutError, BashSessionError, type BashOutput } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { StateStore } from '../../../state-store.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { realpathSync } from 'fs'

// Skip tests on Windows (bash not available)
describe.skipIf(process.platform === 'win32')('bash tool', () => {
  // Helper to create fresh context
  const createFreshContext = (): { state: StateStore; context: ToolContext } => {
    const agent = createMockAgent()
    const context: ToolContext = {
      toolUse: {
        name: 'bash',
        toolUseId: 'test-id',
        input: {},
      },
      agent,
      invocationState: {},
      cancelSignal: agent.cancelSignal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
    return { state: agent.appState, context }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('input validation', () => {
    it('accepts valid execute command', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      expect(result).toHaveProperty('output')
      expect(result).toHaveProperty('error')
    })

    it('accepts valid restart command', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'restart' }, context)
      expect(result).toBe('Bash session restarted')
    })

    it('rejects invalid mode', async () => {
      const { context } = createFreshContext()
      // @ts-expect-error - Testing invalid input
      await expect(bash.invoke({ mode: 'invalid' }, context)).rejects.toThrow()
    })

    it('rejects execute without command', async () => {
      const { context } = createFreshContext()
      await expect(bash.invoke({ mode: 'execute' }, context)).rejects.toThrow()
    })

    it('accepts valid timeout configuration', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "fast"', timeout: 300 }, context)

      expect(result).toHaveProperty('output')
    })

    it('rejects negative timeout', async () => {
      const { context } = createFreshContext()
      await expect(bash.invoke({ mode: 'execute', command: 'echo test', timeout: -1 }, context)).rejects.toThrow()
    })
  })

  describe('session lifecycle', () => {
    it('creates session on first execute', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      expect(result).toHaveProperty('output')
      expect((result as BashOutput).output).toContain('test')
    })

    it('creates new session after restart', async () => {
      const { context } = createFreshContext()

      // Set variable
      await bash.invoke({ mode: 'execute', command: 'TEST_RESTART="exists"' }, context)

      // Restart
      const restartResult = await bash.invoke({ mode: 'restart' }, context)
      expect(restartResult).toBe('Bash session restarted')

      // Variable should be gone
      const afterRestart = await bash.invoke({ mode: 'execute', command: 'echo $TEST_RESTART' }, context)

      expect((afterRestart as BashOutput).output.trim()).not.toContain('exists')
    })

    it('restarts existing session when restart is called', async () => {
      const { context } = createFreshContext()

      // First create a session by executing a command
      await bash.invoke({ mode: 'execute', command: 'TEST_VAR="initial"' }, context)

      // Now restart the existing session
      const restartResult = await bash.invoke({ mode: 'restart' }, context)
      expect(restartResult).toBe('Bash session restarted')

      // Verify the variable is gone after restart
      const result = await bash.invoke({ mode: 'execute', command: 'echo "${TEST_VAR:-empty}"' }, context)
      expect((result as BashOutput).output.trim()).toBe('empty')
    })

    it('persists environment variables between calls', async () => {
      const { context } = createFreshContext()

      await bash.invoke({ mode: 'execute', command: 'MY_VAR="persistent_value"' }, context)
      const result = await bash.invoke({ mode: 'execute', command: 'echo $MY_VAR' }, context)

      expect((result as BashOutput).output.trim()).toBe('persistent_value')
    })

    it('persists working directory between calls', async () => {
      const { context } = createFreshContext()

      await bash.invoke({ mode: 'execute', command: 'cd /tmp' }, context)
      const result = await bash.invoke({ mode: 'execute', command: 'pwd' }, context)

      expect(realpathSync((result as BashOutput).output.trim())).toBe(realpathSync('/tmp'))
    })

    it('provides isolated sessions for different agents', async () => {
      const { context: context1 } = createFreshContext()
      const { context: context2 } = createFreshContext()

      // Set variable in first agent
      await bash.invoke({ mode: 'execute', command: 'AGENT_VAR="agent1"' }, context1)

      // Check it's not in second agent
      const result = await bash.invoke({ mode: 'execute', command: 'echo $AGENT_VAR' }, context2)

      expect((result as BashOutput).output.trim()).not.toContain('agent1')
    })

    it('handles session restart with no existing session gracefully', async () => {
      const { context } = createFreshContext()

      // Restart when no session exists
      const result = await bash.invoke({ mode: 'restart' }, context)
      expect(result).toBe('Bash session restarted')

      // Should still be able to execute commands
      const execResult = await bash.invoke({ mode: 'execute', command: 'echo "works"' }, context)
      expect((execResult as BashOutput).output.trim()).toBe('works')
    })
  })

  describe('command execution', () => {
    it('executes command and returns output', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "Hello World"' }, context)

      expect((result as BashOutput).output).toContain('Hello World')
      expect((result as BashOutput).error).toBe('')
    })

    it('returns empty stderr on success', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "success"' }, context)

      expect((result as BashOutput).error).toBe('')
    })

    it('captures stderr on command error', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'nonexistent_command_xyz' }, context)

      expect((result as BashOutput).error).toContain('not found')
    })
  })

  describe('timeout handling', () => {
    it('completes command before timeout', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "fast"', timeout: 5 }, context)

      expect((result as BashOutput).output).toContain('fast')
    })

    it('throws BashTimeoutError when command times out', async () => {
      const { context } = createFreshContext()

      await expect(bash.invoke({ mode: 'execute', command: 'sleep 10', timeout: 0.1 }, context)).rejects.toThrow(
        BashTimeoutError
      )
    })

    it('uses default timeout of 120 seconds', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      expect(result).toHaveProperty('output')
    })

    it('respects custom timeout for new session', async () => {
      const { context } = createFreshContext()

      // Create session with custom timeout
      const result = await bash.invoke({ mode: 'execute', command: 'echo "custom"', timeout: 10 }, context)

      expect((result as BashOutput).output).toContain('custom')
    })

    it('handles timeout during command with large output', async () => {
      const { context } = createFreshContext()

      // Command that generates output continuously
      await expect(
        bash.invoke({ mode: 'execute', command: 'while true; do echo "spam"; done', timeout: 0.1 }, context)
      ).rejects.toThrow(BashTimeoutError)
    })
  })

  describe('error handling', () => {
    it('requires context for bash operations', async () => {
      await expect(bash.invoke({ mode: 'execute', command: 'echo "test"' })).rejects.toThrow('Tool context is required')
    })

    it('validates command is required for execute mode', async () => {
      const { context } = createFreshContext()

      await expect(bash.invoke({ mode: 'execute' }, context)).rejects.toThrow(
        'command is required when mode is "execute"'
      )
    })

    it('validates command is required with undefined command', async () => {
      const { context } = createFreshContext()

      await expect(bash.invoke({ mode: 'execute', command: undefined }, context)).rejects.toThrow(
        'command is required when mode is "execute"'
      )
    })

    it('validates command is required with empty string', async () => {
      const { context } = createFreshContext()

      await expect(bash.invoke({ mode: 'execute', command: '' }, context)).rejects.toThrow(
        'command is required when mode is "execute"'
      )
    })

    it('handles command execution in a session without proper initialization', async () => {
      const { context } = createFreshContext()

      // Create a session first
      await bash.invoke({ mode: 'execute', command: 'echo "init"' }, context)

      // Then restart to clear it
      await bash.invoke({ mode: 'restart' }, context)

      // Try to execute another command - should work as it creates a new session
      const result = await bash.invoke({ mode: 'execute', command: 'echo "after restart"' }, context)

      expect((result as BashOutput).output).toContain('after restart')
    })

    it('creates new session when none exists', async () => {
      const { context } = createFreshContext()

      // First command should create a new session
      const result = await bash.invoke({ mode: 'execute', command: 'echo "first"' }, context)

      expect((result as BashOutput).output).toContain('first')
    })

    it('handles restart when no session exists', async () => {
      const { context } = createFreshContext()

      // Restart without existing session should not throw
      const result = await bash.invoke({ mode: 'restart' }, context)
      expect(result).toBe('Bash session restarted')
    })

    it('properly cleans up session on restart', async () => {
      const { context } = createFreshContext()

      // Create session with variable
      await bash.invoke({ mode: 'execute', command: 'CLEANUP_TEST="should_be_gone"' }, context)

      // Restart should clear the session
      await bash.invoke({ mode: 'restart' }, context)

      // Variable should not exist in new session
      const result = await bash.invoke({ mode: 'execute', command: 'echo "${CLEANUP_TEST:-empty}"' }, context)

      expect((result as BashOutput).output.trim()).toBe('empty')
    })

    it('handles multiple restarts in sequence', async () => {
      const { context } = createFreshContext()

      // Restart without existing session
      const result1 = await bash.invoke({ mode: 'restart' }, context)
      expect(result1).toBe('Bash session restarted')

      // Restart again
      const result2 = await bash.invoke({ mode: 'restart' }, context)
      expect(result2).toBe('Bash session restarted')

      // Should still be able to execute
      const execResult = await bash.invoke({ mode: 'execute', command: 'echo "still works"' }, context)
      expect((execResult as BashOutput).output).toContain('still works')
    })

    it('handles command with empty output gracefully', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'true' }, context)

      expect((result as BashOutput).output).toBe('')
      expect((result as BashOutput).error).toBe('')
    })

    it('handles command with only whitespace output', async () => {
      const { context } = createFreshContext()
      const result = await bash.invoke({ mode: 'execute', command: 'echo "   "' }, context)

      expect((result as BashOutput).output.trim()).toBe('')
    })

    it('handles very long command output', async () => {
      const { context } = createFreshContext()
      // Generate a long string
      const result = await bash.invoke(
        {
          mode: 'execute',
          command: 'for i in {1..100}; do echo "Line $i of output"; done',
        },
        context
      )

      expect((result as BashOutput).output).toContain('Line 1 of output')
      expect((result as BashOutput).output).toContain('Line 100 of output')
    })

    it('creates session with default timeout when not specified', async () => {
      const { context } = createFreshContext()

      // Execute without timeout parameter
      const result = await bash.invoke({ mode: 'execute', command: 'echo "default"' }, context)

      expect((result as BashOutput).output).toContain('default')
    })
  })

  describe('working directory', () => {
    it('starts in process.cwd()', async () => {
      const { context } = createFreshContext()
      const expectedCwd = realpathSync(process.cwd())

      const result = await bash.invoke({ mode: 'execute', command: 'pwd' }, context)

      expect(realpathSync((result as BashOutput).output)).toContain(expectedCwd)
    })
  })

  describe('tool properties', () => {
    it('has correct tool name', () => {
      expect(bash.name).toBe('bash')
    })

    it('has description', () => {
      expect(bash.description).toBeDefined()
      expect(bash.description.length).toBeGreaterThan(0)
    })

    it('has toolSpec', () => {
      expect(bash.toolSpec).toBeDefined()
      expect(bash.toolSpec.name).toBe('bash')
    })
  })

  describe('error classes', () => {
    it('BashTimeoutError has correct properties', () => {
      const error = new BashTimeoutError('timeout message')
      expect(error.name).toBe('BashTimeoutError')
      expect(error.message).toBe('timeout message')
      expect(error instanceof Error).toBe(true)
    })

    it('BashSessionError has correct properties', () => {
      const error = new BashSessionError('session error message')
      expect(error.name).toBe('BashSessionError')
      expect(error.message).toBe('session error message')
      expect(error instanceof Error).toBe(true)
    })
  })

  describe('module exports', () => {
    it('exports bash tool from index', () => {
      expect(bash).toBeDefined()
      expect(bash.name).toBe('bash')
    })

    it('exports error classes from index', () => {
      expect(BashTimeoutError).toBeDefined()
      expect(BashSessionError).toBeDefined()
    })
  })

  describe('bash session edge cases', () => {
    it('handles process close during command execution', async () => {
      const { context } = createFreshContext()

      // Use a command that will make the bash process exit - this should throw an error
      await expect(bash.invoke({ mode: 'execute', command: 'exit 0' }, context)).rejects.toThrow(BashSessionError)

      // Next command should work with a new session
      const newResult = await bash.invoke({ mode: 'execute', command: 'echo "new session"' }, context)
      expect((newResult as BashOutput).output).toContain('new session')
    })
  })

  describe('process cleanup', () => {
    it('cleans up on beforeExit event', async () => {
      const { context } = createFreshContext()

      // Create a session
      await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      // Simulate beforeExit event
      process.emit('beforeExit', 0)

      // Session should be cleaned up, next command creates new session
      const result = await bash.invoke({ mode: 'execute', command: 'echo "after exit"' }, context)
      expect((result as BashOutput).output).toContain('after exit')
    })

    it('cleans up on exit event', async () => {
      const { context } = createFreshContext()

      // Create a session
      await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      // Simulate exit event
      process.emit('exit', 0)

      // Session should be cleaned up
      const result = await bash.invoke({ mode: 'execute', command: 'echo "after exit"' }, context)
      expect((result as BashOutput).output).toContain('after exit')
    })

    it('cleans up on SIGINT', async () => {
      const { context } = createFreshContext()

      // Mock process.exit to prevent actual exit
      const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called')
      })

      // Create a session
      await bash.invoke({ mode: 'execute', command: 'echo "test"' }, context)

      // Simulate SIGINT
      try {
        process.emit('SIGINT')
      } catch {
        // Expected to throw due to our mock
      }

      expect(exitMock).toHaveBeenCalledWith(0)
      exitMock.mockRestore()
    })
  })
})
