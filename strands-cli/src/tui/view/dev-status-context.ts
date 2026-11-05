import { createContext } from 'react'

import type { DevStatus } from '../../dev/status.js'

/** The `strands dev` reload state. Undefined outside dev mode. */
export const DevStatusContext = createContext<DevStatus | undefined>(undefined)
