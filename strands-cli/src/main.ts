#!/usr/bin/env node

import { main } from './cli/run.js'

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
