import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECKPOINT_SCHEMA_VERSION, Checkpoint, type CheckpointData } from '../checkpoint.js'
import { CheckpointError } from '../../errors.js'
import { logger } from '../../logging/logger.js'

describe('Checkpoint serialization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips through toJSON/fromJSON', () => {
    const checkpoint = new Checkpoint({ position: 'afterModel', cycleIndex: 1 })

    const restored = Checkpoint.fromJSON(checkpoint.toJSON())

    expect(restored.toJSON()).toEqual({
      position: 'afterModel',
      cycleIndex: 1,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    })
  })

  it('always sets schemaVersion to the current constant', () => {
    const checkpoint = new Checkpoint({ position: 'afterTools' })
    expect(checkpoint.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)
  })

  it('defaults cycleIndex to 0', () => {
    const checkpoint = new Checkpoint({ position: 'afterModel' })
    expect(checkpoint.cycleIndex).toBe(0)
  })

  it('throws CheckpointError on schema version mismatch', () => {
    const data = { ...new Checkpoint({ position: 'afterModel' }).toJSON(), schemaVersion: '0.0' }
    expect(() => Checkpoint.fromJSON(data)).toThrow(CheckpointError)
    expect(() => Checkpoint.fromJSON(data)).toThrow(/not compatible with current version/)
  })

  it('throws CheckpointError when schemaVersion is missing', () => {
    const data: CheckpointData = { position: 'afterModel', cycleIndex: 0 }
    expect(() => Checkpoint.fromJSON(data)).toThrow(CheckpointError)
    expect(() => Checkpoint.fromJSON(data)).toThrow(/not compatible with current version/)
  })

  it('warns and ignores unknown fields', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const data = { ...new Checkpoint({ position: 'afterTools' }).toJSON(), unknownFutureField: 'something' }

    const restored = Checkpoint.fromJSON(data)

    expect(restored.position).toBe('afterTools')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknownFutureField'))
    // The unknown field is ignored, not carried onto the reconstructed checkpoint.
    expect(restored).not.toHaveProperty('unknownFutureField')
    expect(restored.toJSON()).not.toHaveProperty('unknownFutureField')
  })
})
