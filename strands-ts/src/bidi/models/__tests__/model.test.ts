import { describe, expect, it } from 'vitest'

import { BidiModel, ConnectionTimeoutError, isAudioCapable, isRestartable } from '../model.js'
import { Model } from '../../../models/model.js'
import { ModelError } from '../../../errors.js'

import type { AudioConfig, BidiModelConfig } from '../configs.js'
import type { BidiModelStartOptions, Restartable } from '../model.js'
import type { BidiContentDelta, BidiMessage } from '../../types/content.js'
import type { BidiOutputEvent } from '../../types/events.js'

class TestBidiModel extends BidiModel {
  private _config: BidiModelConfig = { modelId: 'test-model' }

  updateConfig(modelConfig: BidiModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): BidiModelConfig {
    return this._config
  }

  async start(_options?: BidiModelStartOptions): Promise<void> {}

  async stop(): Promise<void> {}

  async *receive(): AsyncIterable<BidiOutputEvent> {}

  async send(_content: BidiMessage | BidiContentDelta): Promise<void> {}
}

class AudioBidiModel extends TestBidiModel {
  getAudioConfig(): AudioConfig {
    return {
      input: { sampleRate: 16000, channels: 1, format: 'pcm' },
      output: { sampleRate: 24000, channels: 1, format: 'pcm' },
    }
  }
}

class RestartableBidiModel extends TestBidiModel implements Restartable {
  async restart(_options?: BidiModelStartOptions): Promise<void> {}
}

describe('BidiModel', () => {
  describe('inheritance', () => {
    it('is a Model', () => {
      expect(new TestBidiModel()).toBeInstanceOf(Model)
    })
  })

  describe('stream', () => {
    it('throws because bidirectional models use their persistent streaming API', () => {
      expect(() => new TestBidiModel().stream()).toThrow(/regular streaming/)
    })
  })

  describe('getConnectionConfig', () => {
    it('returns the declared connection config, or an empty config when unspecified', () => {
      const model = new TestBidiModel()
      expect(model.getConnectionConfig()).toEqual({})

      model.updateConfig({ connection: { restartAfterMs: 420, autoRestart: false } })
      expect(model.getConnectionConfig()).toEqual({ restartAfterMs: 420, autoRestart: false })
    })
  })
})

describe('isAudioCapable', () => {
  it('identifies audio models', () => {
    expect(isAudioCapable(new AudioBidiModel())).toBe(true)
    expect(isAudioCapable(new TestBidiModel())).toBe(false)
    expect(isAudioCapable(undefined)).toBe(false)
  })
})

describe('isRestartable', () => {
  it('identifies models that can restart their connection', () => {
    expect(isRestartable(new RestartableBidiModel())).toBe(true)
    expect(isRestartable(new TestBidiModel())).toBe(false)
    expect(isRestartable(undefined)).toBe(false)
  })
})

describe('ConnectionTimeoutError', () => {
  it('carries the provider restart options and the model error name', () => {
    const cause = new Error('socket closed')
    const error = new ConnectionTimeoutError('connection timed out', { promptName: 'p1' }, { cause })

    expect(error).toBeInstanceOf(ModelError)
    expect(error.name).toBe('ConnectionTimeoutError')
    expect(error.message).toBe('connection timed out')
    expect(error.restartConfig).toEqual({ promptName: 'p1' })
    expect(error.cause).toBe(cause)
  })

  it('defaults the restart config to an empty bag', () => {
    expect(new ConnectionTimeoutError('connection timed out').restartConfig).toEqual({})
  })
})
