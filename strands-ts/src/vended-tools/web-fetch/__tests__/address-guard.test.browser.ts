import { describe, it, expect } from 'vitest'
import { isPublicHost } from '../address-guard.js'

describe('isPublicHost', () => {
  it('rejects in a runtime without the Node.js modules it needs', async () => {
    await expect(isPublicHost('example.com')).rejects.toThrow('host addresses can only be checked on Node.js')
  })
})
