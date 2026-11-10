import type { Sandbox } from './base.js'
import { createDefaultSlot } from '../default-slot.js'

export const defaultSandbox = createDefaultSlot<Sandbox>(
  'No Sandbox configured. Pass a `sandbox` to the Agent to use sandbox features in this environment.'
)
