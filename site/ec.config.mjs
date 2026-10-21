import { defineEcConfig } from 'astro-expressive-code'

export default defineEcConfig({
  themes: ['github-light', 'github-dark'],
  // Follow Starlight's data-theme attribute instead of the browser's prefers-color-scheme.
  themeCssSelector: (theme) => `[data-theme='${theme.type}']`,
  styleOverrides: {
    // Match the accent color from the site theme.
    frames: {
      shadowColor: 'transparent',
    },
  },
})
