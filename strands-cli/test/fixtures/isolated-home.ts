import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// The CLI reads and migrates state under the home directory, so unit tests never see the real one.
const home = mkdtempSync(join(tmpdir(), 'strands-cli-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

afterAll(() => rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
