import type { ReactElement } from 'react'
import { Box, useInput } from 'ink'

import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { Text, useTheme } from './theme.js'

export interface McpTrustRequest {
  workspace: string
  paths: readonly string[]
  resolve(trusted: boolean): void
}

/** Asks inside Ink: a readline prompt would drop the raw mode Ink's input relies on. */
export function McpTrustPrompt({ request }: { request: McpTrustRequest }): ReactElement {
  const { accent } = useTheme()
  useInput((character, key) => {
    const answer = character.toLowerCase()
    if (answer === 'y') request.resolve(true)
    else if (answer === 'n' || key.escape || key.return) request.resolve(false)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={accent}>
        Trust this project&apos;s MCP configuration?
      </Text>
      <Text dimColor>{sanitizeTerminalText(`Found in ${request.workspace}:`)}</Text>
      {request.paths.map((path) => (
        <Text key={path}>{sanitizeTerminalText(`  ${path}`)}</Text>
      ))}
      <Text dimColor>Trusting lets its MCP commands run.</Text>
      <Text> </Text>
      <Text dimColor>y trust · n / Enter skip</Text>
    </Box>
  )
}
