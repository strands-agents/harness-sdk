import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The CLI reads and migrates state under the home directory, so unit tests never see the real one.
const home = mkdtempSync(join(tmpdir(), 'strands-cli-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
