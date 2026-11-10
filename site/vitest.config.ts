import { getViteConfig } from 'astro/config'

export default getViteConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
  },
})
